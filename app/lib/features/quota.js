/**
 * lib/features/quota.js —— API 额度
 *
 * 在输入栏显示「5h 82% | 周 64% | ¥110.00」这样一行：用户选了哪几个额度就显示哪几个，
 * 顺序跟勾选顺序一致，中间用 ` | ` 隔开。
 *
 * 三块职责分得很清：
 *   describe()  —— 给设置页的元数据（有哪些供应商、每个有哪些额度可勾）。**跟启不启用无关**。
 *   start()     —— 轮询与渲染。禁用时根本不跑。
 *   段的选择    —— 存在 config.quotaSegments 里，渲染时按它过滤。
 *
 * describe 和 start 分开是因为一个实际需求：**功能关掉了，设置页里还得能再打开它**。
 * 如果目录只在 start 里发布，功能一关，设置页上那一项就消失了，用户再也开不回来。
 */

import {
  ADAPTERS, adapterForBaseUrl, renderSegments, buildTooltip, segmentKey, parseSegmentKey,
} from "../quota/adapters.js";
import { QUOTA_STATUS_ID } from "./ids.js";

/** 轮询节奏。额度变化不快，但耗尽了要能及时看到。 */
const POLL_MIN_MS = 60_000;
const POLL_MAX_MS = 240 * 60_000;

/** 轮询中的互斥闸门用 in-flight Promise，不用布尔量——见下面 refresh 的注释。 */
let inflight = null;
let seq = 0;

/** providerId -> { adapterId, baseUrl }，describe 与 fetch 共用。 */
let matched = new Map();
/** adapterId -> 最近一次成功的数据 */
let data = {};
/** adapterId -> 最近一次失败原因 */
let errors = {};
/** adapterId -> 最近一次成功取数的时间戳，tooltip 里显示 */
let fetchedAt = {};
let pollTimer = null;
let gen = 0;

/**
 * 枚举宿主已配置的供应商，并逐个判定能不能匹配上 adapter。
 *
 * 枚举走 provider:models-by-type 而不是 models.list：后者要 app/models.infer 授权，
 * 为了列几个名字去要推理能力不划算。session:list 同理——不传 scope 只会看到本 App 自己的。
 */
