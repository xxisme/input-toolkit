/**
 * lib/features/cachehit.js —— 当前对话的缓存 token 占比
 *
 * 在输入栏显示「缓存 99.76%」这样一行：只看**当前会话正在用的那个模型**的记录。
 *
 * ── 这里踩过一个坑，写在代码里而不是只在提交记录里 ──
 * 第一版算的是**请求命中率**（命中缓存的请求数 ÷ 总请求数）。在本机它长期显示 100%，
 * 而 100% 在这个指标下不是巧合，是必然：缓存只在上下文足够长时才生效，一旦生效就
 * 几乎每轮都命中。一个必然饱和的数字不携带任何信息，该看到它就知道是指标选错了。
 *
 * 换成行业通用的**缓存 token 占比**（cached token fraction）后，数字随对话推进持续
 * 变化，天然到不了 100%（总有一部分 token 是本轮新增的）。本机实测从短对话的
 * 20% 一路升到长对话的 99.76%，这个梯度才有观察价值。
 *
 * 取数时机：宿主在 setStatus 时告知 sessionId，按会话分别取。
 * 不做全局轮询 —— 当前对话这个口径下，别的会话的记录没有意义。
 */

import { CACHEHIT_STATUS_ID } from "./ids.js";
import { fitTooltip, fitTooltipWithAction } from "../tooltip.js";

/** 多久重取一次。缓存是慢变量，分钟级足够。 */
const POLL_MS = 60_000;

/** 同一批记录的短时缓存：一次 paint 可能被多个会话触发，别重复打台账。 */
const FRESH_MS = 15_000;

const NO_DATA_TEXT = "命中 —";

/** sessionId -> { modelId, entries, fetchedAt, error } */
const cache = new Map();
let timer = null;
let gen = 0;

/**
 * 算缓存 token 占比。
 *
 * ── 这里踩过一个坑，值得记下来 ──
 * 第一版用的是「请求命中率」：命中缓存的请求数 ÷ 总请求数。这个指标在长对话里
 * **必然趋近 100%** —— 缓存本来只在上下文足够长时才生效，而一旦生效就几乎每轮都命中。
 * 那个数字会长期钉在 100%，不提供任何信息。看到它就该知道是指标选错了，不是数据错了。
 *
 * 行业通用的是**缓存 token 占比**（cached token fraction）：
 *
 *     Σ cache.readTokens ÷ (Σ cache.readTokens + Σ input.uncachedTokens)
 *
 * 来源：tianpan.co《Prompt Cache Hit Rate: The Production Metric Your Cost
 * Dashboard Is Missing》—— “The metric you want to track is the cached token
 * fraction: the ratio of cache-read tokens to total input tokens.”
 * Anthropic 的 cache_read_input_tokens、OpenAI 的 cached_tokens 都是这个口径。
 *
 * 换成它之后有两个好处：数字随对话推进持续变化（有信息量），
 * 且天然到不了 100%（总有一部分 token 是本轮新增的）。
 *
 * 字段对应关系：usage.cache.readTokens 对应 cache_read_input_tokens，
 * usage.input.uncachedTokens 对应本次真正新输入的部分。
 */
export function computeHitRate(entries) {
  let read = 0;
  let fresh = 0;
  let usable = 0;
  let bothPresent = 0;
  let fellBack = 0;
  for (const e of entries || []) {
    const rd = num(e?.usage?.cache?.readTokens);
    const un = missInputOf(e?.usage, rd);
    // 两条都拿不到才算这条记录没用。
    if (rd === null && un === null) continue;
    usable += 1;
    // **分母两半都必须在场**。只有 readTokens 而没有未命中量时，
    // 分子有值、分母恒为 0 → rate === 1 → 封顶显示「命中 99.99%」。
    // 那正是当初换掉「请求命中率」要避开的“必然饱和的数”，换个原因又回来了。
    // 反过来也一样：只有未命中量而没有 readTokens，rate 恒为 0，
    // 显示「命中 0.00%」同样是在编造。
    if (rd === null || un === null) continue;
    bothPresent += 1;
    if (!isExplicitMiss(e?.usage)) fellBack += 1;
    read += rd;
    fresh += un;
  }
  const total = read + fresh;
  return {
    read,
    fresh,
    total,
    samples: usable,
    /** 真正进了分子分母的条数。与 samples 分开是因为它决定数字可不可信。 */
    samplesUsed: bothPresent,
    /** 里有几条的未命中量是兜底推出来的（不是 provider 显式给的）。 */
    samplesFallback: fellBack,
    /** 没有任何可用记录时为 null —— 0 和“没数据”必须能区分。 */
    rate: bothPresent > 0 && total > 0 ? read / total : null,
  };
}

