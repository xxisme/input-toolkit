/**
 * input-toolkit · index.js —— 输入栏工具箱
 *
 * 装配层。这里刻意不认识任何具体功能：它拿配置、问注册表谁该开、
 * 把启用的启动起来、把状态行铺到所有会话上。功能是什么、长什么样，
 * 一律由 lib/features/ 下的模块自己声明。
 *
 * 读代码的顺序建议：lib/registry.js（扩展点在哪）→ lib/status-host.js
 * （状态怎么写）→ lib/config.js（配置存哪）→ 本文件（怎么把三者接起来）。
 */

import { defineApp } from "./sdk/app-contract/server-client.js";
import { createRegistry } from "./lib/registry.js";
import { createStatusHost } from "./lib/status-host.js";
import { createConfig } from "./lib/config.js";
import { FEATURES, FEATURE_ACTIONS } from "./lib/features/index.js";
import {
  noteTurnStart, noteTurnEnd, noteUsageEvent, resetEventState, resetSessionHint,
} from "./lib/features/speed.js";
import { noteSessionCommitted } from "./lib/features/polisher.js";

const APP_ID = "input-toolkit";
const TOOL_NAME = "input_toolkit_set";

/**
 * 进程级单例。
 * App 会被热重载，模块级变量随之重建，但 globalThis 上的东西会活下来。
 * 跨重载需要保留的是那些**需要在断开上一代时用到**的句柄：
 *   - ctx：上一代的 feature 停止时要拿它当参数
 *   - onConfigChanged：配置监听的退订函数。不存就退不掉，
 *     热重载 N 次挂 N 个监听，只增不减
 *   - 往期注册过的 id 集合：用来发现“上一代有、这一代没了”的功能
 */
const g = globalThis.__inputToolkit || (globalThis.__inputToolkit = {
  registry: null,
  status: null,
  config: null,
  ctx: null,
  onConfigChanged: null,
  offSpeedEvents: null,
  /**
   * 单例代号。每启动一代 +1。
   *
   * 为什么不能只用 `disposed` 这种布尔：布尔只能回答“现在是拆卸中吗”，
   * 回答不了“**这个回调属于哪一代**”。而拆卸是异步的（要 await stopAll / status.stop），
   * 等它做完 `disposed` 会被复位给新一代 —— 这中间窗口里，**旧代**的定时器
   * 一旦触发，看到 disposed===false 就会当成自己人，去动新一代的共享状态
   * （旧代会把自己的重铺链标志位置位又清掉，把新代挂起的重铺吃掉）。
   *
   * 布尔只能挡住“正在拆卸”，代号才能挡住“已经不是我了”。
   */
  gen: 0,
});

export const name = APP_ID;

