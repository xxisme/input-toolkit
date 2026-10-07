/**
 * lib/features/polisher.js —— 提示词优化
 *
 * 点一下 → 读输入框原文 → 调小工具模型改写 → UIAutomation 真替换；再点一下还原。
 *
 * 从 prompt-polisher 整体搬过来的，行为**刻意保持一致**——它已经在用机上跑了很久，
 * 里面的乐观锁、回读校验、焦点策略、前台二次校验都是踩出来的。这里不趁机"改好"，
 * 只做两件事：接进 feature 契约，以及把旧的 sdk 依赖换成 ctx。
 *
 * 三个状态符号全用单色字符（⋯ ↶ ⚠），不用 ⏳ 这类彩色 emoji：
 * 彩色和线框图标放一起是最刺眼的不统一，比图标本身简朴更难看。
 * 默认态的 🪄 是彩色 emoji，是有意接受的例外——辨识度优先于内部一致性。
 */

import { setFocusedInputValue, readComposerForOptimize } from "../uia/desktop-input.js";
import { optimizePrompt } from "../optimize.js";
import { POLISHER_STATUS_ID } from "./ids.js";
import { fitTooltip } from "../tooltip.js";

const IDLE_TEXT = "🪄";
/**
 * 空闲态的 hint。
 *
 * 原先 33 字，被输入栏的浮层裁成半截。压到 24 字以内。
 * 保留的信息：做什么（优化当前输入框）、点了会发生什么（原地替换）、还能反悔（再点撤销）。
 * 删掉的是「文本」「原文」这类重复的量词 —— 三个短句已经说清了。
 */
const IDLE_TOOLTIP = "优化当前输入框，点击替换，再点撤销";
const BUSY_TEXT = "⋯";
const BUSY_TOOLTIP = "正在读输入框、调模型、写回，通常 2-8 秒";
const UNDO_TEXT = "↶";
const UNDO_TOOLTIP = "点击把输入框还原成优化前的原文";
const FAIL_TEXT = "⚠";

/**
 * 后台轮询的间隔（**已停用**，常量保留是为了记录当初的取舍）。
 *
 * 它原本每 20s 冷启一个 PowerShell 进程去扫 UIA 树，只为了发现
 * “用户在输入框里动了手” —— 早先 5s 一次，30 分钟 TTL 下会拉起 360 个进程。
 * 降到 20s 降到 90 个。
 *
 * 现在整个轮询停用了，理由见下面 startWatch 的注释：它读的是**前台**输入框，
 * 却要删**某个会话**的原文，而宿主不提供“当前聚焦会话”查询，这个对应关系
 * 无法被证明。收益（按钮图标好看一点）远小于代价（不可逆丢原文）。
 */
/** 撤销挂起态的存活期与容量上限（纯内存，防跨会话无限累积）。 */
const PENDING_TTL_MS = 30 * 60 * 1000;
const PENDING_MAX_SESSIONS = 8;
/**
 * 整条链路的硬超时。
 *
 * 单步（读、写、模型）各有自己的超时，但那只管“进程跑太久”。
 * 管不到的是“进程根本没起来 / 被杀不掉”这类情况——await 永不返回，
 * 于是 UI 停在「正在…��、in-flight 闸门永不解锁，之后点多少次都只得到
 * “请稍候再试”。窗口最小化是最容易撞上的场景：UIAutomation 调 PowerShell，
 * 窗口不可见时可能挂起。
 *
 * 45 秒盖住 2-8 秒的正常耗时，也给慢速模型留了余量；超时后强制收尾。
 */
const OP_TIMEOUT_MS = 45_000;

/**
 * 哨兵 sessionId。
 * 宿主只为会话页输入栏挂载 inputStatus 贡献项，首页 chat tile 不挂载，
 * 于是从首页或快捷键进来时 context.sessionId 为空。
 * 优化本体是 UIAutomation 读写输入框，不依赖会话对象，所以空 sessionId 不该阻断流程；
 * 用哨兵键让 in-flight 闸门 / 撤销键照常工作，只有状态行更新要跳过。
 */