/**
 * 未命中缓存的输入 token 数。
 *
 * 三级兼底，**拿不到就 null，绝不当作 0**：
 *   1. `input.uncachedTokens` —— provider 显式给的，首选
 *   2. `cache.missTokens` —— 但实测恒为 0，**必须 > 0 才采信**。
 *      采信 0 会把命中率算成 100%（分子有值、分母为 0）
 *   3. `input.totalTokens` —— 本机实测 uncachedTokens 与它恒等，
 *      所以拿它兼底不改变口径，只是把原本会被丢掉的记录捡回来
 *
 * 第 3 条是借鉴来的：另一个会话分析应用也这么做，它把“兼底来的”单独记一个标志。
 *
 * ── 第 3 级为什么还需要护栏 ──
 * 本机两家 provider 的 uncachedTokens 与 totalTokens 恒等，所以现在采信它是安全的。
 * 但这个恒等是**当前实现的巧合，不是契约**。如果哪天某个 provider 把
 * totalTokens 改成“含缓存的总输入”，未命中量就会被灌成整个输入 → 分母虚高 →
 * 命中率被系统性低估，而且**完全静默**。
 *
 * 护栏：miss 与 read 是同一批 token 的两个互斥部分，量级应当相近（同一个模型、
 * 同一轮里，命中与未命中不会差出一个数量级）。差到 10 倍以上就说明这两个字段
 * 不在同一个口径里，采信只会造出一个假数字 —— 宁可丢掉这条记录。
 */
function missInputOf(usage, readTokens) {
  const u = usage || {};
  const uncached = num(u.input?.uncachedTokens);
  if (uncached !== null) return uncached;
  const miss = num(u.cache?.missTokens);
  if (miss !== null && miss > 0) return miss;
  const total = num(u.input?.totalTokens);
  if (total === null) return null;
  // 口径一致性校验：命中量大而“未命中”小两个数量级 → 不在同一个口径里。
  if (readTokens != null && readTokens > 0 && total < readTokens / 10) return null;
  return total;
}

/** 未命中量是不是 provider 显式给的（而不是兼底推出来的）。 */
function isExplicitMiss(usage) {
  const u = usage || {};
  if (num(u.input?.uncachedTokens) !== null) return true;
  const miss = num(u.cache?.missTokens);
  return miss !== null && miss > 0;
}

