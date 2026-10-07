/**
 * lib/quota/adapters.js —— 额度适配器
 *
 * 一个 adapter 回答三件事：
 *   1. 「我认得这个供应商吗」—— matchHost
 *   2. 「我有哪几个额度可以给你看」—— quotas
 *   3. 「怎么把它取回来」—— fetch
 *
 * 为什么按 host 匹配而不是按 providerId：
 *   宿主预设里 minimax 有 minimax / minimax-token-plan 两个 id，用户的 providerId
 *   还可能是自己起的名字（这台机器上就有 agnes-ai.com 这种非标准 id）。
 *   认 host 认的是**这家公司**，认 id 认的是**你给它的外号**，后者必然漏。
 *   代价是每个候选 provider 要多一次 provider:credentials 调用拿 baseUrl ——
 *   六七个供应商的规模下这个开销可以忽略。
 *
 * 为什么请求用固定端点而不拼 baseUrl：
 *   额度接口是各家私有的，路径不能推。baseUrl 只用来**判断认不认得**，
 *   真正请求打向各家公开文档里的确定地址。这样即使用户改了 baseUrl 的前缀
 *   （比如加了反向代理），匹配会失配并报出原因，而不是拿着错的路径去请求。
 *
 * 加一家供应商 = 在这里加一个对象 + 在 manifest 的 network.allowedHosts 加它的 host。
 * manifest 是静态的，编译期就定死，所以这个改动必须走重装，不能热加载。
 */

import { fitTooltip } from "../tooltip.js";