export default defineApp(async (sdk) => {
  // 本代代号。所有异步延续（定时器、promise 链）都要拿它跟 g.gen 比。
  const myGen = (g.gen += 1);

  // ── 1. 断开上一代 ──────────────────────────────────────────
  // 顺序重要：先作废旧代、再停旧宿主与旧功能，最后才建新的。
  //
  // 关键：旧 feature 的定时器/模块级状态**必须停**，否则它们会继续跑，
  // 而它们读的是新一代的 g.config / g.registry —— 旧代在替新代干活。
  // 早先这里只停了 status-host，registry.stopAll 全项目零调用。
  try {
    // 先退订配置监听。退订句柄以前存了但没人用，热重载 N 次就挂 N 个监听，
    // 之后点一次开关触发 N 遍重铺 —— 而且是只增不减的泄漏。
    try { g.onConfigChanged?.(); } catch { /* 忽略 */ }
    g.onConfigChanged = null;
    // 轮次事件退订。不退的话旧代回调会继续 noteTurnStart，
    // 而它写的是新一代的模块级变量 —— 旧代在替新代记事。
    try { g.offSpeedEvents?.(); } catch { /* 忽略 */ }
    g.offSpeedEvents = null;
    resetEventState();
    resetSessionHint();
    try { await g.registry?.stopAll(g.ctx); } catch (err) {
      sdk?.logger?.warn?.(`[${APP_ID}] 停止上一代功能失败：${err?.message || err}`);
    }
  } catch (err) {
    sdk?.logger?.warn?.(`[${APP_ID}] 断开上一代失败：${err?.message || err}`);
  }
  try {
    await g.status?.stop();
  } catch (err) {
    sdk?.logger?.warn?.(`[${APP_ID}] 停止上一代状态宿主失败：${err?.message || err}`);
  }
  g.status = null;
  g.config = null;

  // ── 2. 建三层基础设施 ──────────────────────────────────────
  g.registry = createRegistry();
  g.registry.attachSdk(sdk);
  for (const f of FEATURES) g.registry.use(f);

  g.status = createStatusHost(sdk);
  const declared = g.registry.configFields();

  const log = (level, msg) => {
    // 注意是 sdk.logger[level]，不是 sdk[level] —— 后者永远取不到，
    // 症状是 App 安静地加载成功但一条日志都不打，排查时完全没有线索。
    try {
      sdk?.logger?.[level]?.(`[${APP_ID}] ${msg}`);
    } catch {
      /* 忽略 */
    }
  };

  // 冲突日志必须放在 log 定义**之后**。
  // 早先它在前面：两个 feature 声明同名配置字段时（注册表专门为此做了检测，
  // 说明这是预期内的情况），那一行直接 TDZ 报错，App 整个加载失败，
  // 而且崩溃点在日志工具之前 —— 连一条警告都留不下来。
  for (const c of declared.conflicts) {
    log("warn", `配置字段 ${c.key} 被 ${c.other} 与 ${c.owner} 同时声明，沿用先注册的那个`);
  }
  g.config = createConfig(sdk, { extraFields: declared.fields });

  // ── 3. 读配置，决定谁该显示 ────────────────────────────────
  const values = await g.config.read(true);

  /**
   * 当前生效的配置。
   *
   * 为什么要这个而不是直接用 `values`：这两个**内容相同、对象不同**。
   * `g.config.read()` 每次都会新建一个对象并把 cache 指向它，
   * 而 `values` 是启动时拿到的那一个。配置变更时虽然会把新值抄回 `values`，
   * 但从 read() 完成到抄回之间存在窗口：feature 读 `g.config.peek()`（已是新的），
   * paint 读 `values`（还是旧的）。于是“关掉的功能自己冒出来”——
   * paint 按旧值判断要显示它，而它自己按新值认为该停。
   *
   * 收敛到 config 自己的缓存作为唯一真相源，窗口就没了。
   */
  const cfgNow = () => g.config.peek() || values;

  /**
   * 把状态行铺到所有会话。
   * 一次算好 patch，N 个会话共用 —— 每个 feature 回调 N 次是浪费，
   * 而 N 会随活跃会话数增长（实测能到 16+）。
   *
   * @param {string[]} [onlyIds] 只铺这些 feature。为空表示全铺。
   * @returns {number} 未铺成的条数，供上层判断要不要重试。
   */
  const paint = async (onlyIds = null) => {
    const cfg = cfgNow();
    const enabled = g.registry.enabled(cfg);
    const disabled = g.registry.all().filter((f) => !g.registry.isEnabled(f, cfg));
    const want = (f) => !onlyIds || onlyIds.includes(f.id);
    // missed 只数**真失败**。“内容没变所以没写”不是失败 —— 早先两者混在一起，
    // 稳定不变的状态会持续报缺 N 条并升级成 ERROR，假警报会把真失败淹掉。
    let missed = 0;
    for (const f of enabled) {
      if (!want(f)) continue;
      // 逐会话算：per-session 覆盖值优先于全局值。
      // 缓存命中率按“当前对话”算，必须每个会话显示自己那份；
      // 拿不到覆盖值的会话退回全局值——这比留空白好，因为不是所有 feature
      // 都按会话区分（额度那行对所有会话是一样的）。
      const r = await g.status.applyAll(
        (sessionId) => {
          const own = f.__perSession?.get(sessionId);
          // __text / __tooltip 是 feature 运行期自己设的当前值（点击轮换、额度刷新等）。
          // 必须优先于 defaultText —— 不这样的话，feature 动态更新过一次之后，
          // 下一轮全量 paint 就会拿默认值把它盖回去，表现为“点了没反应”。
          const text = own?.text ?? f.__text ?? f.defaultText ?? null;
          const tooltip = own?.tooltip ?? f.__tooltip ?? f.defaultTooltip ?? null;
          // 改名：内层也叫 disabled 会遮蔽外层那个「被关掉的 feature 列表」。
          // 现在两个 for 各用各的，作用域上确实没出错，但读代码的人会以为
          // 第二个 for 遍历的是「按钮禁用的 feature」——这种雷迟早有人踩。
          const btnDisabled = (own?.disabled ?? f.__disabled) === true;
          // 四字段写全：省略任一个都会被宿主当成“恢复 manifest 声明值”。
          return { id: f.statusId, patch: { text, tooltip, visible: true, disabled: btnDisabled } };
        },
      );
      missed += r.failed;
    }
    for (const f of disabled) {
      if (!want(f)) continue;
      // 关闭走 visible:false 而不是 remove：remove 是"恢复默认"，
      // 而这个条目在 manifest 里仍然存在，恢复默认等于又显示出来了。
      const r = await g.status.applyAll(() => ({
        id: f.statusId,
        patch: { text: f.defaultText, tooltip: `${f.title} 已在设置里关闭`, visible: false, disabled: true },
      }));
      missed += r.failed;
    }
    return missed;
  };

  /**
   * 首屏：只铺**被关掉的** feature。
   *
   * 开着的 feature 不用管——manifest 的 contributes.ui.inputStatus 已经声明了它的
   * 默认态（text/tooltip），宿主会自己渲染。启动时再写一遍同样的默认值，
   * 既是纯粹的重复劳动，又正好撞上这个竞态：
   *
   *   reload 时序（实测）——
   *     21:03:57.255  ui contribution withdrawn        ← 旧贡献被撤
   *     21:03:57.382  plugin started (product)          ← 新进程起来
   *     21:03:57.557  failed to load: has no declared input status item probe
   *
   * 服务端在写入时校验贡献表，而新进程的贡献表此刻还没重新注册，写入被拒，
   * 而这个 reject 会把整个 App 判为加载失败。所以首屏能不写就不写。
   *
   * 被关掉的功能是例外：它的 manifest 默认态是错的（会显示出来），
   * 必须覆盖。所以只有这一种情况需要在启动期写。
   */
  const paintStartup = async () => {
    const offIds = g.registry.all().filter((f) => !g.registry.isEnabled(f, cfgNow())).map((f) => f.id);
    if (offIds.length === 0) {
      log("info", "首屏无需写入：所有功能都开着，交给 manifest 默认态");
      return true;
    }
    // 首写延迟是实测定的：S0 阶段用 1200ms 写状态是成功的，0ms 则稳定撞上
    // “贡献表尚未重新注册”的窗口。数字本身是经验值，稳定性靠后面的重试兜底。
    await new Promise((r) => setTimeout(r, 1200).unref?.());
    return paintWithRetry(0, offIds);
  };

  /**
   * 启动期重试。首屏写入可能跑在贡献表重新注册之前（见 paintStartup 的时序说明），
   * 这里用重试而不是把延迟调大：延迟取多少是猜的，而“写入被拒就再试”是可观测的事实。
   */
  const PAINT_RETRY_DELAYS = [2000, 4000, 8000];
  /**
   * 同时只允许一条重试链在跑。
   *
   * 没有闸门时：某个会话持续写不进去（比如它已经被关掉但仍在 sessions 里），
   * 每一轮重试 missed>0 → 再挂一条链；而本轮速度 8s 一次、缓存 60s 一次、
   * 用户点击又一条 —— n 个失败源 × 3 层退避，链与链重叠。
   * 每条链的每次重试都是一次**全量 paint**，于是写入压力大 → 更多被拒 → 更多重试，
   * 标准的正反馈。
   *
   * 去重帮不上忙：去重只在**写入成功后**才生效，失败路径上一次都没写进去。
   * 所以“重试的代价接近零”这个前提在失败时不成立。
   *
   * 闸门只合并**同时在跑**的链，不阻止后续触发 —— 新一轮 poll 仍会发起新的重试，
   * 那样才能自愈。合并的是重叠，不是恢复能力。
   */
  let retryChainRunning = false;
  async function paintWithRetry(attempt = 0, onlyIds = null) {
    let missed = 0;
    try {
      missed = await paint(onlyIds);
    } catch (err) {
      // paint 内部已经逐条 catch 过，走到这里说明问题在 paint 本身而不是单条写入。
      // 吞掉它：首屏铺不上不该让整个 App 加载失败，那等于功能全灭。
      log("error", `状态行铺设异常：${err?.stack || err?.message || err}`);
      return false;
    }
    // 成功也要出声。首屏写入是本 App 最容易静默失败的一段：
    // 不打这一行，“没报错”与“压根没跑”在日志里长得一模一样。
    log(
      missed === 0 ? "info" : "warn",
      `状态行铺设完成，缺 ${missed} 条` + (onlyIds ? `（目标：${onlyIds.join(",")}）` : "（全部）"),
    );
    if (missed === 0) return true;
    if (attempt >= PAINT_RETRY_DELAYS.length) {
      log("error", `状态行铺设仍不完整（缺 ${missed} 条）`);
      return false;
    }
    // 已经有链在跑就不再挂新的：重叠的链只会互相加压。
    if (retryChainRunning) {
      log("info", `已有重铺在进行，本次不重复挂链（缺 ${missed} 条）`);
      return false;
    }
    retryChainRunning = true;
    const t = setTimeout(() => {
      // 认代号而不是认 disposed：旧代的重试必须永远停，
      // 哪怕新一代已经把 disposed 复位了。
      if (myGen !== g.gen) { retryChainRunning = false; return; }
      Promise.resolve(paintWithRetry(attempt + 1, onlyIds))
        .catch((err) => log("warn", `重铺失败：${err?.message || err}`))
        .finally(() => { retryChainRunning = false; });
    }, PAINT_RETRY_DELAYS[attempt]);
    t.unref?.();
    return false;
  }

    // ── 4b. 订阅轮次事件：用宿主给的精确边界算速度 ──────────────
  //
  // 为什么值得这么做：早先的“等 20 秒没动静就算一轮结束”是我拿轮内间隔 p95 硬凑的，
  // 而轮次切分用的“30 秒间隔”也��猜的。宿主其实直接给 `turn_start` / `turn_end`，
  // 边界是精确的 —— 实测 v2 App 能订阅（SDK 副本里没写这几个类型，但宿主比副本新）。
  //
  // 好处不只是准：turn_end 一到就能出数，不用等；也不用常驻轮询台账。
  //
  // message_start/end 也订上：它们比 turn 更细，一轮里每次模型调用各一对，
  // 用来在轮次进行中也能给个实时读数。取不到就不显示，不拿猜的值充数。
  try {
    const speedOff = await sdk.bus.subscribe(
      (event) => {
        try {
          // 旧代的事件回调必须在做**任何事之前**先认代号。
          // 它写的是 speed 的模块级变量（那是新代也在用的），
          // 不挡住的话就是旧代在替新代记事。
          if (myGen !== g.gen) return;
          const type = event?.type;
          if (type === "turn_start") { noteTurnStart(); return; }
          if (type === "llm_usage") {
            const entry = event?.entry;
            noteUsageEvent(entry);
            // 这条事件带 sessionId，意味着该会话刚跑过模型 ——
            // 也就意味着用户是从**那个**会话的输入框发出的，
            // 文本已经提交，撤销挂起不再成立，按钮该复位了。
            // 全程不需要知道“前台是哪个会话”——那正是当初停用监视器的原因。
            if (entry?.attribution?.sessionId) {
              try { noteSessionCommitted(entry.attribution.sessionId); } catch { /* 忽略 */ }
            }
            return;
          }
          if (type === "turn_end") {
            const got = noteTurnEnd();
            // 只有真算出数才重画：没有事件就退到账本启发式，不添乱。
            if (got) paintWithRetry(0, ["speed"]).catch(() => {});
          }
        } catch (err) {
          // 事件回调是同步入口，抛出去会击穿宿主的事件派发
          log("warn", `速度事件处理失败：${err?.message || err}`);
        }
      },
      { types: ["turn_start", "turn_end", "llm_usage"] },
    );
    g.offSpeedEvents = () => { try { speedOff?.(); } catch { /* 忽略 */ } };
    log("info", "已订阅轮次事件（速度计时改用宿主精确边界）");
  } catch (err) {
    // 宿主不给这些事件时，一切照旧走账本启发式，不影响其他功能。
    log("warn", `轮次事件订阅失败，速度改用账本估算：${err?.message || err}`);
  }

  // ── 4. 启动会话跟踪 + 首屏铺设 ─────────────────────────────
  // 会话没了，feature 上那份 per-session 状态也得跟着清。
// 不清的话新会话会先继承旧会话的缓存命中率，屏幕上会看到别的对话的数。
const gen = await g.status.start(
  () => paintStartup(),
  (sessionId) => {
    for (const f of g.registry.all()) {
      if (f.__perSession) f.__perSession.delete(sessionId);
      // feature 自己按会话存的缓存（与 __perSession 无关的那些）也得清。
      // speed 的 lastGood / cache 就是这种：不清会无限增长，
      // 且会话 id 复用时会把远古那一轮的数当成新会话的。
      try {
        f.dropSession?.(sessionId);
      } catch (err) {
        log("warn", `功能 ${f?.id} 清理会话缓存失败：${err?.message || err}`);
      }
    }
  },
);
  // ── 5. 发布设置页目录 ─────────────────────────────────────
  // 设置页是 iframe，它不认识 lib/registry.js 里的任何东西。
  // 后端是 feature 的唯一真相源，所以把目录写进存储，前端只读目录 + 写配置。
  // 目录里只放前端渲染需要的东西：id / 标题 / 说明 / 排序 + 各 feature 的 describe()。
  // **不放逻辑、不放回调** —— 前端拿到的是一个纯数据快照。
  //
  // 对**所有** feature 调 describe()，不管它启没启用：
  // 功能关掉了设置页里还得能再打开，否则关了就是永久关闭。
  const allFeatures = g.registry.all();
  const catalog = { features: [] };
  for (const [i, f] of allFeatures.entries()) {
    let extra = null;
    try {
      extra = (await f.describe?.(ctxFor(f))) ?? null;
    } catch (err) {
      log("warn", `feature ${f.id} 的 describe 失败，设置页将不显示它的配置项：${err?.message || err}`);
    }
    // defaultEnabled 是**缺省策略**，不是当前状态。
    //
    // 这两者很容易混。传当前值看着最保险，实际是个**快照** ——
    // 发布之后配置再变它也不会更新，于是设置页读到的永远是 App 启动那一刻的状态。
    // 缺省策略是静态的、不随配置变，传它就不会过期。
    // 前端拿它做 features[id] ?? defaultEnabled：「??」不是业务判断，
    // 它只负责“没配过就退到缺省”，因此不会像 `!== false` 那样猜错。
    catalog.features.push({
      id: f.id,
      title: f.title,
      // 说明文字：给人看的。以前这里直接显示 f.id（quota/polisher），
      // 等于把代码变量名摆给用户看——一眼看不出这东西是干什么的。
      blurb: f.blurb || null,
      order: i,
      defaultEnabled: g.registry.isEnabled(f, { features: {} }),
      extra,
    });
  }
  try {
    await sdk.storage.global.set("features", catalog);
  } catch (err) {
    log("warn", `feature 目录写入失败，设置页将读不到可配置项：${err?.message || err}`);
  }

  // ── 6. 启动启用的 feature ──────────────────────────────────
  /**
   * feature 的 ctx：它想改自己的状态行就调 setText / setTooltip，
   * 不直接碰 sdk.inputStatus —— 绕开 status-host 就会失去去重和完整覆盖语义。
   */
  // 用 function 声明而不是 const 箭头：catalog 那一步要调它，
  // 而 const 在声明之前调用会撞 TDZ（Cannot access before initialization）。
  // 箭头函数改成 function 声明后会被提升，顺序就不再是隐式依赖。
  function ctxFor(feature) {
    return {
    sdk,
    config: g.config,
    status: g.status,
    values,
    /**
     * “我现在还开着吗”——读**最新**配置，不读启动时那份。
     *
     * 存在的理由：stop() 只能阻止**未来**的回调，已经在飞的请求拿不回。
     * 用户关掉额度、而上一次取数刚好在这时返回，paint 就会写 visible:true，
     * 于是“关掉的额度自己又冒出来了”。异步回调写状态前先问一句，
     * 是最后一道保险。
     */
    isEnabled: () => g.registry.isEnabled(feature, g.config.peek() || {}),
    log: (level, msg) => log(level, `[${feature.id}] ${msg}`),
    /** 一次改完多个字段。单字段调用会各触发一轮全量 paint。 */
    setStatus: async ({ text, tooltip, disabled }) => {
      if (text !== undefined) feature.__text = text;
      if (tooltip !== undefined) feature.__tooltip = tooltip;
      if (disabled !== undefined) feature.__disabled = disabled;
      return paintWithRetry(0, [feature.id]);
    },
    setText: async (text) => {
      feature.__text = text;
      return paintWithRetry(0, [feature.id]);
    },
    setTooltip: async (tooltip) => {
      feature.__tooltip = tooltip;
      return paintWithRetry(0, [feature.id]);
    },
    /**
     * 只写**某一个会话**的状态行。
     *
     * 为什么需要它：状态行是按会话分开的，但 `feature.__text` 只有一个。
     * 写全局值的话，所有会话会显示同一个数 —— 缓存命中率按“当前对话”算时
     * 这就是错的：你在 A 对话的数字不能出现在 B 对话的输入栏上。
     *
     * **不触发重画。** 这里只填值，画由调用方在全部填完后自己调一次
     * `repaintAll()`。早先的实现是每个会话都调一次 paintWithRetry，
     * 11 个会话就是 11 次全量重画 —— 而 paintWithRetry 内部会等前一轮完成，
     * 于是 N 个并发请求互相踩，表现为日志里刷「缺 11 条」，
     * 状态行一条也没铺上。写入是幂等的，没必要为每个会话重画一次。
     */
    setStatusFor: (sessionId, { text, tooltip, disabled } = {}) => {
      const sid = String(sessionId || "").trim();
      // 拿不到 sessionId（首页进来、快捷键入口）时直接不写：
      // 宁可这一格不更新，也不要让别的会话的数串过来。
      if (!sid) return 0;
      if (!feature.__perSession) feature.__perSession = new Map();
      const slot = feature.__perSession.get(sid) || {};
      if (text !== undefined) slot.text = text;
      if (tooltip !== undefined) slot.tooltip = tooltip;
      if (disabled !== undefined) slot.disabled = disabled;
      feature.__perSession.set(sid, slot);
      return 1;
    },
    /** 清掉某个会话的覆盖值（会话关闭/归档时调用，避免旧值诈尸）。 */
    clearStatusFor: (sessionId) => {
      const sid = String(sessionId || "").trim();
      if (sid && feature.__perSession) feature.__perSession.delete(sid);
    },
    /** 填完所有会话的值后调一次。 */
    repaintAll: () => paintWithRetry(0, [feature.id]),
    };
  }
  // ctx 必须带 values：注册表判定功能开关靠的就是它。
  // 丢了它不会报错，只会让 undefined?.features?.quota !== false 恒为 true，
  // 于是**所有功能都被当成开启** —— 用户关了的东西自己回来了。
  const ctx = { values, features: {} };
  for (const feature of g.registry.all()) ctx.features[feature.id] = ctxFor(feature);
  // 存进单例：下一代启动时要用它去 stopAll 上一代的功能。
  // 不存的话只能传 undefined，feature.stop(ctx) 里拿不到自己的 ctx。
  g.ctx = ctx;

  // 启动路径上的代号守卫。
  //
  // 上面 await 了 status.start()，那中间已经让出过控制权。若此时又发生了一次重载，
  // 新一代已经接管了宿主，而本代如果继续往下走，会**用新代已经接手的宿主**
  // 把功能启起来 —— 于是同一个功能有两代实例在跑、各自拿着不同的定时器，
  // 而拆卸段只会去停 g.ctx 里那个（本代还没赋值，拿到的是 null）。
  //
  // 所以每个 await 之后都要确认自己还是当前代，不是就当场收工。
  if (myGen !== g.gen) {
    log("warn", "启动途中被新一轮重载取代，本代不再继续启动功能");
    return;
  }

  const results = await g.registry.startAll(ctx);
  if (myGen !== g.gen) {
    // 启到一半被取代：把刚启的收回去，不给下一代留孤儿。
    try { await g.registry.stopAll(ctx); } catch { /* 忽略 */ }
    return;
  }
  log(
    "info",
    `已启动 ${results.started.length} 个功能` +
      (results.failed.length ? `，失败 ${results.failed.length} 个：${results.failed.map((f) => f.id).join(", ")}` : ""),
  );

  // ── 7. 配置变了就重铺 ──────────────────────────────────────
  // 设置页改的是同一个存储，改完会通知这里，立刻生效。
  // 不判断"变的是不是跟我有关"—— 判断要一份字段归属表，
  // 而那份表在各个 feature 手里，汇总成本比一次重铺高得多。
  const IGNORED_CFG_KEYS = ["features"]; // feature 目录是自己写的，写它不该触发重铺
  let repaintTimer = null;
  const scheduleRepaint = (keys) => {
    if (myGen !== g.gen) return;
    const list = Array.isArray(keys) ? keys.map(String) : [];
    // 订阅者自己写的也会触发。启动时发布 feature 目录就会走这里，
    // 再触发一次重铺，而那时候状态行可能还没铺好 —— 自己踩自己的尾巴。
    if (list.length && list.every((k) => IGNORED_CFG_KEYS.some((ig) => k.includes(ig)))) return;
    if (repaintTimer) clearTimeout(repaintTimer);
    // 合并突发写入：连着点好几个开关时不必重铺好几次。
    repaintTimer = setTimeout(async () => {
      repaintTimer = null;
      const next = (await g.config.read(true)) || {};
      const before = g.registry.enabled(values).map((f) => f.id);
      // **整份**配置都要同步，不只是开关那一项。
      // 以前只跟 features，勾选那一项改动后 values 里还是旧的，
      // feature 拿着旧值重算，自然算不出区别。
      for (const k of Object.keys(values)) delete values[k];
      Object.assign(values, next);
      const after = g.registry.enabled(values).map((f) => f.id);
      // 开关变了要**真的启停**，而不只是重新画一遍。
      //
      // 只重画的后果是：被关掉的功能没收到 stop()，它的定时器照跑、照取数、
      // 照把自己写回输入栏 —— 关掉的额度过几分钟自己又冒出来。
      const toStop = before.filter((id) => !after.includes(id));
      const toStart = after.filter((id) => !before.includes(id));
      const sync = (async () => {
        for (const id of toStop) await g.registry.stopOne(g.registry.get(id), ctx);
        for (const id of toStart) await g.registry.startOne(g.registry.get(id), ctx);
        if (toStop.length || toStart.length) {
          log("info", `开关变更：停 ${toStop.join(",") || "无"}，启 ${toStart.join(",") || "无"}`);
        }
      })();
      // 重画失败会自己进入重试链。
      await Promise.all([sync, paintWithRetry()]);

      // 最后一步：让还在开着的功能**用新配置重算自己的输出**。
      //
      // 这一步不能省。状态行上的文字是 feature 自己存着的，重画只是把那个
      // 旧值再写一遍 —— 内容一样就被去重挡掉，用户看到的就是“改了没反应”。
      // 开关之所以能动，是因为 visible 从 true 翻到 false，那是真变化；
      // 勾选只改“写哪几个字”，不重算就一直停在上一版。
      //
      // 放在重画之后：先让状态行把位置摆对，feature 再往里写新内容。
      for (const f of g.registry.enabled(cfgNow())) {
        if (typeof f.onConfigChange !== "function") continue;
        try {
          await f.onConfigChange(ctx.features[f.id] ?? ctx);
        } catch (err) {
          log("warn", `${f.id} 按新配置重算失败：${err?.message || err}`);
        }
      }
    }, 150);
    repaintTimer.unref?.();
    log("info", `检测到设置改动：${list.join(",")}`);
  };

  try {
    // 存成可调用的退订函数：下一代启动时会调它。
  // 早先是 `g.config.__onChanged = sdk.storage.global.onChanged(...)`，
  // 存了但全项目没有任何地方读它 —— 热重载 N 次就挂 N 个监听，
  // 之后点一次开关同时触发 N 遍重铺，而且每一遍都是旧代闭包。
  let offConfigChanged = null;
  try {
    offConfigChanged = sdk.storage.global.onChanged(scheduleRepaint);
  } catch (err) {
    log("warn", `配置监听订阅失败：${err?.message || err}`);
  }
  g.onConfigChanged = () => {
    try { offConfigChanged?.(); } catch { /* 忽略 */ }
    offConfigChanged = null;
  };
  } catch (err) {
    // 订阅失败只影响"改完立刻生效"，不影响已加载的初始状态。
    log("warn", `设置变更监听不可用，改配置需重载才生效：${err?.message || err}`);
  }

  // ── 8. 工具：输入栏条目的点击入口 ──────────────────────────
  // 每个功能在 manifest 里把自己的 toolName 指向这里，并用 args 声明触发什么动作。
  // 工具层不猜每个功能想干什么 —— 它只负责把 args 路由到 feature 自己注册的处理函数。
  const toggleFeature = async (feature, on) => {
    try {
      await g.config.setFeatureEnabled(feature.id, on);
    } catch (err) {
      // 写入失败是真实故障，必须回给用户而不是接着铺状态行 ——
      // 铺了但配置没存，下次重载就变回去，用户会以为开关坏了。
      return { content: [{ type: "text", text: `写入配置失败：${err?.message || err}` }] };
    }
    values.features = (g.config.peek() || {}).features;
    await paintWithRetry();
    return {
      content: [
        { type: "text", text: `${feature.title} 已${on ? "开启" : "关闭"}，已同步 ${g.status.sessionIds().length} 个会话。` },
      ],
    };
  };

  const tool = {
    name: TOOL_NAME,
    description:
      "输入栏条目的点击入口。每个功能在 manifest 里把 toolName 指向这里，用 args 声明动作。" +
      "action=cycle 由 feature 自己定义行为；action=toggle 开关该功能。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "动作。cycle / toggle。" },
        featureId: { type: "string", description: "功能 id。" },
        enable: { type: "boolean", description: "toggle 时是否开启，默认 true。" },
      },
      required: [],
      additionalProperties: false,
    },
    execute: async (args) => {
      const action = String(args?.action || "toggle").trim();
      const featureId = String(args?.featureId || "").trim();
      const feature = g.registry.get(featureId);
      if (!feature) {
        const known = g.registry.all().map((f) => f.id).join(", ");
        return { content: [{ type: "text", text: `没有这个功能：${featureId || "(空)"}。当前有：${known}` }] };
      }
      if (action === "cycle") {
        const handler = FEATURE_ACTIONS[featureId]?.cycle;
        if (!handler) return { content: [{ type: "text", text: `功能 ${featureId} 没定义 cycle 动作` }] };
        const r = await handler(ctx.features[featureId]);
        return { content: [{ type: "text", text: `${feature.title} → ${r}` }] };
      }
      if (action === "toggle") {
        // 这一支早先是死代码：`return toggleFeature(...)` 写在上一句 return 之后，
        // 永远到不了。后果是点状态行想开关功能，拿到的是“功能 xx 没有动作 toggle”，
        // 而 toggleFeature 里那套“写入失败要回滚并告知用户”的保险也从未生效过。
        return toggleFeature(feature, args?.enable !== false);
      }
      // 点击类动作需要知道是哪个会话触发的（撤销态、状态行都按 session 走）。
      const fctx = ctx.features[featureId];
      // 两个字段都认，顺序有意义：
      //   sessionId    —— 宿主若直接给就用它
      //   sessionPath  —— SDK 契约里声明的是这个，没有它就得反查
      //
      // 早先只读 args.context.sessionId，而 SDK 的 HANA_PLUGIN_TOOL_EXECUTE_CONTEXT_V2_MEMBERS
      // 里只有 callToken/document/messageId/messageText/sessionPath —— **没有 sessionId**。
      // 于是这里恒为 ""，polisher 永远走 NO_SESSION 分支，setState 第一行就 return，
      // **整条 per-session 通路是死的**：点「优化」真的改写了输入框，
      // 但按钮永远停在 🪄，并且不报任何错。
      //
      // （别拿“类型定义里没有”当结论——那份 SDK 副本是旧的，轮次事件已经证过。
      //   所以这里两个都试：给了哪个用哪个，都没给才报出来。）
      const rawCtx = args?.context || {};
      const sid = String(rawCtx.sessionId || "").trim()
        || g.status?.sessionIdByPath?.(rawCtx.sessionPath)
        || "";
      if (!sid) {
        // 查不到就必须出声。静默降级成“无会话”的后果是：
        // 功能看上去能用（内容真被改写了），但状态写不出去、撤销态丢失。
        // 这种“做了一半”的失败最难查，必须在日志里留痕。
        log("warn", `工具 ${featureId}/${action} 拿不到会话标识`
          + `（context 字段：${Object.keys(rawCtx).join(",") || "无"}），`
          + `状态行与撤销态将无法按会话写入`);
      }
      fctx.toolSessionId = sid;
      const handler = FEATURE_ACTIONS[featureId]?.[action];
      if (!handler) {
        const known = Object.keys(FEATURE_ACTIONS[featureId] || {}).join(", ");
        return { content: [{ type: "text", text: `功能 ${featureId} 没有动作 ${action}。已有：${known}` }] };
      }
      const r = await handler(fctx);
      return { content: [{ type: "text", text: String(r) }] };
    },
  };
  try {
    await sdk.tools.register(tool);
  } catch (err) {
    log("warn", `工具注册失败：${err?.message || err}`);
  }

  log("info", `已加载，生成代 ${gen}，跟踪会话 ${g.status.size()} 个`);
});
