/**
 * lib/optimize.js
 *
 * 调宿主小工具模型把原始提示词改写成更清晰版本。模型选择走宿主 utility 通道
 * (sdk.models.utility),不引入新供应商,无需 App 自带 key。
 *
 * 返回约定:
 *   { ok: true,  text: string }              — 拿到优化结果
 *   { ok: false, code, message }
 *   code ∈ EMPTY | MODEL_TIMEOUT | MODEL_ERROR
 */
import { randomUUID } from "node:crypto";

const DEFAULT_SYSTEM_PROMPT =
  "你是提示词优化助手。保留用户意图,把草稿改写得更清晰、可执行。只输出改写后的文本。";

/** 只剥「整段被一层围栏包住」的情况;不再用 ^``` 无脑吃掉首段 */
function stripOuterFence(s) {
  const m = /^```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(s);
  return m ? m[1].trim() : s;
}

/**
 * @param {object} ctx          HanaPluginSdkV2
 * @param {string} originalText 用户当前输入框里的原文
 * @param {object} opts
 * @param {string} opts.systemPrompt    系统提示词(用户在 App 设置里微调)
 * @param {number} [opts.temperature]   0..1
 * @param {number} [opts.maxTokens]     优化结果上限
 * @param {number} [opts.timeoutMs]     模型调用超时,默认 30000ms
 */
export async function optimizePrompt(ctx, originalText, opts) {
  const text = String(originalText ?? "").trim();
  if (!text) return { ok: false, code: "EMPTY", message: "输入框为空,无需优化" };

  const requestId = `pp-opt-${randomUUID()}`;
  const systemPrompt = String(opts?.systemPrompt || "").trim() || DEFAULT_SYSTEM_PROMPT;

  // 温度:非有限值走默认;clamp 到 [0,1](与设置项 UI 声明一致)
  let temperature = 0.3;
  if (typeof opts?.temperature === "number" && Number.isFinite(opts.temperature)) {
    temperature = Math.max(0, Math.min(1, opts.temperature));
  }
  // 最大输出:非有限/非正走默认;取整并 clamp 到 [1, 8000]
  let maxTokens = 800;
  if (typeof opts?.maxTokens === "number" && Number.isFinite(opts.maxTokens) && opts.maxTokens > 0) {
    maxTokens = Math.max(1, Math.min(8000, Math.floor(opts.maxTokens)));
  }

  const messages = [
    ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
    {
      role: "user",
      content: `原提示词:\n"""\n${text}\n"""\n\n请按 system 指令改写,只输出结果:`,
    },
  ];

  const timeoutMs =
    typeof opts?.timeoutMs === "number" && opts.timeoutMs > 0 ? opts.timeoutMs : 30000;

  // 先把请求发出去,拿到 promise 立刻挂一个空 catch:
  // 超时场景下我们 race 赢了会先返回,底层请求之后才 reject → 不挂 catch 会产生 unhandledRejection。
  let inflight;
  // 发起时刻：后面要去台账里找**我们自己的**那次调用，取它的真实 token 数。
  // 这是拿到确定截断判定的唯一途径，理由见函数末尾的说明。
  const issuedAt = Date.now();
  try {
    inflight = ctx.models.utility({ requestId, messages, temperature, maxTokens });
  } catch (e) {
    // 少数实现可能同步抛
    return { ok: false, code: "MODEL_ERROR", message: String(e?.message || e).slice(0, 300) };
  }
  inflight.catch(() => {});

  let timer;
  let timedOut = false;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`模型调用超过 ${timeoutMs}ms 未返回`));
    }, timeoutMs);
    timer.unref?.();
  });

  let result;
  try {
    result = await Promise.race([inflight, timeoutPromise]);
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 300);
    // 超时后主动取消底层请求:否则它还占着配额在跑,白白烧 token
    if (timedOut) {
      try { await ctx.models.cancel?.(requestId); } catch {}
    }
    return { ok: false, code: timedOut ? "MODEL_TIMEOUT" : "MODEL_ERROR", message: msg };
  } finally {
    if (timer) clearTimeout(timer);
  }

  const out = String(result?.text ?? "").trim();
  if (!out) return { ok: false, code: "EMPTY", message: "模型返回为空" };

  // ── 截断检测：拿真实 token 数，不再猜 ──
  //
  // 为什么在这里抦：写回前只检查了“内容跟原文不一样”，而截断后的版本
  // **确实**跟原文不一样，能轻松通过那个检查。后果：用户写了一段长草稿 →
  // 模型改写到输出上限处被硬切 → 半截改写被当成“优化成功”写回输入框，
  // 而原文后半段只存在于 pending.orig 里，30 分钟 TTL 或下次编辑后就没了。
  // **这是不可逆的数据丢失。**
  //
  // 为什么绕到台账去拿：`models.utility` 的返回类型经真机验证就是
  // `{ requestId, text }` —— **没有 stopReason**（只有 models.stream 的 done 事件带）。
  // 早先这里写的是 `result?.stopReason ?? result?.finishReason ?? …`，
  // 三个字段名在 utility 路径下**永远拿不到值**，那整段是死代码。
  //
  // 而台账这条路能拿到真的：`plugin/models.utility` 记录带 `usage.output.totalTokens`，
  // 那是 provider 侧结算的真实 token 数。真实值 >= 我们请求的 maxTokens → **确定**截断。
  //
  // 这比启发式强得多：启发式拿**字符数**去比 **token 上限**，而 800 token
  // 可能是 600 个汉字也可能是 2400 个英文字母 —— 阈值本身就是错的。
  const realTokens = await ownTokenCount(ctx, issuedAt);
  if (realTokens != null && realTokens >= maxTokens) {
    return {
      ok: false,
      code: "TRUNCATED",
      message: `优化结果被长度限制截断（${realTokens} token 达上限 ${maxTokens}），已放弃写回以免丢失原文后半段`,
    };
  }

  // 兵底启发式：台账可能有延迟或被清理。拿不到真实值时用它，
  // 但它不能单独当依据 —— 所以消息里说“疑似”而不是断言。
  const clean = stripOuterFence(out) || out;
  const nearLimit = realTokens != null
    ? realTokens >= maxTokens * 0.97
    : clean.length >= Math.floor(maxTokens * 0.98);
  // 收尾是不是一个完整标点？用 Unicode 属性转义而不是字符类列举：
  // 引号、括号在正则字面量里都得转义，列举容易漏；\p{P} 直接覆盖全部标点。
  const endsClean = /[\p{P}\p{S}\n]\s*$/u.test(clean);
  if (nearLimit && !endsClean) {
    return { ok: false, code: "TRUNCATED", message: "优化结果疑似被截断（长度贴顶且结尾不完整），已放弃写回以免丢失原文后半段" };
  }
  return { ok: true, text: clean };
}

/**
 * 从台账里找**我们自己的**那次 utility 调用，取它的真实输出 token 数。
 *
 * 怎么认出自己的记录：`source.subsystem === "plugin" && source.operation === "models.utility"`。
 * 宿主把 `attribution.pluginId` 剥掉了（真机实测 attribution 只剩
 * kind/agentId/sessionId/childSessionId），所以没法按应用 id 过滤，
 * 只能靠这个来源签名 + 时间窗口。
 *
 * 已知残余风险：别的 App 也调 models.utility 时会混进同一批记录。
 * 取“发起时刻之后最新的一条”能把风险压到很低（我们刚发出请求，
 * 别人的通常更早），但不能归零。这一点写在这里，不是假装它不存在。
 *
 * @returns {Promise<number|null>} 拿不到时 null，调用方退到启发式。
 */
async function ownTokenCount(ctx, issuedAt) {
  try {
    const res = await ctx.bus.request("usage:list", { limit: 40 });
    const entries = Array.isArray(res?.entries) ? res.entries : [];
    let best = null;
    let bestAt = -Infinity;
    for (const e of entries) {
      if (e?.source?.subsystem !== "plugin" || e?.source?.operation !== "models.utility") continue;
      const at = Date.parse(e?.startedAt);
      if (!Number.isFinite(at) || at < issuedAt - 1000) continue;
      if (at <= bestAt) continue;
      const n = e?.usage?.output?.totalTokens;
      if (typeof n === "number" && Number.isFinite(n) && n > 0) { best = n; bestAt = at; }
    }
    return best;
  } catch {
    return null;
  }
}

export function newOptimizeRequestId() {
  return `pp-opt-${randomUUID()}`;
}
