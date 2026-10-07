/**
 * lib/features/speed.js —— 本轮 token 速度
 *
 * 在输入栏显示「本轮 108 tok/s」这样一行。
 *
 * ── 这个指标为什么长这样，以及哪些路已经走死 ──
 *
 * **走死的第一条：拿宿主的耗时直接除。**
 * usage 台账里每条记录都有 `durationMs` 和 `startedAt`/`endedAt` 两组时间。
 * 实测 9631 条活库记录：`durationMs` 为 0 的占 75.2%，还有 `durationMs=1`
 * 而输出 5988 token 的荒谬样本（直除得 598 万 tok/s）。改用
 * `endedAt - startedAt` 也一样 —— 对话回复（`session/reply`）的这两个字段
 * **是同一个时间戳**，生成结束后一次性落盘、两个字段一起盖章，分母恒为 0。
 * 本机 380 轮里只有 233 轮（61%）能测出耗时，其余连分母都没有。
 *
 * **走死的第二条：按屏幕上的字符数折算 token。**
 * UIA 确实能读到聊天区文字（实测 160 个 Text 元素，单次读取 41ms），
 * 但账本记的是模型生成的**全部**内容，含工具调用参数、文件路径、脚本 ——
 * 这些都不上屏。实测 292 组配对：字符/token 系数中位 0.13（正常中英混排约
 * 1.5~3），误差中位 -92%，误差在 20% 以内的只有 9/293 条，系数本身在
 * 0.13~2.29 之间飘（18 倍）。用字符折算出来的速度会骗人。
 *
 * **所以这里走第三条：token 数取账本（真的），耗时自己按记录时间戳量（也是真的）。**
 * 不做任何字符折算，误差只剩「轮次切分得准不准」这一项。
 *
 * ── 这个数字的语义，必须说清楚 ──
 * 一轮不是一次生成。中间夹着工具执行：实测轮内相邻记录间隔中位 2.8s、
 * p90 13.1s、p95 20.4s。反推下来**工具时间占轮次耗时中位 37%**。
 *
 * 所以这个数是「本轮平均速度」，分母含工具执行时间 —— 它衡量的是
 * 「从你按下回车到这一轮出完，实际有多快」，不是模型的纯生成吞吐。
 * 同一个模型同一段输出，调 5 次工具和调 1 次，显示出来的数能差 3 倍。
 * 这是口径本身的性质，不是 bug，所以 tooltip 里写明了，不藏着。
 *
 * 轮末才更新：生成过程中这一轮的 token 数还没全部入账。
 */

/**
 * ── 计时从哪来：宿主事件，不是猜 ──
 * 宿主提供 `turn_start` / `turn_end`，**轮次边界是精确的**。本机实测这四个事件
 * v2 App 都能订阅（SDK 副本里没写它们，但宿主版本比副本新）：
 *   turn_start  {type, agentId}
 *   turn_end    {type, message, toolResults, agentId}
 *   llm_usage   {type, entry}    ← entry.attribution.sessionId
 *   message_start / message_end {type, message, agentId}
 *
 * 所以「这一轮从哪到哪」直接掐表，**不用等、不用猜、不用轮询**。
 *
 * ── 为什么一开始没用事件 ──
 * 最初只查了 SDK 的 TypeScript 定义，里面没有这几个事件类型，就下了“实时不可行”的
 * 结论。那个结论是错的：类型定义只是契约，宿主实现可以有更多。
 * 教训写在这里，因为“查了定义就当全部事实”这种错，静态检查永远不会提醒你。
 *
 * ── token 数仍然取台账 ──
 * 事件里的 usage 是**单次调用**的，而一轮可能包含多次调用（工具往返）。
 * 事件边界精确、台账 token 精确，各取所长。
 */

import { SPEED_STATUS_ID } from "./ids.js";
import { fitTooltip, fitTooltipWithAction } from "../tooltip.js";

/**
 * 相邻记录间隔小于这个值，就认为还在同一轮里。
 *
 * 依据（实测本会话 925 个轮内间隔）：中位 2.8s、p75 5.3s、p90 13.1s、p95 20.4s。
 * 取 30s 是为了不把工具执行误判成轮次结束 —— 切错的后果是这一轮显示不出来。
 * 代价是用户在 30s 内紧接着追问时，两轮会被并成一轮，速度取的是两轮平均。
 * 两种错法里，显示不出来比显示成平均值安全：前者用户看得见，后者用户看不出来。
 */