const NO_SESSION = "\u0000no-session";

/**
 * 撤销挂起态：sessionId -> { orig, optimized, baseline, ts }。
 *
 * ⚠️ 它必须活过 App 重载，而模块级 Map **做不到**。
 *
 * 实测（注入计数器读宿主日志，连续两次 reload）：polisher 模块在每次 reload 时
 * 都被重新求值，模块作用域因此重建。所以早先这里的模块级 `new Map()`：
 *   点 🪄 → 按钮变 ↶ → 宿主重载 / 插件更新
 *   → pending 空了 → isPending 为假 → 再点是**优化**路径
 *   → 模型拿**已经改写过的文本**当草稿再改一遍
 *   → 原稿永久消失，界面上没有任何提示（按钮已经是 🪄，看着像正常）
 *
 * 而且 globalThis 救不了：同一轮实测里 globalThis 上的计数器两次都从 1 开始，
 * 说明它跟着模块一起重建了。能跨重载的只有宿主的持久化存储。
 *
 * 存储是**异步**的，所以内存里这份 Map 是热缓存（写回后立即可读），
 * 启动时从存储里恢复。注意：写原文进存储 = 把用户输入落到磁盘，
 * 恢复时只取未过期的，取完就删，不长期留存。
 */
const pending = new Map();
/** 持久化用的存储句柄，start() 时拿。 */
let pendingStore = null;
const PENDING_STORE_KEY = "polisher.pending.v1";

/** 把挂起态写进宿主存储。失败只记日志，不影响本次操作。 */
async function persistPending() {
  if (!pendingStore) return;
  try {
    if (!pending.size) { await pendingStore.delete(PENDING_STORE_KEY); return; }
    await pendingStore.set(PENDING_STORE_KEY, JSON.stringify([...pending]));
  } catch (err) {
    // 写不进去意味着下次重载会丢原文 —— 这件事必须让用户知道，
    // 但不该阻断当前这次优化（它已经成功了）。
    ctxLog?.("warn", `撤销挂起态持久化失败，重载后可能无法还原：${err?.message || err}`);
  }
}

/** 启动时从存储恢复。取完即删：只在重载后那一次需要它。 */
async function restorePending() {
  if (!pendingStore) return;
  try {
    const raw = await pendingStore.get(PENDING_STORE_KEY);
    if (!raw) return;
    const list = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(list)) return;
    const now = Date.now();
    let kept = 0;
    for (const [sid, e] of list) {
      // 过期的不认。用户重新打开时看到的是按钮状态，不是三天前的草稿。
      if (!e || now - (e.ts || 0) > PENDING_TTL_MS) continue;
      pending.set(sid, e);
      kept += 1;
    }
    ctxLog?.("info", `从存储恢复撤销挂起态 ${kept}/${list.length} 条`);
  } catch (err) {
    ctxLog?.("warn", `恢复撤销挂起态失败：${err?.message || err}`);
  } finally {
    try { await pendingStore.delete(PENDING_STORE_KEY); } catch { /* 忽略 */ }
  }
}
/**
 * 日志出口。prunePending 是同步的、拿不到 ctx，而淘汰必须在日志里留痕，
 * 所以先存着，等 start() 拿到 ctx 再接上。
 */
let ctxLog = null;
let watchTimer = null;
/** per-session in-flight 闸门：宿主的 disabled 只是 UI 提示，不是 API 闸门。 */
const inFlight = new Set();
/**
 * 操作世代号。每开一次操作自增。
 * 底层 promise 在超时后仍可能稍后 resolve，而它 resolve 时会去写状态行 ——
 * 那时用户可能已经点了下一次。所以过期操作一律不得碰状态，否则会覆盖新状态。
 */
let opSeq = 0;