async function enumerateProviders(bus) {
  const res = await bus.request("provider:models-by-type", { type: "chat" });
  const models = Array.isArray(res?.models) ? res.models : [];
  const ids = [];
  for (const m of models) {
    const id = [m?.provider, m?.providerId].find((v) => typeof v === "string" && v);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** 取 baseUrl 并判 adapter。没有凭证就取不到 baseUrl，这类供应商只能标成「未配 Key」。 */
async function resolveProvider(bus, providerId) {
  try {
    const creds = await bus.request("provider:credentials", { providerId });
    if (creds && typeof creds === "object" && !creds.error && creds.apiKey) {
      return { apiKey: creds.apiKey, baseUrl: creds.baseUrl ?? null, providerId };
    }
    return { error: creds?.error === "no_credentials" ? "未配置 API Key" : creds?.error || "取不到凭证" };
  } catch (err) {
    return { error: String(err?.message || err) };
  }
}

export const quota = {
  id: "quota",
  title: "API 额度",
  /** 设置页的副标题。给人看的，不是给代码看的。 */
  blurb: "在输入栏显示 API 剩余额度",
  statusId: QUOTA_STATUS_ID,
  defaultText: "额度 —",
  defaultTooltip: "点击立即刷新额度",
  /** 必填：缺了它这条贡献会被宿主静默丢弃（见 probe.js 里的详细说明）。 */
  toolName: "input_toolkit_set",
  args: { action: "refresh", featureId: "quota" },

  isEnabled: (values) => values?.features?.quota !== false,

  /** 本功能贡献的配置字段。quotaSegments 不可渲染（它在「勾选哪些额���」里处理），
   *  但仍要声明，否则 config 层不认这个类型、会把它当废值丢弃。 */
    /**
   * 配置变了（勾选哪几项、刷新间隔……），用**已经取到的数据**重新算一遍。
   *
   * 为什么必须有这个：状态行上的文字存在 feature 自己的暂存里，宿主重画时
   * 直接拿那个旧值写一遍 —— 内容一模一样，于是被去重挡掉，看上去就是“改了没反应”。
   * 开关能生效是因为 visible 从 true 翻到 false，那是实打实的变化；
   * 勾选只改“写哪几个字”，不通知 feature 重算就永远停在上一版。
   *
   * 不重新取数：数据没过��，多等一轮网络只会让用户白等几秒。
   */
  onConfigChange(ctx) {
    return paint(ctx);
  },

  configFields: {
    quotaSegments: {
      type: "stringArray",
      fallback: ["minimax:interval", "minimax:weekly", "deepseek:total"],
    },
    quotaPollMinutes: {
      // 下拉而不是数字输入框：手填一个“7 分钟”毫无意义，
      // 而填错一个超出范围的数还会静默退回默认，用户看不出发生了什么。
      // 给几个常用的就够了。
      type: "enum",
      numeric: true,
      unit: "分钟",
      values: [1, 5, 10, 15, 30, 60],
      fallback: 5,
      label: "刷新间隔",
      hint: "额度变化不快，不必太勤。",
    },
  },

  /**
   * 设置页元数据。禁用时也会被调用——这是「关掉之后还能再打开」的前提。
   */
  async describe(ctx) {
    const providerIds = await enumerateProviders(ctx.sdk.bus).catch(() => []);
    const rows = [];
    const next = new Map();
    for (const providerId of providerIds) {
      const creds = await resolveProvider(ctx.sdk.bus, providerId);
      const adapter = creds.baseUrl ? adapterForBaseUrl(creds.baseUrl) : null;
      if (adapter && creds.apiKey) next.set(providerId, { adapterId: adapter.id, baseUrl: creds.baseUrl });
      rows.push({
        providerId,
        adapterId: adapter?.id ?? null,
        title: adapter?.title ?? providerId,
        matchable: Boolean(adapter && creds.apiKey),
        // 三种「不匹配」的原因要分开说，用户才知道该去做什么：
        //   未配 Key → 去设置里配凭证
        //   有 Key 但 host 不认识 → 这家没有公开额度接口，加 adapter 才能支持
        //   连 baseUrl 都没有 → 凭证读不出来
        note: adapter
          ? creds.apiKey
            ? ""
            : "已识别，但没读到 API Key"
          : creds.apiKey
            ? "该供应商没有公开的额度接口"
            : creds.error || "读不到凭证",
        quotas: adapter ? adapter.quotas.map((q) => ({ id: q.id, title: q.title, key: segmentKey(adapter.id, q.id) })) : [],
      });
    }
    matched = next;
    return {
      kind: "quota",
      providers: rows,
      adapters: ADAPTERS.map((a) => ({ id: a.id, title: a.title })),
      /**
       * 要在设置页渲染的区块，顺序即显示顺序。
       *
       * 以前这里是另一套形状（fields / providers 分开挂在 extra 上），
       * 设置页得为“额度”写一段专用代码、再为其它功能写一段通用代码 ——
       * 两条平行路径，额度的配置还被拆到了两个标题下，看着不像一伙的。
       * 改成统一的 blocks 后：设置页只认区块类型，功能自己声明要什么。
       */
      blocks: [
        {
          // 勾选项不再带自己的标题了：它在“显示哪几项”那个分组下，
          // 再顶一行标题是重复的，而且把卡片撑得很高。
          kind: "segments",
          key: "quotaSegments",
          providers: rows,
        },
        {
          kind: "field",
          key: "quotaPollMinutes",
          type: "enum",
          numeric: true,     // 存数字，不存字符串
          unit: "分钟",       // 下拉里显示成“5 分钟”，不是一个光秃秃的 5
          values: [1, 5, 10, 15, 30, 60],
          label: "刷新间隔",
          hint: "额度变化不快，不必太勤。",
        },
      ],
    };
  },

  start(ctx) {
    gen += 1;
    const myGen = gen;
    ctx.log("info", `已启动，匹配到 ${matched.size} 个可用供应商`);

    const tick = async () => {
      if (myGen !== gen) return;
      await refresh(ctx, myGen);
      if (myGen !== gen) return;
      const v = ctx.config.peek() || {};
      const minutes = Math.min(POLL_MAX_MS, Math.max(1, Number(v.quotaPollMinutes) || 5));
      pollTimer = setTimeout(tick, minutes * 60_000);
      pollTimer.unref?.();
    };
    pollTimer = setTimeout(tick, 1200);
    pollTimer.unref?.();
  },

  stop() {
    gen += 1;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    // 清掉在途闸门并作废所有在途写入。
    //
    // inflight / seq 都是**模块级**的，不清就会跨代泄漏：
    //   1. inflight 不清 → 新代 refresh 命中 `if (inflight) return inflight`，
    //      拿到的是**旧代**的 promise；而旧代内部 `if (myGen !== gen) return null`
    //      → 这一轮**一次 HTTP 都没发**，也没有任何东西会重试，
    //      要等满一个轮询间隔（最短 1 分钟）才恢复。
    //   2. seq 不推进 → 旧代已经发出的响应回来时 `n !== seq` 不成立，
    //      于是**旧代的数据写进新代的 data**。
    inflight = null;
    seq += 1;
  },
};

/** 取某个 provider 的 API Key。没有匹配就返回 null，让调用方跳过而不是报错。 */
async function apiKeyFor(bus, adapterId) {
  for (const [providerId, info] of matched) {
    if (info.adapterId !== adapterId) continue;
    const creds = await resolveProvider(bus, providerId);
    if (creds.apiKey) return creds.apiKey;
  }
  return null;
}

async function fetchOne(ctx, adapter) {
  const apiKey = await apiKeyFor(ctx.sdk.bus, adapter.id);
  if (!apiKey) throw new Error(`没有 ${adapter.title} 的可用凭证`);
  return adapter.fetch({ apiKey, network: ctx.sdk.network });
}

/**
 * 刷新一轮。
 *
 * 互斥用 in-flight Promise 而不是布尔量：布尔量会被外部的 finally 提前清掉，
 * 轮询、点击、告警三条路径叠加时请求数没有上界，真实表现是「越点越限流」。
 * 手动刷新（force）等在飞的那轮结束后**在本调用里**再跑一轮，
 * 否则用户点了看到的还是上一轮的数据。
 */
export async function refresh(ctx, myGen = gen, options = {}) {
  const force = options.force === true;
  if (inflight) {
    if (!force) return inflight;
    try {
      await inflight;
    } catch {
      /* 错误已在 fetchOne 内处理 */
    }
    if (myGen !== gen) return null;
    if (inflight) return inflight;
  }
  inflight = (async () => {
    const n = ++seq;
    const used = new Set((ctx.config.peek()?.quotaSegments || []).map((k) => parseSegmentKey(k)?.adapter.id).filter(Boolean));
    await Promise.all(
      ADAPTERS.filter((a) => used.has(a.id)).map(async (adapter) => {
        try {
          const d = await fetchOne(ctx, adapter);
          // 双重守卫：n 管同代内的轮次竞争，myGen 管跨代。
          // 早先只有 n !== seq，而 seq 是模块级的且 stop() 不推进它，
          // 于是重载后旧代在途的响应会把数据写进新代。
          if (n !== seq || myGen !== gen) return;
          data[adapter.id] = d;
          fetchedAt[adapter.id] = Date.now();
          delete errors[adapter.id];
        } catch (err) {
          if (n !== seq || myGen !== gen) return;
          // 保留上一次成功的数据：一次网络抖动不该让整行变成问号。
          errors[adapter.id] = String(err?.message || err);
        }
      }),
    );
    // 只统计**当前仍被勾选**的供应商。
    // 早先直接用 Object.keys(data) / Object.keys(errors)，那数的是
    // 历史上取过数的全部 —— 取消勾选后日志还报“成功 3 家”，
    // 而 errors 里的旧失败永远不会消失。日志是取数失败唯一的出口，不能骗人。
    const got = Object.keys(data).filter((k) => used.has(k));
    const bad = Object.keys(errors).filter((k) => used.has(k));
    // 刷新结果必须出声：取数失败在输入栏上只是几个字，不看日志根本发现不了。
    ctx.log(
      bad.length ? "warn" : "info",
      `刷新完成：成功 ${got.length} 家` +
        (got.length ? `（${got.map((k) => `${k}=${JSON.stringify(data[k])}`).join(" ")}）` : "") +
        (bad.length ? `，失败 ${bad.length} 家：${bad.map((k) => `${k}=${errors[k]}`).join("; ")}` : ""),
    );
    if (myGen !== gen) return null;
    return paint(ctx);
  })();
  // 记住自己这一轮的 promise。
  // 收尾时**只清自己那一份**：早先是无条件 `inflight = null`，
  // 而 force 分支里是「await 旧轮 → 赋新轮」。于是 A 轮的 finally 可能
  // 跑在 B 轮赋新值**之后**，把 B 的新轮置成 null —— 闸门被自己的收尾拆掉。
  // 后果：第三个调用者看到 null，各自发起一轮独立取数（每轮两个外部 HTTP），
  // 快速连点就打到 429。注释里描述的“越点越限流”原封不动回来了。
  const mine = inflight;
  try {
    return await mine;
  } finally {
    if (inflight === mine) inflight = null;
  }
}

function paint(ctx) {
  // 开关已经关了就不再渲染。
  // stop() 只能拦住未来的定时器；已经在飞的取数会在这之后才回来。
  // 这里直接返回、不调 setStatus：可见性由 index.js 的「已关闭」分支统一写，
  // 而且它用的不是 f.__visible 这种会残留的字段——那个字段一旦被置 false，
  // 功能重新开启时会被读成“继续隐藏”，额度就再也不出现了。
  if (ctx.isEnabled && !ctx.isEnabled()) return 0;
  const v = ctx.config.peek() || {};
  const segments = Array.isArray(v.quotaSegments) ? v.quotaSegments : [];
  const text = renderSegments(segments, data);
  // tooltip 是**第二排**（第一排是 manifest 的 title）。它只说输入栏给不了的事：
  // 哪家成功、什么时候取的、哪家失败、为什么。数值不重复。
  const tooltip = buildTooltip(segments, { dataByAdapter: data, errors, fetchedAt });
  return ctx.setStatus({ text, tooltip });
}

export const QUOTA_ACTIONS = {
  async refresh(ctx) {
    const r = await refresh(ctx, gen, { force: true });
    const v = ctx.config.peek() || {};
    return renderSegments(v.quotaSegments, data) || (r ? "已刷新" : "无勾选项");
  },
};