/** 从 baseUrl 里取 host。取不到就返回空串，让 matchHost 全部落空而不是误匹配。 */
export function hostOf(baseUrl) {
  try {
    return new URL(String(baseUrl || "")).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** host 落在主域下就算命中。`api.minimaxi.com` 与 `www.minimaxi.com` 都算 minimaxi.com。 */
function underHost(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function toNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const t = value.trim();
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * 百分比渲染。
 *
 * 负数**不夹成 0**。夹了会造出一个看起来完全合理的假数字：
 * provider 返回 -1（“无限制 / 不适用”）、-100、或浮点误差的 -0.4，
 * 都会被 `Math.max(0, ...)` 变成 `0%` —— 而旁边配着 `✓` 和一个新鲜的时间戳，
 * 用户看到的是“额度 0%”，第一反应是“用完了”，可能要跑去续费。
 *
 * 真实不可能的负值要**原样报出来**，让用户知道是接口返回了怪东西，
 * 而不是自己额度归零。夹���与不夹的差别就在这里。
 */
function pct(value) {
  const n = toNumber(value);
  if (n == null) return "—";
  if (!Number.isFinite(n)) return "—";
  if (n < 0) return `异常 ${Math.round(n)}%`;
  return `${Math.min(100, Math.round(n))}%`;
}

/** 金额：去尾零，最多两位小数。取不到时保留货币符号 —— 裸的“—”会让人不知道那是什么。 */
const CURRENCY_SYMBOL = { CNY: "¥", USD: "$", EUR: "€", JPY: "¥", HKD: "HK$" };

/**
 * 金额：去尾零，最多两位小数。取不到时保留货币符号 —— 裸的“—”会让人不知道那是什么。
 *
 * 货币符号**必须跟着返回的 currency 走**，不能一律印 ¥：
 * OpenRouter 按美元计价，硬印成 ¥ 会把一个 $3.20 的余额显示成 ¥3.20 ——
 * 数字看着对、单位错了，比显示不出来更误导（人会以为便宜了七倍）。
 */
function money(value, currency) {
  const n = toNumber(value);
  const sym = CURRENCY_SYMBOL[String(currency || "CNY").toUpperCase()] || `${currency || "CNY"} `;
  if (n == null) return `${sym}—`;
  return `${sym}${Number(n.toFixed(2))}`;
}

const minimax = {
  id: "minimax",
  title: "MiniMax",
  /** 覆盖 api. / www. / 裸域，以及 token-plan 子域。 */
  matchHost: (host) => underHost(host, "minimaxi.com") || underHost(host, "minimaxi.chat"),
  quotas: [
    { id: "interval", title: "5 小时窗", short: "5H", format: (d) => `5H ${pct(d.intervalPct)}` },
    { id: "weekly", title: "周窗", short: "周", format: (d) => `周 ${pct(d.weeklyPct)}` },
  ],
  async fetch({ apiKey, network }) {
    const res = await network.fetch("https://www.minimaxi.com/v1/token_plan/remains", {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      timeoutMs: 15000,
      maxResponseBytes: 65536,
    });
    if (!res.ok) throw new Error(`MiniMax 返回 HTTP ${res.status}`);
    const body = await res.json();
    const items = Array.isArray(body?.model_remains) ? body.model_remains : [];
    const general =
      items.find((m) => m?.model_name === "general") ||
      items.find((m) => typeof m?.model_name === "string") ||
      null;
    if (!general) throw new Error("MiniMax 返回里没有可用的额度数据");
    return {
      intervalPct: toNumber(general.current_interval_remaining_percent),
      weeklyPct: toNumber(general.current_weekly_remaining_percent),
    };
  },
  /** 供告警判断用：返回 [百分比...] 里最小的那个。 */
  levels: (d) => [d.intervalPct, d.weeklyPct].filter((v) => v != null).map(Number),
};

const deepseek = {
  id: "deepseek",
  title: "DeepSeek",
  matchHost: (host) => underHost(host, "deepseek.com"),
  quotas: [{ id: "total", title: "账户余额", short: "余", format: (d) => money(d.total, d.currency) }],
  async fetch({ apiKey, network }) {
    const res = await network.fetch("https://api.deepseek.com/user/balance", {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      timeoutMs: 15000,
      maxResponseBytes: 65536,
    });
    if (!res.ok) throw new Error(`DeepSeek 返回 HTTP ${res.status}`);
    const body = await res.json();
    if (body?.is_available === false) throw new Error("DeepSeek 账户不可用");
    const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
    // 优先人民币，没有就取第一个币种，别因为用户充的是美元就显示成空。
    const info = infos.find((b) => b?.currency === "CNY") || infos[0] || null;
    if (!info) throw new Error("DeepSeek 返回里没有余额数据");
    return { total: toNumber(info.total_balance), currency: info.currency ?? "CNY" };
  },
  levels: () => [],
};

/**
 * 智谱 GLM。
 *
 * 端点与字段形状参考了社区里已发布的实现（而不是自己猜的）：
 *   GET https://open.bigmodel.cn/api/paas/v4/users/me/balance
 *   → { success, data: { limits: [{ type: "TOKENS_LIMIT", percentage }] } }
 *
 * `percentage` 是**已用**百分比，所以余量是 100 - 它。
 * 这一点很容易搞反 —— 直接显示 percentage 会把“已用 80%”说成“剩 80%”。
 *
 * 宿主预设里这一家的 id 是 `zhipu`，baseUrl 前缀是 .../api/paas/v4。
 */
const glm = {
  id: "glm",
  title: "智谱 GLM",
  matchHost: (host) => underHost(host, "bigmodel.cn") || underHost(host, "zhipuai.cn"),
  quotas: [{ id: "remain", title: "剩余配额", short: "余", format: (d) => pct(d.remainPct) }],
  async fetch({ apiKey, network }) {
    const res = await network.fetch("https://open.bigmodel.cn/api/paas/v4/users/me/balance", {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      timeoutMs: 15000,
      maxResponseBytes: 65536,
    });
    if (!res.ok) throw new Error(`智谱 GLM 返回 HTTP ${res.status}`);
    const body = await res.json();
    if (body?.success === false) throw new Error(`智谱 GLM 返回失败：${body?.error?.message || "未知原因"}`);
    const limits = Array.isArray(body?.data?.limits) ? body.data.limits : [];
    const token = limits.find((l) => l?.type === "TOKENS_LIMIT") || limits[0] || null;
    const used = toNumber(token?.percentage);
    if (used == null) throw new Error("智谱 GLM 返回里没有配额数据");
    return { remainPct: 100 - used };
  },
  levels: (d) => [d.remainPct].filter((v) => v != null).map(Number),
};

/**
 * 月之暗面 Kimi。
 *
 *   GET https://api.moonshot.cn/v1/users/me/balance
 *
 * 返回形状各家不统一，所以按候选字段依次试；都取不到就报出来，
 * 而不是默默显示一个 0 —— 0 和“取不到”在界面上必须能分开。
 */
const moonshot = {
  id: "moonshot",
  title: "月之暗面 Kimi",
  matchHost: (host) => underHost(host, "moonshot.cn") || underHost(host, "moonshot.ai"),
  quotas: [{ id: "total", title: "账户余额", short: "余", format: (d) => money(d.total, d.currency) }],
  async fetch({ apiKey, network }) {
    const res = await network.fetch("https://api.moonshot.cn/v1/users/me/balance", {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      timeoutMs: 15000,
      maxResponseBytes: 65536,
    });
    if (!res.ok) throw new Error(`月之暗面返回 HTTP ${res.status}`);
    const body = await res.json();
    const d = body?.data ?? body;
    const total = toNumber(d?.available_balance ?? d?.balance ?? d?.total_balance);
    if (total == null) throw new Error("月之暗面返回里没有余额数据");
    return { total, currency: d?.currency || "CNY" };
  },
  levels: () => [],
};

/**
 * OpenRouter —— 一个 key 打通 500+ 模型，很多人拿它中转。
 *
 *   GET https://openrouter.ai/api/v1/credits
 *   → { data: { total_credits, total_usage } }   两个都是美元
 *
 * 余额 = 已充值 - 已用。两个字段都报出来：只给一个差值的话，
 * 用户看不出“余额低”是充得少还是用得多。
 */
const openrouter = {
  id: "openrouter",
  title: "OpenRouter",
  matchHost: (host) => underHost(host, "openrouter.ai"),
  quotas: [
    { id: "balance", title: "剩余额度", short: "余", format: (d) => money(d.balance, "USD") },
    { id: "usage", title: "累计已用", short: "用", format: (d) => money(d.usage, "USD") },
  ],
  async fetch({ apiKey, network }) {
    const res = await network.fetch("https://openrouter.ai/api/v1/credits", {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      timeoutMs: 15000,
      maxResponseBytes: 65536,
    });
    if (!res.ok) throw new Error(`OpenRouter 返回 HTTP ${res.status}`);
    const body = await res.json();
    const credits = toNumber(body?.data?.total_credits);
    const usage = toNumber(body?.data?.total_usage);
    if (credits == null || usage == null) throw new Error("OpenRouter 返回里没有额度数据");
    return { balance: credits - usage, usage };
  },
  levels: () => [],
};

export const ADAPTERS = [minimax, deepseek, glm, moonshot, openrouter];

const BY_HOST = ADAPTERS;
export const ADAPTER_BY_ID = new Map(ADAPTERS.map((a) => [a.id, a]));

/** 用 baseUrl 找 adapter。找不到返回 null —— 调用方负责把它显示成「无公开额度接口」。 */
export function adapterForBaseUrl(baseUrl) {
  const host = hostOf(baseUrl);
  if (!host) return null;
  return BY_HOST.find((a) => a.matchHost(host)) ?? null;
}

/** 段键 → 取值函数。段键形如 `minimax:interval`，是设置页勾选项的唯一标识。 */
export function segmentKey(adapterId, quotaId) {
  return `${adapterId}:${quotaId}`;
}

export function parseSegmentKey(key) {
  const i = String(key).indexOf(":");
  if (i <= 0) return null;
  const adapter = ADAPTER_BY_ID.get(String(key).slice(0, i));
  const quotaId = String(key).slice(i + 1);
  if (!adapter) return null;
  const quota = adapter.quotas.find((q) => q.id === quotaId);
  if (!quota) return null;
  return { adapter, quota };
}

/** 段内分隔符：同一供应商内部的额度之间。用 `/` 而不是 `|`——
 *  `|` 在这一行里承担了太多含义（段间、供应商间都在讨论用竖线），
 *  换成斜杠后「/ = 同一家的两个窗，· = 两家」这组区分一眼就成立。 */
const SEG_SEP = " / ";
/** 供应商之间的分隔符：比段内更重，因为它是分组边界。 */
const GROUP_SEP = "  ·  ";
/** 成功/失败标记。不能用「…」，那个字符在输入栏上已经被“还没取到数据”占用了，
 *  再拿它表示失败就成了两义；而 ✓/✗ 一眼可分。 */
const OK_MARK = "✓";
const BAD_MARK = "✗";

/**
 * 把「选中的段 + 各 adapter 的数据」渲染成输入栏那一行。
 *
 * 分隔是**两级**的：同一家公司的额度之间用 `/`，不同公司之间用更重的 `· `。
 * 只勾一家时不启用重分隔（那会在只有一个分组的行里加一个毫无意义的孤立点）。
 *
 * 取不到数据的段用 `✗` 而不是省略号：省略号表达的是「省略」，
 * 而这里是「取不到」，两码事；混用会让一次网络抖动看起来像一项没配。
 */
export function renderSegments(segmentKeys, dataByAdapter) {
  const parts = [];
  let currentAdapter = null;
  for (const key of segmentKeys || []) {
    const parsed = parseSegmentKey(key);
    if (!parsed) continue;
    const data = dataByAdapter?.[parsed.adapter.id];
    let text;
    try {
      text = parsed.quota.format(data);
    } catch {
      text = `${parsed.quota.short} ${BAD_MARK}`;
    }
    if (data === undefined || data === null) text = `${parsed.quota.short} ${BAD_MARK}`;
    if (currentAdapter !== null && parsed.adapter.id !== currentAdapter) {
      if (parts.length) parts.push(GROUP_SEP);
    } else if (parts.length && !parts[parts.length - 1].endsWith(GROUP_SEP)) {
      parts.push(SEG_SEP);
    }
    currentAdapter = parsed.adapter.id;
    parts.push(text);
  }
  // 没勾任何项：给引导文案，不返回空串。
  // 返回 "" 会被直接写进输入栏，表现是一行空白 —— 用户看到的是“额度消失了”，
  // 而不是“还没选要看哪几项”。后者要他去设置里勾，前者他只会以为坏了。
  if (parts.length === 0) return "额度 · 未选";
  // 拼接前把分隔符归一：上面分开 push 是为了判断边界，最后合成字符串
  return parts.join("").trim();
}

/** 已知错误的固定短标签。固定文案比截断可靠 —— 截断会造出半句话。 */
const ERROR_LABELS = [
  [/no_credentials|凭证|API Key/i, "无Key"],
  [/\b(401|403)\b/, "401"],
  [/\b429\b/, "限流"],
  [/超时|timeout|timed ?out/i, "超时"],
  [/ENOTFOUND|ECONNRESET|ECONNREFUSED|fetch failed|网络/i, "网络"],
  [/HTTP 5\d\d/, "5xx"],
  // JSON 解析失败：CDN/反代返回 200 + HTML 错误页时走这里。
  // 早先落到兜底的 slice(0,6)，会变成 “Unexpe” 这种半截英文。
  [/JSON|Unexpected token|is not valid JSON/i, "返回非JSON"],
  [/certificate|CERT_|SSL|TLS/i, "证书"],
  [/abort|aborted/i, "已中断"],
];

/**
 * 把错误压成极短的标签。
 *
 * tooltip 只有约 34 列，写 `HTTP 401 Unauthorized` 会把整行挤爆；
 * 而写 “DeepSeek✗HTTP 401” 这种给人看的句子在 hover 时又太嗦。
 * 用户在这一行里真正需要的只是“哪一家出了问题、属于哪类问题”，所以映射成码。
 * 完整原因不进 tooltip —— 失败已经同时反映在输入栏的 ✗ 上，不会因为这里简化而消失。
 */
function shortError(msg) {
  const s = String(msg || "");
  for (const [re, label] of ERROR_LABELS) {
    if (re.test(s)) return label;
  }
  // 兵底：不能再用 slice(0, 6)。对中文那是半句话（“返回里没有…”），
  // 对英文是半截单词（“Unexpe”），两种都看不懂。
  // 改成先看有没有可读的中文/英文短语，实在认不出就只说“错误”——
  // 一个诚实的“错误”比一个误导人的半截词有用。
  const t = s.replace(/\s+/g, " ").trim();
  if (!t) return "错误";
  // 数字型（状态码之类）可以安全截；含字母/中文的一律不截。
  if (/^[\d\s.:/-]+$/.test(t)) return t.slice(0, 8) || "错误";
  return "错误";
}

/**
 * 生成 tooltip（宿主的第二排）。
 *
 * 关键决定：**这里不放额度数值**。输入栏上已经写着，重复一遍既占宽度又零信息增益。
 * 放的是输入栏给不了的东西——哪家成功、什么时候取的、哪家失败、为什么失败。
 *
 * 格式：`MiniMax✓21:38 · DeepSeek✓21:38`，每家只出现一次。
 */
export function buildTooltip(segmentKeys, { dataByAdapter, errors, fetchedAt } = {}) {
  // 参与的供应商 = 选中段涉及的那些，按首次出现顺序
  const order = [];
  for (const key of segmentKeys || []) {
    const p = parseSegmentKey(key);
    if (p && !order.includes(p.adapter.id)) order.push(p.adapter.id);
  }
  if (order.length === 0) return "没有勾选任何额度，去设置里选";
  const hhmm = (t) => (t ? `${String(new Date(t).getHours()).padStart(2, "0")}:${String(new Date(t).getMinutes()).padStart(2, "0")}` : "--:--");
  const parts = order.map((id) => {
    // 名字用 id 不用 title：title 是「MiniMax」「DeepSeek」这种全称，两家加起来就超预算了。
    const name = id === "deepseek" ? "DS" : id === "minimax" ? "MM" : id.slice(0, 4);
    const err = errors?.[id];
    if (err) return `${name}${BAD_MARK}${shortError(err)}`;
    const at = fetchedAt?.[id];
    return `${name}${OK_MARK}${hhmm(at)}`;
  });
  // 缩写名已经把它压到 ~19 字，但供应商增多了就会超。
  // 统一交给 fitTooltip 兼底，不靠“应该不会太长”。
  return fitTooltip(parts.join(" · "));
}