const ROUND_GAP_MS = 30_000;

/**
 * 一轮少于这个 token 数就不显示。
 *
 * 分母是这一轮的总耗时，token 太少时几毫秒的时间差就能让结果翻倍。
 * 宿主给的 `output.totalTokens` 是 provider 侧结算的真实值，不做估算。
 */
const MIN_TOKENS = 200;

/** 耗时短到这个程度，毫秒级的时间戳误差就能左右结果。 */
const MIN_SPAN_MS = 500;

/**
 * 轮询间隔。事件驱动下它只负责**兼底路径**的刷新。
 *
 * 早先是 8s —— 那时“本轮算完了没”只能靠轮询台账 + 等 20 秒超时来判，所以得勤。
 * 现在 `turn_end` 事件直接给答案，轮询只剩兼底职责，放宽到 30s：
 * 少一次台账往返，而兼底慢一点也不影响主路径。
 */
const POLL_MS = 30_000;

/** 短时缓存：一次 paint 可能连着触发多个会话。 */
const FRESH_MS = 4_000;

const NO_DATA_TEXT = "—";

/**
 * 每个会话上一次算出来的有效值。
 *
 * 为什么要留着：算一轮的速度必须等它跑完（见 SETTLE_MS），而新一轮一开始，
 * 最新的那一轮就变成“半截的”、不能用了 —— 于是屏幕上会掉出一个占位符。
 * 一个输入栏里来回闪的破折号比数字本身更难看，而且看着像坏了。
 *
 * 所以：**宁可显示旧值，也不显示空。** 旧值至少是真的某一轮的数字。
 * 代价是它会“过期”—— tooltip 里说明它是哪一轮，别让用户误以为是当前这轮。
 */
const lastGood = new Map();
/** sessionId -> { entries, fetchedAt, error } */
const cache = new Map();
let timer = null;
let gen = 0;

/**
 * 算出该显示什么，并把有效值记下来供下次回填。
 *
 * 优先级：本轮算得出来 → 用它；算不出来（还在跑 / 数据不够）→ 用上次的有效值；
 * 连有效值都没有（首次使用）→ 才显示占位符。
 */
export function displayFor(sessionId, entries, error) {
  // 取数失败**不能直接抹成空白**。
  //
  // 早先这里是 `if (error) return { error }`，它排在所有降级逻辑前面，
  // 于是主机/网络抖一下，整行就退化成 `—` —— 连 lastGood 都不看一眼。
  // 这与本文件开头写死的原则（宁可显示旧值，也不显示空）直接矛盾：
  // 旧值至少是真的某一轮的数字，而 `—` 是“这一刻什么都没有”，
  // 而且用户分不清是“取不到数”还是“真没数据”。
  //
  // 所以：先拿旧值兼底，并把这次失败暴露在 tooltip 上（stale 标记）。
  if (error) {
    const prev = lastGood.get(sessionId);
    if (prev) return { ...prev, stale: true };
    return { error };
  }
  // 事件侧结果优先：它就是“刚刚结束的那一轮”，比账本启发式更准也更新鲜，
  // 而且不需要等“20 秒没动静”那种猜出来的结束判定。
  //
  // 但**必须有保质期**。lastEventResult 是在 turn_end 时算好就不再变的，
  // 而这条分支一旦命中就直接 return，账本路径永远轮不到 ——
  // 也就是说：跑完一轮后哪怕一小时不碰这个会话（期间可能换过模型），
  // 输入栏仍然显示那个旧数，tooltip 还说“本轮平均速度”。
  //
  // 这正是本文件那套 stale 机制要拦的事，而事件路径把它绕过去了。
  // 超过保质期就降级到账本路径，让它走正常的 stale 标记。
  const ev = lastEventResult;
  const evFresh = ev && ev.tps != null
    && ev.fromEvent && ev.sessionId
    && ev.sessionId === sessionId
    && (Date.now() - (ev.at || 0)) <= EVENT_RESULT_TTL_MS;
  if (evFresh) {
    lastGood.set(sessionId, ev);
    return ev;
  }
  const fresh = settledSpeed(entries);
  if (fresh.tps != null) {
    lastGood.set(sessionId, fresh);
    return fresh;
  }
  const prev = lastGood.get(sessionId);
  // 保留旧值，但标出它已经过期 —— tooltip 要能让用户知道这不是当前这轮。
  if (prev) return { ...prev, stale: true };
  return fresh;
}