/** 取数：只接受有限数字。null / NaN / 负数一律当作没有。 */
function num(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * 正文：`命中 99.90%`。
 *
 * **向下截断，不用四舍五入。** 原因很实在：真实值只要 >= 99.95%，
 * toFixed(2) 就会输出 100.00% —— 而缓存占比高恰恰是常态（长对话里几乎每轮都命中）。
 * 于是“很多轮都命中”这个事实被渲染成了“每次都命中”，一次近似误差造成了
 * 实质性的误述。这不是精度问题，是显示误导。
 *
 * **固定两位，不用 toFixed 之外的方式。** toFixed 天然保留末尾的 0
 * （99.9 会输出 "99.90"），不用担心。截断的代价是真实 99.999% 显示成 99.99%，
 * 换来的是“只要还有新增 token，就永远不会显示 100%”——那正是这个指标该守住的线。
 */
export function renderText(stats) {
  if (!stats || stats.rate == null) return NO_DATA_TEXT;
  return `命中 ${floor2(stats.rate * 100)}%`;
}

/**
 * 向下截断到两位小数，并封顶在 99.99。
 *
 * 为什么要封顶：rate 恰为 1 时（read 有、fresh 为 0）截断仍会得到 100.00。
 * 真实数据里几乎不会这样（每轮总有新增 token），但真出现了也不能显示 100%——
 * 那个数是用户反复质疑过的，而且它不携带信息：只要还有新增 token，就永远不是 100。
 */
function floor2(v) {
  const t = Math.trunc(v * 100) / 100;
  return (t >= 100 ? 99.99 : t).toFixed(2);
}

/**
 * tooltip：只报事实，不下结论。
 *
 * 为什么不下结论：缓存为什么低，插件判不准 —— 可能是模型不支持、可能是上下文太短、
 * 也可能是 provider 那边的策略变了。猜错一句比不说更糟。
 *
 * 这里报的是 token 构成，不是请求数 —— 与正文同口径。
 */
/**
 * tooltip：**不报数字**，只说这是什么。
 *
 * 为什么只有一行、且不带百分比：
 *   1. tooltip 在输入栏上方弹出，宽度有限。早先堆了五行，直接撑出容器、文字被裁掉。
 *   2. 百分比正文已经显示了（`命中 99.90%`），再报一遍是纯冗余。
 *
 * 所以它只回答“这是什么”，不回答“是多少”。数据要看正文。
 */
export function buildTooltip(stats, modelId, sessionId) {
  const LABEL = "当前对话选用模型的缓存命中率";
  if (!stats) return fitTooltip(`${LABEL}：正在取数…`);
  // 错误串来自宿主，长度不可控（实测带权限说明时能到 52 字）。
  // 标签那截固定 14 字，剩下 10 字给原因——不够就省略，标签一定保住。
  if (stats.error) return fitTooltipWithAction(LABEL, stats.error);  if (stats.rate == null) return fitTooltip(`${LABEL}：暂无可统计的数据`);
  return LABEL;
}

/**
 * 取当前会话的模型 id。
 *
 * 取 A（当前会话正在用的模型）而不是设置里的默认模型：默认模型是"下次要用"的，
 * 对不上这段对话实际发生了什么。台账记录自带 modelId，按会话过滤后取最近一条即可。
 *
 * ── 这里踩过一个坑，而且它是静默的 ──
 * 原实现是 `entries[entries.length - 1]`，也就是「数组最后一条 = 最新」。
 * 那个前提**不成立**：实测宿主对不同会话返回的顺序**不一致** ——
 * 同一时刻四个会话里，两个升序（末条最新）、两个降序（首条最新）。
 * 于是降序的那些会话会取到**最老那条**的模型 id，接着按它过滤，
 * 一个「从 MiniMax 切到 DeepSeek」的会话会显示 MiniMax 时期那段历史的命中率。
 *
 * 危险的地方在于它看起来完全合理：数字稳定、缓慢变化，没有任何异常信号，
 * 用户不会怀疑一个「看着没问题的数」。跨会话对比更明显——
 * 同一时刻不同会话显示不同模型的命中率，而两边都自称「当前对话」。
 *
 * 所以改成**按时间戳取最新**，不依赖返回顺序。这是唯一稳的做法：
 * 顺序是宿主的行为、可能变、也没有任何契约保证。
 */
async function currentModelFor(bus, sessionId) {
  try {
    // limit 取 200：取不满说明这个对话本来就没那么多轮，取满了就是本次会话的全部记录。
    // 早先卡在 20，结果只看到缓存刚起步的那一段（实测 74.97% vs 全量 99.04%）。
    // 200 约等于两三次长对话的规模；再多就变成“历史命中率”而不是“当前对话”的口径了。
    const res = await bus.request("usage:list", { sessionId, limit: 200 });
    const entries = Array.isArray(res?.entries) ? res.entries : [];
    let modelId = null;
    let newest = -Infinity;
    for (const e of entries) {
      const mid = e?.model?.modelId;
      if (typeof mid !== "string" || !mid) continue;
      // 时间戳坏掉就当最早处理，不能让它顶掉一个有效的时间。
      const t = Date.parse(e?.startedAt);
      const at = Number.isFinite(t) ? t : -Infinity;
      if (at > newest) { newest = at; modelId = mid; }
    }
    return { modelId, entries };
  } catch (err) {
    return { modelId: null, entries: [], error: String(err?.message || err) };
  }
}

async function fetchFor(ctx, sessionId) {
  const hit = cache.get(sessionId);
  // 短时缓存：一次 paint 可能连着触发多个会话，重复打台账没意义。
  if (hit && !hit.error && Date.now() - hit.fetchedAt < FRESH_MS) return hit;

  const { modelId, entries, error } = await currentModelFor(ctx.sdk.bus, sessionId);
  const next = {
    modelId,
    // 只留当前模型的记录：口径就是"当前对话当前模型"，混进别的模型会算错分母。
    entries: modelId ? entries.filter((e) => e?.model?.modelId === modelId) : [],
    fetchedAt: Date.now(),
    error: error || null,
  };
  cache.set(sessionId, next);
  return next;
}

function statsFor(entry) {
  if (!entry) return null;
  if (entry.error) return { error: entry.error };
  return computeHitRate(entry.entries);
}

export const cachehit = {
  id: "cachehit",
  title: "缓存命中率",
  blurb: "在输入栏显示当前对话的缓存命中率",
  statusId: CACHEHIT_STATUS_ID,
  defaultText: NO_DATA_TEXT,
  defaultTooltip: "当前对话选用模型的缓存命中率",
  toolName: "input_toolkit_set",
  args: { action: "refresh", featureId: "cachehit" },

  isEnabled: (values) => values?.features?.cachehit !== false,

  /** 配置变了（开关）就用已有数据重算，不重新取数 —— 台账数据没过期。 */
  onConfigChange(ctx) {
    return paint(ctx);
  },

  async describe(ctx) {
    const ids = ctx?.status?.sessionIds?.() || [];
    return {
      kind: "cachehit",
      // 勾选型区块在这里不需要：这个功能没有"选哪几项"，只有开关。
      blocks: [],
      sessions: ids.length,
    };
  },

  start(ctx) {
    gen += 1;
    const myGen = gen;
    ctx.log("info", `已启动，跟踪 ${ctx.status.sessionIds().length} 个会话`);

    const tick = async () => {
      if (myGen !== gen) return;
      await paint(ctx);
      if (myGen !== gen) return;
      timer = setTimeout(tick, POLL_MS);
      timer.unref?.();
    };
    timer = setTimeout(tick, 1500);
    timer.unref?.();
  },

  stop() {
    gen += 1;
    if (timer) clearTimeout(timer);
    timer = null;
    cache.clear();
  },
};

async function paint(ctx) {
  if (ctx.isEnabled && !ctx.isEnabled()) return 0;
  const ids = ctx.status.sessionIds();
  if (!ids.length) return 0;

  // 并发取各会话的数据，但结果必须**按会话分别填**。
  // 写成一个全局值会让所有会话显示同一个数 —— 那就不是"当前对话"了。
  //
  // 世代号必须在 await 之前取：那样才能拦住“取数期间发生重载”这个窗口。
  // 写在 await 之后就只能拦住取完之后才重载的情况，而那不是危险的那个。
  const myGen = gen;
  const results = await Promise.all(ids.map((id) => fetchFor(ctx, id)));
  if (myGen !== gen) return 0;
  for (let i = 0; i < ids.length; i += 1) {
    const stats = statsFor(results[i]);
    // 兼底条数要出声。分母里有几条不是 provider 显式给的，影响这个数字能不能信。
    // 不写日志的话它就是一个算了没人看的字段 —— 兼底一旦开始产出假数字，
    // 没人知道发生过。日志是这件事唯一的出口。
    if (stats?.samplesFallback > 0) {
      ctx.log(
        "info",
        `缓存命中率：${stats.samplesFallback}/${stats.samplesUsed} 条的未命中量来自兼底` +
        `（provider 未显式上报，用输入总量推的）`,
      );
    }
    // setStatusFor 只填值不重画；全部填完再统一画一次。
    // 逐个会话各画一次的话，11 个会话就是 11 次全量 paint 并发踩，
    // 真实表现是状态行一条也铺不上（日志里刷「缺 11 条」）。
    ctx.setStatusFor(ids[i], {
      text: renderText(stats),
      tooltip: buildTooltip(stats, results[i]?.modelId, ids[i]),
    });
  }
  if (myGen !== gen) return 0;
  return ctx.repaintAll();
}

export const CACHEHIT_ACTIONS = {
  async refresh(ctx) {
    // 手动刷新要绕过短时缓存，否则点了看到的还是旧数。
    for (const key of cache.keys()) cache.delete(key);
    await paint(ctx);
    const ids = ctx.status.sessionIds();
    const first = statsFor(cache.get(ids[0]));
    return first?.rate == null ? "无缓存记录" : `命中 ${floor2(first.rate * 100)}%`;
  },
};