const DEFAULT_SYSTEM_PROMPT =
  "你是一名提示词优化助手。用户会给你一段对话输入框里的草稿文本，你要���不改变用户核心意图的前提下，把它改写得更清晰、结构更完整、表达更可执行。\n\n" +
  "规则:\n" +
  "1. 保留所有关键事实、数字、专有名词、代码片段、人称;\n" +
  "2. 把口语化、跳跃、缺主语的句子补全为完整陈述;\n" +
  "3. 必要时用列表/编号拆分多步骤需求;\n" +
  "4. 不引入用户没说过的前提，不做夸大，不写寒暄客套;\n" +
  "5. 如果原文已经很清晰，只做最小润色，不要重写;\n" +
  "6. 只输出改写后的文本本身，不要加任何前后缀、不要加代码块包裹、不要解释。";

/** 轻量规范化：只抹平 UIA 偶发的换行/尾随空白差异，不做语义改写。 */
function normWatch(s) {
  return String(s ?? "").replace(/\r\n/g, "\n").replace(/[\s\u00A0]+$/g, "");
}

/** 回读校验用的宽松规范化：抹掉 TipTap 会吃掉的富文本标记字符后再比。 */
function normVerify(s) {
  return String(s ?? "").replace(/[`*_~]/g, "").replace(/\s+/g, " ").trim();
}

function prunePending() {
  const now = Date.now();
  for (const [sid, e] of pending) {
    if (!e || now - (e.ts || 0) > PENDING_TTL_MS) drop(sid, "超过 30 分钟");
  }
  while (pending.size > PENDING_MAX_SESSIONS) {
    let oldestSid = null;
    let oldestTs = Infinity;
    for (const [sid, e] of pending) {
      const t = e?.ts ?? 0;
      if (t < oldestTs) { oldestTs = t; oldestSid = sid; }
    }
    if (oldestSid == null) break;
    drop(oldestSid, "挂起会话过多");
  }
}

/**
 * 被淘汰的会话，暂存起来等有 ctx 的地方上报。
 *
 * 淘汰本身就是**丢数据**：如果那个会话的输入框里还是优化后的文本，
 * 原文随条目一起没了，按钮却还停在 ↶，点下去走的是优化路径。
 * 早先这里是静默 delete，用户既不知道原文没了，也不知道按钮为什么失灵。
 * 现在至少要让他知道“撤销过期了”。
 */
const evicted = new Set();

function drop(sessionId, why) {
  if (!pending.has(sessionId)) return;
  pending.delete(sessionId);
  // 删了必须同步落盘。不写回的话存储里那条还在，
  // 下次重载会把它恢复回来 —— 一个已经失效的挂起态诈尸。
  void persistPending();
  evicted.add(sessionId);
  ctxLog?.("warn", `优化挂起已淘汰（${why}）：${sessionId}`);
}

/** 取出并清空待上报的淘汰列表。 */
export function drainEvicted() {
  if (!evicted.size) return [];
  const out = [...evicted];
  evicted.clear();
  return out;
}

function isPending(sessionId) {
  prunePending();
  return pending.has(sessionId);
}

function stopWatchIfEmpty() {
  if (pending.size === 0 && watchTimer) {
    clearInterval(watchTimer);
    watchTimer = null;
  }
}

async function guard(fn) {
  try {
    return await fn();
  } catch (e) {
    // 内部错误串可以留长（会进日志、也会进 fail 消息），
    // 但一旦写进 hint 就必须走 fitTooltip —— 那里才是宽度受限的地方。
    return { ok: false, code: "THREW", message: String(e?.message || e).slice(0, 200) };
  }
}

function hintOf(code, message) {
  switch (code) {
    case "NO_HANA": return "HanaAgent 未运行(请先启动 HanaAgent 主窗口)";
    case "NO_INPUT_BOX": return "找不到聊天输入框(HanaAgent 界面结构可能变了)";
    case "NO_HANA_FOREGROUND": return "前台窗口不在 HanaAgent，请点一下 HanaAgent 窗口再试";
    case "WIN32_TIMEOUT": return `操作超时:${message || "PowerShell 未在限时内结束"}`;
    case "COMPOSER_CHANGED": return "输入框内容在优化期间已变化，已取消写回";
    case "CLIPBOARD_ERROR": return `剪贴板不可用:${message || ""}`;
    default: return `读输入框失败:${message || code}`;
  }
}

function readbackOk(readback, optimized, orig) {
  if (!readback) return false;
  if (normVerify(readback) === normVerify(optimized)) return true;

  // 兼容归一化后的差异（空白、零宽字符等），但**不能只问“是不是原文”**。
  //
  // 早先的兼容判据是 `readback !== orig`：只要不等于原文就算写成功。
  // 而“部分写入”稳稳地满足这个条件 —— 编辑器吞了后半段、只落了前 200 字、
  // 或者富文本把某些字符吃掉，结果都是“不等于原文”，于是被判成功；
  // 接着又把这份**残缺的**内容存成 baseline。
  // 用户拿到的是“静默的半截改写 + 声称成功”，而且没法再还原回真正��原文。
  //
  // 所以兼容也要有下限：长度不能差太多，开头必须对得上。
  // 宁可误报失败（走“已保留原文”的路，用户能看到发生了什么），
  // 也不能把半截改写当成成功 —— 后者不可逆。
  const got = normVerify(readback);
  const want = normVerify(optimized);
  if (!want) return false;
  if (Math.abs(got.length - want.length) / Math.max(got.length, want.length) > 0.15) return false;
  const head = Math.min(24, want.length);
  if (head > 0 && got.slice(0, head) !== want.slice(0, head)) return false;
  return true;
}

export const polisher = {
  id: "polisher",
  title: "提示词优化",
  blurb: "把输入框里写的提示词改写得更清晰",
  statusId: POLISHER_STATUS_ID,
  defaultText: IDLE_TEXT,
  defaultTooltip: IDLE_TOOLTIP,
  toolName: "input_toolkit_set",
  args: { action: "optimize", featureId: "polisher" },

  isEnabled: (values) => values?.features?.polisher !== false,

  /**
   * 本功能贡献的配置字段。config 层不写死这些业务概念。
   * types: string / number / enum。设置页读 describe() 里的同一份描述去渲染表单，
   * 所以加一个字段只需要改这里——不用再去 settings.html 里加一个控件。
   */
  /**
   * 配置变了，刷新一下按钮状态。
   *
   * 和 quota 不同，这里不是为了改显示内容 —— 优化提示词的按钮样子（🪄/↶/⚠）
   * 跟配置无关。但**确实需要**：config 被重新读了一遍，缓存要跟上，
   * 否则下一次点按钮时拿到的还是旧配置（比如你刚把焦点策略改成了 never，
   * 下一次点击却还按 auto 去抢焦点）。
   */
  async onConfigChange(ctx) {
    await ctx.config.read(true);
  },

  configFields: {
    systemPrompt: {
      type: "string",
      fallback: DEFAULT_SYSTEM_PROMPT,
      label: "优化指令（系统提示词）",
      hint: "告诉小工具模型如何优化用户草稿。可改成更窄的偏好，例如「只润色不重写」「翻译成英文」。",
    },
    // 温度和最大 tokens 曾经是可调项，现在去掉了。
    //
    // 它们不是“调了就会更好”的旋钮：温度调高会把“保守补全”变成“重写”，
    // 而重写出来的内容用户往往要再检查一遍，实际更费事。默认值对
    // “把草稿写清楚”这件事已经够用。真想改行为，改上面那段提示词
    // 比拨这两个数字有效得多 —— 后者改的只是措辞的随机度。
    //
    // 两个字段仍留在代码里（见 optimize.js 的调用处），只是不再暴露成可调项。
    focusStrategy: {
      type: "enum",
      values: ["auto", "never"],
      fallback: "auto",
      label: "前台焦点策略",
      hint: "auto：焦点不在输入框时用 UIAutomation 抢回来。never：不抢焦点，不在前台就直接失败——适合你正在用其它窗口、不想被打断时。",
    },
  },

  describe() {
    // 把 configFields 逐个转成设置页的区块，顺序即 configFields 的书写顺序。
    // 不传 fallback：设置页需要知道“用户没改过”才能显示占位，
    // 而默认值很长（优化指令），传下去只会让表单里全是默认文本。
    return {
      kind: "fields",
      blocks: Object.entries(polisher.configFields).map(([key, spec]) => ({
        kind: "field",
        key,
        type: spec.type,
        values: spec.values,
        label: spec.label,
        hint: spec.hint,
      })),
    };
  },

  async start(ctx) {
    ctxLog = ctx.log;
    // 拿宿主的跨重载存储。恢复必须完成后再对外服务，
    // 否则重载后到恢复之间那一下点击会看到空的 pending 而走优化路径。
    pendingStore = ctx.sdk?.storage?.global || null;
    if (pendingStore) {
      await restorePending();
    } else {
      // 没有存储就意味着重载后原文会丢。必须说清楚，不能默默降级。
      ctx.log("warn", "拿不到持久化存储（sdk.storage.global），撤销态无法跨重载保留");
    }
    ctx.log("info", `已启动，恢复撤销挂起态 ${pending.size} 条`);
    // 上一轮 execute 若还在跑，它的 finally 会拿旧 Set 实例 delete；
    // 新加载的 App 看到残留项就以为会话还忙，下一次点击被闸门静默挡掉。
    if (inFlight.size > 0) inFlight.clear();
    if (watchTimer) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
    opSeq += 1;
  },

  stop() {
    opSeq += 1;
    if (watchTimer) clearInterval(watchTimer);
    watchTimer = null;
    inFlight.clear();
  },
};

/** 写状态行。首页无挂载点时宿主会拒收，此时静默跳过——用户本来就看不到按钮。 */
async function setState(ctx, sessionId, { text, tooltip, disabled }, opId) {
  if (sessionId === NO_SESSION) return;
  // 过期操作不写：它的结果属于上一轮，覆盖当前状态会让界面与实际不符。
  if (opId !== undefined && opId !== opSeq) return;
  // 必须按会话写。早先用的是 ctx.setStatus —— 它写的是 feature.__text
  // **单一全局槽**，于是 A 优化完切到 B，B 的输入栏也显示“↶ 还原”。
  // 而点击分支判的是 isPending(sessionId)（按会话），所以在 B 点下去
  // 走的是**优化**路径，不是还原。界面承诺一件、实际做另一件。
  // �� pending 一样按会话存，显示和点击才对得上。
  await ctx.setStatusFor?.(sessionId, { text, tooltip, disabled });
  await ctx.repaintAll?.();
}

/** 给一条可能永不 settle 的 promise 加硬超时。超时不是“结果”，是“放弃”。 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}超时`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 后台轮询：**已停用**。这里保留代码形状是为了记录一次真实的取舍，不是死代码。
 *
 * 它原本干的事：输入框内容不再等于「写回后的基线」→ 认定用户在写新草稿 → 按钮复位。
 *
 * 为什么不能这么做：它读的是**前台窗口**那个输入框（UIA 拿不到会话身份），
 * 而它删除的是 **pending 里某个会话**的原文。两者对不上号。
 *
 * 一个具体到能复现的场景：
 *   1. 会话 A 优化完，pending = { A }，按钮停在 ↶
 *   2. 用户不动 A，直接切到会话 B 继续打字
 *   3. 20 秒后：pending.size === 1（通过早先那道守卫）
 *      → 读到的是 **B 的输入框内容**
 *      → 与 A 的 baseline 不等
 *      → 删掉 A 的 pending、把 A 的按钮复位成 🪄
 *   4. 而 A 的输入框里仍然是优化后的文本，**原文已经没有任何副本了**
 *
 * 早先的守卫是 `pending.size !== 1` 就跳过，并注释说“只有一个条目时它必定是当前会话的”。
 * 那个前提是错的：size===1 只说明“只有 A 挂着撤销态”，**完全不能推出前台就是 A**。
 * 上面的场景里 size 恰恰等于 1，守卫直接放行。
 *
 * 宿主没有提供“当前聚焦会话”的查询（查过 SDK：只有 sessionId 形参，没有 currentSession
 * 之类的东西），UIA 也分不清。所以这个判断**无法被安全地证明**。
 *
 * 而它的收益只是按钮图标好看一点：用户手动点一下，撤销路径自带的乐观锁
 * （`expect: baseline`）会发现内容已变，然后诚实地告诉他“内容已变化，未还原”。
 * 收益是装饰性的，代价是不可逆的丢数据 —— 这笔账不该这么算，所以停用。
 */
function startWatch() {
  // 停用。保留函数是为了让调用点与本注释同处一地，
  // 将来若宿主补上「当前聚焦会话」查询，改这里而不是重新推导一遍。
}

export const POLISHER_ACTIONS = {
  /**
   * 点击输入栏条目。manifest 的 args 是静态的，永远发 optimize，所以撤销靠 pendingUndo 的有无来分流。
   *
   * 状态机的硬要求：**每一条退出路径都必须落到一个终态**。
   * 早期版本五条失败路径全是 `return 消息`，不碰状态行，于是中途任何一步失败
   * 都把按钮留在「正在…」上；而 in-flight 闸门也被占住，之后点多少次都没反应。
   * 现在的做法是：正常路径显式 settle，finally 再兵底一次“有没有落到终态”。
   */
  async optimize(ctx) {
    const rawSessionId = String(ctx.toolSessionId || "");
    const sessionId = rawSessionId || NO_SESSION;
    const opId = ++opSeq;

    // 宿主的 disabled 只是 UI 提示，同 session 连点仍会 dispatch —— 闸门必须在这里。
    if (inFlight.has(sessionId)) return "上一次操作还没完成，请稍候再试";
    inFlight.add(sessionId);

    // 被淘汰的挂起如果包含本会话，必须先说出来。
    // 否则用户看到的是“按钮还在、点下去却是优化”，完全不知道原文已经没了。
    const gone = drainEvicted().includes(sessionId);
    const goneNotice = gone ? "（之前的优化已过期，原文不再保留）" : "";

    /** 已落到终态的标志。finally 用它决定要不要兵底。 */
    let settled = false;
    const settle = async (state, message) => {
      settled = true;
      await setState(ctx, sessionId, state, opId);
      return message;
    };
    const idle = (message) => settle({ text: IDLE_TEXT, tooltip: IDLE_TOOLTIP, disabled: false }, message);
    const fail = (message) =>
      settle({ text: FAIL_TEXT, tooltip: fitTooltip(message), disabled: false }, String(message));

    try {
      const cfg = ctx.config.peek() || {};
      const rescueFocus = String(cfg.focusStrategy || "auto") !== "never";

      // ── 撤销路径 ──
      if (isPending(sessionId)) {
        const p = pending.get(sessionId);
        if (!p) return idle(`没有可还原的优化(可能已撤销，或挂起状态已过期)${goneNotice}`);
        // 乐观锁：只有输入框仍是「写回后的基线」才还原，避免冲掉用户新写的内容。
        const write = await guard(() =>
          withTimeout(setFocusedInputValue(p.orig, { expect: p.baseline || null, rescueFocus }), OP_TIMEOUT_MS, "写回"),
        );
        if (!write.ok) {
          if (write.code === "COMPOSER_CHANGED") {
            pending.delete(sessionId);
            void persistPending();
            stopWatchIfEmpty();
            return idle("输入框内容已变化，未还原(原来的优化文稿已被你覆盖)");
          }
          return fail(`还原失败:${write.message || write.code}`);
        }
        pending.delete(sessionId);
        void persistPending();
        stopWatchIfEmpty();
        return idle(`已还原为原文(${p.orig.length} 字符)${goneNotice}`);
      }

      // ── 优化路径 ──
      await setState(ctx, sessionId, { text: BUSY_TEXT, tooltip: BUSY_TOOLTIP, disabled: true }, opId);

      const read = await guard(() =>
        withTimeout(readComposerForOptimize({ rescueFocus }), OP_TIMEOUT_MS, "读取输入框"),
      );
      if (!read.ok) return fail(hintOf(read.code, read.message));
      const orig = String(read.value || "");
      if (!orig.trim()) return fail("输入框为空，先打字再点优化");

      const opt = await guard(() =>
        withTimeout(
          optimizePrompt(ctx.sdk, orig, {
            systemPrompt: cfg.systemPrompt,
            // 温度和 maxTokens 以前是可调项，现在固定用这里的值。
            // 不传则 optimizePrompt 用它自己的默认（也是这两个数），
            // 但写出来更好：为什么是这两个数，一眼能看到。
            temperature: 0.3,
            maxTokens: 800,
            timeoutMs: OP_TIMEOUT_MS,
          }),
          OP_TIMEOUT_MS + 5000,
          "模型改写",
        ),
      );
      if (!opt.ok) return fail(`优化失败:${opt.message || opt.code}`);

      const optimized = opt.text;
      if (optimized === orig) return idle("模型认为原文已足够清晰，未做改动");

      // 乐观锁：写前必须仍是原文，防止用户新敲的内容被覆盖。
      const write = await guard(() =>
        withTimeout(setFocusedInputValue(optimized, { expect: orig, rescueFocus }), OP_TIMEOUT_MS, "写回"),
      );
      if (!write.ok) {
        return write.code === "COMPOSER_CHANGED" ? fail(hintOf("COMPOSER_CHANGED")) : fail(`写回失败:${write.message || write.code}`);
      }

      const readback = String(write.readback ?? "");

      // ── 顺序在这里是安全边界，不能调换 ──
      //
      // 写回此刻**已经发生了**：输入框里已经是 optimized，orig 只剩这一条命。
      // 早先把 pending.set 放在回读校验**之后**，于是校验不过就直接 return ——
      // 原文随闭包一起消失，按钮变成 ⚠，而 isPending 为假，再点一次走的是
      // **优化**路径而不是还原。用户的原稿不可逆地没了。
      //
      // 而且这正是“回读与预期不符”该发生的时候：编辑器可能只落了半截、
      // 可能吞了内容 —— 恰恰是最需要留退路的一种情况。
      //
      // （另一个因素：我把回读判据收紧了，更多案例会落到这条分支上。
      //   所以这条分支必须是**安全**的，而它之前恰恰是最危险的那条。）
      pending.set(sessionId, { orig, optimized, baseline: readback, ts: Date.now() });
      // 立刻落盘。写回已经发生了，原文只存在这一个地方 ——
      // 落盘失败 = 下次重载拿不回原稿，所以这里不能等、不能吞。
      await persistPending();
      prunePending();
      startWatch();

      if (!readbackOk(readback, optimized, orig)) {
        // 不报失败。报失败等于告诉用户“没了”，而实际上原文就在 pending 里。
        // 停在可还原状态：按钮是 ↶，点下去能拿回原稿。
        return settle(
          { text: UNDO_TEXT, tooltip: fitTooltip("写回异常，已保留原文，点此还原"), disabled: false },
          `写回后回读与预期不符，输入框内容可能不完整\n已保留原文，点「↶」可还原`,
        );
      }

      const hint = sessionId === NO_SESSION ? "再触发一次可还原" : "点「↶」可还原";
      return settle(
        { text: UNDO_TEXT, tooltip: UNDO_TOOLTIP, disabled: false },
        `已优化并替换输入框内容\n原 ${orig.length} 字符 → 新 ${optimized.length} 字符\n${hint}`,
      );
    } catch (e) {
      // withTimeout 的超时、setStatus 自身的失败…… 都在这里收口。
      return fail(String(e?.message || e));
    } finally {
      // 兵底：正常路径已经 settle 过；走到这里说明中途抛了未捕获的异常。
      // 不收尾就是“按钮永远停在正在…”——这是本功能最容易被踩坏的地方。
      if (!settled) {
        try {
          await setState(ctx, sessionId, { text: FAIL_TEXT, tooltip: "操作中断", disabled: false });
        } catch {
          /* 连兵底都写不进去就算了，但不能因此抛出去 */
        }
      }
      inFlight.delete(sessionId);
    }
  },
};