export function resetDisplayState() {
  lastGood.clear();
}

/**
 * 丢掉某个会话的缓存与旧值。会话关闭/归档时调。
 *
 * 为什么必需：`lastGood` 和 `cache` 都是按 sessionId 存的 Map，而它们是
 * speed **自己**的（不是 status host 那个 __perSession），所以宿主的会话清理
 * 钩子扫不到。不清的后果有两个：
 *   1. 每开一个会话就永久多留一条，跑久了只增不减
 *   2. 会话 id 若被复用，新会话会先拿到远古那一轮的值，
 *      tooltip 还标着“沿用更早一轮”，看起来像刚测过
 */
export function dropSession(sessionId) {
  if (!sessionId) return;
  lastGood.delete(sessionId);
  cache.delete(sessionId);
}
/** 只认有限非负数。null / NaN / 负数一律当作没有。 */
function num(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

// ─────────────────────────────────────────────────────────────
// 事件驱动的计时层
//
// 这一层只管「这一轮从哪到哪」，token 数仍然去台账取。
// 两者分工明确：事件的边界精确，台账的 token 精确。
//
// ── 为什么这里是单槽（没有按 agentId 分槽）──
// 审查时提过一个担心：子 agent 调用会发自己的 turn_start，把父轮的
// 起始时刻与 token 计数清零，父轮测量整个丢失。
//
// 实测否掉了（真机注入探针读宿主日志）：
//   连续两次调起子 agent（agent-mpjw5qw3、agent-mpjvh9g5），
//   订阅端收到了 llm_usage（含子 agent 的），
//   但 turn_start / turn_end **均为 0 条**。订阅本身是通的
//   （同期确实收到了 llm_usage），所以不是订阅失败。
//   → 子 agent 轮次不发轮次事件，只发用量事件，父轮槽位不会被清零。
//
// 那子 agent 的 token 要不要计入？**要计，而且这是对的。**
// 分母是 turn_start→turn_end 的墙钟时间，而子 agent 的执行时间本来就在
// 这段时间里。分子分母都跨整个轮次（含工具与子任务），口径自洽。
// 不计入反而会让分子偏小、分母照旧，算出一个偏低的速度。
//
// 这条结论是实测得来的，不是推断。以后若宿主改了子 agent 的事件行为，
// 重新验一次再决定要不要分槽 —— 别凭想象加复杂度。

/** 当前轮次的起始时刻。null = 没在跑。 */
let turnStartAt = null;
/**
 * 最近一次拿到的会话 id。
 * turn_start / turn_end 事件本身**不带 sessionId**（实测只有 agentId），
 * 而状态行是按会话显示的 —— 所以必须从 llm_usage 事件里取（它带 attribution.sessionId）。
 */
let lastSessionId = null;
/** 本轮已知的 token 数。turn_end 时用来兜底（台账还没写入的场景）。 */
let turnTokens = 0;
/** 事件结果的保质期。超过就不再直接采信，降级到账本路径。 */
const EVENT_RESULT_TTL_MS = 2 * 60_000;

/** 最近一次算出的结果：{ tps, tokens, spanMs, sessionId, at } 或 null */
let lastEventResult = null;

/**
 * turn_start：一轮开始。
 * 宿主不给 sessionId，只能用最近一次 llm_usage 看到的那个。
 * 风险是用户在轮次中途切会话 —— 但那样这一轮的统计本身就已经跨会话了，
 * 归到哪个都不完全对，宁可取多数时间属于的那个。
 */
export function noteTurnStart() {
  turnStartAt = Date.now();
  turnTokens = 0;
  // 手里那个数已经是**上一轮**的了，必须标出来。
  //
  // 不标的话：新一轮一开始，displayFor 立刻就把旧值当成新鲜的返回
  //（因为它不 null），tooltip 会说“本轮平均速度”——而它其实是上一轮的。
  // 账本路径靠 settledSpeed 自己算不出来时自然降级，但事件路径是直接命中，
  // 绕过了那个降级。这条标记就是补上它。
  if (lastEventResult) lastEventResult = { ...lastEventResult, running: true };
}

/** llm_usage：这是唯一带 sessionId 的事件。 */
export function noteUsageEvent(entry) {
  const sid = entry?.attribution?.sessionId;
  if (typeof sid === "string" && sid) lastSessionId = sid;
  const out = num(entry?.usage?.output?.totalTokens);
  if (out != null && turnStartAt != null) turnTokens += out;
}

/**
 * turn_end：一轮结束，此刻就能算出速度。
 *
 * 为什么不用等：早先靠“20 秒没新记录就算结束”，那是我拿轮内间隔的 p95 硬凑的。
 * 有精确边界就不要猜。
 */
export function noteTurnEnd() {
  const started = turnStartAt;
  turnStartAt = null;
  if (started == null) return null;
  const spanMs = Date.now() - started;
  const tps = turnTokens / (spanMs / 1000);

  // 极短的轮次（用户误触、切窗口）或荒谬值 → 不产出。
  //
  // 但不能就这么 return：上一轮那个数还挂着 running 标记，而这一轮已经结束了
  //（只是算不出数）。不处理的话 tooltip 会永久停在“上一轮的平均速度”，
  // 哪怕什么都没在跑。改成“更早一轮”才对。
  const usable = spanMs >= MIN_SPAN_MS
    && turnTokens >= MIN_TOKENS
    && tps >= 1
    && tps <= 2000;
  if (!usable) {
    if (lastEventResult) lastEventResult = { ...lastEventResult, running: false, stale: true };
    return null;
  }
  lastEventResult = {
    tps, tokens: turnTokens, spanMs, calls: 0, model: null, reason: null,
    sessionId: lastSessionId, fromEvent: true, at: Date.now(),
  };
  return lastEventResult;
}

/** 取事件侧最近一次结果。供 paint 使用。 */
export function eventResult() {
  return lastEventResult;
}

/** 重置事件层（start / stop 时调，避免跨代残留）。 */
export function resetEventState() {
  turnStartAt = null;
  turnTokens = 0;
  lastEventResult = null;
  // lastSessionId **故意不清**：它是“当前在跟谁说话”的连续状态，
  // 清了会在下一轮开始时丢归属。只在 stop 时清（下面单独做）。
}

export function resetSessionHint() {
  lastSessionId = null;
}

/**
 * 把台账记录按「轮次」切分，新的在前。
 *
 * 为什么需要切：一轮回复会产生多条记录（每次工具调用后继续生成都是一条），
 * 不切的话分母会变成整个会话的跨度，算出来是个没有意义的数。
 *
 * 切分依据是相邻记录的时间间隔 —— 超过 ROUND_GAP_MS 就认为是新一轮。
 * 宿主不提供「这一轮」的显式边界，`session:entries` 理论上能给消息时间戳，
 * 但它的返回类型是 `unknown[]`，没验证过结构就往上建是赌。
 * 真要更准，应该去验那条路的实际结构。
 *
 * @param {Array} entries usage:list 的返回，已按时间倒序或正序都能处理
 * @returns {Array<Array>} 每个元素是一条记录的数组，第一个是最新的那轮
 */
export function groupRounds(entries) {
  const rows = [];
  const seen = new Set();
  for (const e of entries || []) {
    const out = num(e?.usage?.output?.totalTokens);
    const at = Date.parse(e?.startedAt);
    // 没有输出 token 的记录不参与：它既不贡献分子也不该拉长时间跨度。
    if (out === null || out <= 0) continue;
    if (!Number.isFinite(at)) continue;
    // 去重。**不能只在有 requestId 时才做** ——
    //
    // 早先写成 `if (typeof id === "string" && id) { ... }`，
    // 于是缺 requestId 的记录完全绕开守卫。usage:list 一旦返回任何无 id 的条目
    // （provider 聚合条目、旧 schema、非 LLM 类型的用量），重复记录就双双进袋，
    // token 直接翻倍、spanMs 不变 → tps 显示为真值的 2 倍。
    //
    // 而那个错得很有说服力：正常值才 50-200，翻倍后仍在“合理区间”内，
    // renderText 的荒谬值过滤 (>10000) 拦不住，tooltip 照常说“含工具时间”。
    //
    // 兵底：用 时间戳+模型+token数 做指纹。没有稳定 id 时它可能误合并两条
    // 真正相同的记录，但那种情况要求两者在这三项上完全一样 —— 概率极低，
    // 而漏掉去重的代价是直接翻倍。宁可极端保守。
    const id = typeof e?.requestId === "string" && e.requestId
      ? e.requestId
      : `#${at}|${e?.model?.modelId || ""}|${out}`;
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({ at, out, model: e?.model?.modelId || null });
  }
  rows.sort((a, b) => a.at - b.at);

  const rounds = [];
  let cur = [];
  for (const r of rows) {
    if (cur.length && r.at - cur[cur.length - 1].at > ROUND_GAP_MS) {
      rounds.push(cur);
      cur = [];
    }
    cur.push(r);
  }
  if (cur.length) rounds.push(cur);
  return rounds.reverse();
}

/**
 * 算某一轮的速度。
 *
 * @returns {{tps:number|null, tokens:number, spanMs:number, calls:number, model:string|null, reason?:string}}
 *          tps 为 null 时 reason 说明为什么算不出来 —— 不猜、不填 0。
 */
export function speedOf(round) {
  const calls = round?.length || 0;
  if (!calls) return { tps: null, tokens: 0, spanMs: 0, calls: 0, model: null, reason: "empty" };

  const tokens = round.reduce((a, r) => a + r.out, 0);
  const spanMs = round[round.length - 1].at - round[0].at;
  const model = round[round.length - 1].model;

  // 只有一条记录时跨度必然为 0 —— 单次调用的 startedAt/endedAt 是同一时刻。
  if (spanMs <= 0) return { tps: null, tokens, spanMs: 0, calls, model, reason: "no-span" };
  if (spanMs < MIN_SPAN_MS) return { tps: null, tokens, spanMs, calls, model, reason: "too-short" };
  if (tokens < MIN_TOKENS) return { tps: null, tokens, spanMs, calls, model, reason: "too-few-tokens" };

  return { tps: tokens / (spanMs / 1000), tokens, spanMs, calls, model, reason: null };
}

/**
 * 一轮结束后要等多久才认为它“算完了”。
 *
 * 为什么必须等：宿主没有“轮次结束”的硬信号。已经逐条验过：
 *   - requestId 形如 `llm_muqdb657_60`，800 条只有一个前缀，没有轮次信息
 *   - source.trigger 2708 条是 `user`、15 条是 `tool`，区分不出轮次起点
 *   - session:entries 能给消息时间戳，但宿主直接拒：“session does not belong to app input-toolkit”
 * 所以只能拿“多久没动静”当结束标志。
 *
 * 为什么是 20 秒：拿真实账本量了“半截数据 vs 跑完”的偏差（123 个轮次）：
 *   已跑 0-2s   → 偏高 5.63 倍，100% 的样本误差超 50%
 *   已跑 2-5s   → 偏高 3.24 倍，90%
 *   已跑 5-10s  → 偏高 2.63 倍，83%
 *   已跑 10-20s → 偏高 1.39 倍，44%
 *   已跑 20-40s → 偏高 1.13 倍，33%   ← 偏差在这里开始收敛
 * 偏差始终是**偏高**（分母里的工具执行时间还没累积进去），所以宁可晚不可早。
 * 20 秒是偏差降到可接受范围的临界点，再往上等收益很小。
 *
 * ⚠️ 这个阈值现在只作用于**兼底路径**（宿主不给轮次事件时）。
 * 主路径由 `turn_end` 事件精确触发，根本不等它 ——
 * 早先没有事件，只能拿这个凑合值硬等。
 */
const SETTLE_MS = 20_000;

/** 只取最新一轮。 */
export function latestSpeed(entries) {
  const rounds = groupRounds(entries);
  if (!rounds.length) return { tps: null, tokens: 0, spanMs: 0, calls: 0, model: null, reason: "no-entries" };
  return speedOf(rounds[0]);
}

/**
 * 取**应该显示**的那一轮：正在跑的那轮不算，往前退一轮。
 *
 * @param {Array} entries 台账记录
 * @param {number} [now] 当前时间（可注入，便于测试）
 */
export function settledSpeed(entries, now = Date.now()) {
  const rounds = groupRounds(entries);
  if (!rounds.length) return { tps: null, tokens: 0, spanMs: 0, calls: 0, model: null, reason: "no-entries" };
  const newest = rounds[0];
  const age = now - newest[newest.length - 1].at;
  // 时间戳落在**未来**时 age 为负。
  //
  // 真实来源：NTP 大幅回拨、用户手改系统时间、跨时区解析差异。
  // 不抦的话 `age >= SETTLE_MS` 恒为 false → 永远判定“还在跑” →
  // 永远沿用 lastGood，tooltip 固定显示“本轮还在进行”，而且**不自愈**：
  // 要等系统时间追上那个错的时间戳才行。
  //
  // 处理：负值当作“已结束”。理由是宁可早算一轮（数字随后会被新数据覆盖），
  // 也不能永久卡住 —— 前者一分钟后自愈，后者可能几小时都不动。
  const settled = age < 0 ? true : age >= SETTLE_MS;
  if (settled) return speedOf(newest);
  // 还在跑：这一轮的统计是半截的，不拿它报速度。退到上一轮。
  if (rounds.length < 2) {
    // 只有一轮、而它还在跑：既不能报半截速度，也没有上一轮可退。
    // 必须置空 —— 不置空的话会把进行中的高值当成真速度报出去。
    const s = speedOf(newest);
    return { ...s, tps: null, reason: "running" };
  }
  return { ...speedOf(rounds[1]), running: true };
}

/**
 * 正文：`112 tok/s`。
 *
 * 不带“本轮”两个字：tooltip 已经说清了它是什么，正文再顶一个前缀就是冗余。
 *
 * 取整不取两位小数：速度是个粗粒度的量（分母含工具时间，抖动大），
 * 显示到 0.1 tok/s 是虚假精度。
 */
export function renderText(stats) {
  if (!stats || stats.tps == null) return NO_DATA_TEXT;
  const v = Math.round(stats.tps);
  // 合理区间 1~2000。低于 1 或高于 2000 的，几乎必然是轮次切分错 / 分母不对。
  //
  // 上限取 2000 而不是 1 万：云端模型正常输出速度大致 10~500，
  // 2000 已经是极端快的边缘。放宽到一万会让“切错了一轮”这种错直接显示成一个
  // 看起来很合理的大数 —— 而荒谬值过滤的唯一作用就是拦住这种情况。
  if (v < 1 || v > 2000) return NO_DATA_TEXT;
  return `${v} tok/s`;
}

/**
 * tooltip：一行，只说这是什么、什么时候更新。
 *
 * 口径那句「含工具执行时间」是必须写的 —— 不写的话用户会拿它跟
 * 纯生成速度的评测数字比，然后得出「这个模型怎么这么慢」的错误结论。
 */
/**
 * tooltip：一行，说清“这是什么”+“什么时候更新”。
 *
 * 为什么短：宿主的浮层已经把标题（本轮速度）显示在第一行了，
 * tooltip 再重复一遍就是纯冗余；而套一层“本轮平均速度：上一轮, 含工具时间”
 * 读起来像绕圈子。各自说清楚即可，不叠前缀。
 */
export function buildTooltip(stats) {
  if (!stats) return "正在取本轮速度…";
  if (stats.error) return fitTooltipWithAction("本轮平均速度", stats.error);
  if (stats.tps != null) {
    // 三种“显示的不是刚跑完那轮”的情况要分开说：
    //   running = 新一轮正在跑，显示的是上一轮
    //   stale   = 连上一轮都取不到，沿用更早的值
    if (stats.running) return "上一轮的平均速度";
    if (stats.stale) return "沿用更早一轮的速度";
    return "本轮平均速度，含工具时间";
  }
  // 算不出来时直接说原因，不再套一层“本轮平均速度：”。
  // 套了之后读起来是“本轮平均速度：本轮还没结束”——同一个词说了两遍。
  const why = {
    "no-entries": "还没有用量记录",
    "no-span": "本轮还没结束",
    "too-short": "本轮太短",
    "running": "本轮还在进行",
    "too-few-tokens": `本轮 token 不足 ${MIN_TOKENS}`,
  }[stats.reason];
  return fitTooltip(why || "暂无可用数据");
}

async function fetchFor(bus, sessionId) {
  const hit = cache.get(sessionId);
  if (hit && !hit.error && Date.now() - hit.fetchedAt < FRESH_MS) return hit;
  try {
    // limit 200 与缓存命中率一致：取不满就是本次会话的全部记录。
    const res = await bus.request("usage:list", { sessionId, limit: 200 });
    const next = {
      entries: Array.isArray(res?.entries) ? res.entries : [],
      fetchedAt: Date.now(),
      error: null,
    };
    cache.set(sessionId, next);
    return next;
  } catch (err) {
    const next = { entries: [], fetchedAt: Date.now(), error: String(err?.message || err) };
    cache.set(sessionId, next);
    return next;
  }
}

export const speed = {
  id: "speed",
  // 标题与 manifest 里的 status 标题保持一致（都是“速度”）。
  // 早先这里写“本轮速度”、manifest 也写“本轮速度”，但 tooltip 在新一轮
  // 进行中会说“上一轮的平均速度”——三处对不上。改成中性标题后不再冲突，
  // 具体是哪一轮交给 tooltip 说。
  title: "速度",
  blurb: "在输入栏显示当前这一轮的平均 token 输出速度",
  statusId: SPEED_STATUS_ID,
  defaultText: NO_DATA_TEXT,  defaultTooltip: "本轮平均速度",  toolName: "input_toolkit_set",
  args: { action: "refresh", featureId: "speed" },

  isEnabled: (values) => values?.features?.speed !== false,

  /**
   * 会话关闭/归档时清掉自己的按会话缓存。
   * index.js 的会话清理钩子会调它（和 __perSession 一起清）。
   * 不实现的话 lastGood / cache 会无限增长，且旧会话的值会在 id 复用时诈尸。
   */
  dropSession(sessionId) {
    dropSession(sessionId);
  },

  /** 开关变了就用已有数据重算，台账数据不会因为开关而过期。 */
  onConfigChange(ctx) {
    return paint(ctx);
  },

  async describe(ctx) {
    const ids = ctx?.status?.sessionIds?.() || [];
    return { kind: "speed", blocks: [], sessions: ids.length };
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
    lastGood.clear();
    resetEventState();
    resetSessionHint();
  },
};

async function paint(ctx) {
  if (ctx.isEnabled && !ctx.isEnabled()) return 0;
  const ids = ctx.status.sessionIds();
  if (!ids.length) return 0;

  // 世代号必须在 **await 之前**取。
  //
  // 早先写在 `await Promise.all(...)` 之后，那样只能拦住“取完数之后才重载”的情况，
  // 拦不住最危险的那个窗口：**重载发生在取数期间**。那时候 results 已经是
  // 上一代的取数结果，而上一代已经被 stop() 掉、它的上下文也已经失效。
  // 在 await 前取号，才能让这个窗口被识别出来并放弃写入。
  const myGen = gen;
  const results = await Promise.all(ids.map((id) => fetchFor(ctx.sdk.bus, id)));
  if (myGen !== gen) return 0;
  for (let i = 0; i < ids.length; i += 1) {
    const r = results[i];
    const stats = displayFor(ids[i], r?.entries, r?.error);
    ctx.setStatusFor(ids[i], {
      text: renderText(stats),
      tooltip: buildTooltip(stats),
    });
  }
  if (myGen !== gen) return 0;
  return ctx.repaintAll();
}

export const SPEED_ACTIONS = {
  async refresh(ctx) {
    for (const key of cache.keys()) cache.delete(key);
    await paint(ctx);
    const ids = ctx.status.sessionIds();
    if (!ids.length) return "没有可显示的会话";
    const r = cache.get(ids[0]);
    const stats = displayFor(ids[0], r?.entries, r?.error);
    if (stats.tps == null) return `算不出速度（${stats.reason || "无数据"}）`;
    return renderText(stats);
  },
};
