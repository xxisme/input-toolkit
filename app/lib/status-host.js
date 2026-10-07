/**
 * lib/status-host.js —— 输入栏状态的唯一出口
 *
 * 整个 App 只通过这一层写 `sdk.inputStatus`。理由不是"分层好看"，是三条实测出来的硬约束：
 *
 * 1) **set 是完整覆盖，不是增量更新。** 省略字段 = 恢复 manifest 声明值，不是「保持原样」。
 *    这是最容易误解的一条：想把 tooltip 改掉而只传 {text}，tooltip 会连带恢复默认。
 *    所以本层的 apply() 要求调用方把四个字段都给全，宁可啰嗦也不让省略语义咬人。
 *
 * 2) **override 不持久。** 宿主重启后全部丢失，必须重建。
 *    重建靠两条来源：session:list 补齐启动前就存在的会话，session_created 事件接新建的。
 *    只靠事件的话，宿主重启时正在开着的那批会话会永远停在空白态。
 *
 * 3) **没有 per-App 条目上限。** 宿主保留放得下的前缀，放不下的从输入栏上方 `…` 条带露出。
 *    功能会越加越多，溢出是必然 —— 这也是「每种功能可选开关」必须存在的原因：
 *    开关同时承担可见性和容量管理两个职责。
 *
 * 还有一个容易漏的：session fork 之后 sessionPath 会变。旧 path 上残留的状态
 * （告警已读、手动关过）如果不跟着迁移，会在新 path 上原样复活或永远打不开。
 */

const APP_ID = "input-toolkit";
/** 宿主补写活跃会话时必须带的两个参数。缺了就只看得见本 App 自己的会话，返回空数组。 */
const SESSION_LIST_ARGS = { scope: "all", lifecycle: "active" };

/**
 * 写入结果三态。
 *
 * 为什么要三态而不是布尔：早先 `false` 同时表示“无需写”和“写失败”，
 * 调用方把两者一起计成 missed。结果是稳定不变的状态会持续报警 ——
 * 假警报会把真失败淹掉，而“失败要永久可见”正是靠这条日志。
 */
const APPLIED = { WRITTEN: "written", UNCHANGED: "unchanged", FAILED: "failed" };

/**
 * 去重表的键：**必须是 sessionId + 条目 id**。
 *
 * 早先只用 sessionId，一个槽。而一个会话有多条状态行（本项目 4 个功能），
 * paint 逐个 feature 写，写完 quota 立刻被 cachehit 覆盖 ——
 * 于是“上次写的是哪个条目”根本留不住，去重形同失效：每轮把四条全写一遍。
 * 而 paintWithRetry 的注释写的是“paint 幂等（status-host 去重会跳过无变化的写入），
 * 所以重试的代价接近零”——那个前提并不成立。
 *
 * 分隔符用 NUL：sessionId 与条目 id 都是宿主给的，拼起来可能撞上分隔符。
 */
const pushedKey = (sessionId, id) => `${sessionId}\u0000${id}`;

export function createStatusHost(sdk) {
  /** sessionId -> sessionPath */
  const sessions = new Map();
  /** `${sessionId}\0${条目id}` -> 上次写入的 fingerprint，用于跳过无变化的重写 */
  const lastPushed = new Map();

  /**
   * 清掉某个会话的所有去重记录。
   *
   * 不能用 lastPushed.delete(sessionId) —— 键已经变成 `${sessionId}\0${id}`，
   * 那个删除等于什么都没删：会话关闭后它的去重记录永久留着，内存无界增长，
   * 且 fork 后同 id 重开时会被旧指纹影响判断。
   *
   * 注意：**必须定义在 createStatusHost 内部**。早先放到模块作用域，
   * 访问不到这里的 lastPushed，运行时 ReferenceError 被事件处理器的 catch
   * 吞成「事件处理失败：lastPushed is not defined」——
   * 守卫在、函数在、调用也在，唯一的错是它不在能看见数据的那个作用域里。
   * 症状是 fork 后去重不失效（因为从来没清成功过）。
   */
  const forgetSession = (sessionId) => {
    if (!sessionId) return;
    const prefix = `${sessionId}\u0000`;
    for (const k of [...lastPushed.keys()]) {
      if (typeof k === "string" && k.startsWith(prefix)) lastPushed.delete(k);
    }
  };
  /** 宿主订阅句柄，stop() 时释放 */
  let unsubscribe = null;
  /**
   * 代际号。每次 start() 自增。本代的任何异步回调在动手前都要核对自己没过期，
   * 否则 App 重载后，上一代的迟到回调会往新一代的状态里写 —— 而那批会话可能已经不存在了。
   */
  let gen = 0;
  let running = false;

  function log(level, msg) {
    // logger 自己也可能不可用（App 刚起来、正在重载），包一层免得日志把主流程带崩。
    // 注意是 sdk.logger[level] 不是 sdk[level]，后者恒为 undefined。
    try {
      sdk?.logger?.[level]?.(`[${APP_ID}] ${msg}`);
    } catch {
      /* 忽略 */
    }
  }

  /** 四个字段是否构成一次可比较的完整状态。 */
  function fingerprint(p) {
    return JSON.stringify([p.text ?? null, p.tooltip ?? null, p.visible ?? null, p.disabled ?? null]);
  }

  function track(sessionId, sessionPath) {
    if (typeof sessionId !== "string" || !sessionId.trim()) return false;
    if (typeof sessionPath !== "string" || !sessionPath.trim()) return false;
    const prev = sessions.get(sessionId);
    if (prev && prev !== sessionPath) {
      // fork：路径变了。旧路径下的记忆必须清掉，否则会在新路径上诈尸。
      forgetSession(sessionId);
      log("info", `会话 ${sessionId} 路径变更，旧路径状态已失效`);
    }
    sessions.set(sessionId, sessionPath);
    return true;
  }

  /**
   * 会话消失时的回调。
   *
   * 为什么要存成模块级变量而不是靠参数传：untrack() 定义在 createStatusHost
   * 里，而回调是 start(onReady, onSessionGone) 的形参 —— 两者不在同一条闭包链上。
   * 早先 untrack 直接引用 onSessionGone，运行时是 ReferenceError，被 catch
   * 吞成一行 warn（真机日志里已经刷过：「清理会话状态失败：onSessionGone is not defined」），
   * 于是**清理从来没执行过一次**。后果是关掉会话 A 再开 B，B 会先显示
   * A 的旧命中率 —— 正是本文件头注释反复承诺「绝不会发生」的那个场景。
   */
  let onSessionGoneHook = null;

  function untrack(sessionId) {
    if (!sessionId) return;
    sessions.delete(sessionId);
    forgetSession(sessionId);
    // 会话没了，它那份 per-session 状态也必须清掉。
    // 不清的话：关掉 A 打开 B，B 若用按会话区分的 feature（比如缓存命中率），
    // 会先继承 A 的旧值再被新数据覆盖 —— 中间那一瞬显示的是别的对话的数。
    try {
      onSessionGoneHook?.(sessionId);
    } catch (err) {
      log("warn", `清理会话状态失败：${err?.message || err}`);
    }
  }

  const host = {
    /** 当前已跟踪的会话 id 快照。返回副本，调用方遍历时不受事件影响。 */
    sessionIds() {
      return [...sessions.keys()];
    },

    /**
     * sessionPath → sessionId 反查。
     *
     * 为什么需要：宿主注入给工具的上下文字段里，SDK 契约只声明了
     * `sessionPath`，**没有** `sessionId`。而状态行、挂起态、逐会话缓存
     * 全都以 sessionId 为键 —— 拿不到它，per-session 那整条通路就是死的，
     * 而且是**静默**地死：点「优化」会真的改写输入框，但按钮永远不变成 ↶。
     *
     * （这份 SDK 副本是旧的，宿主比它新——轮次事件已经证过这一点。
     *   所以两个字段都认：宿主给 sessionId 就用，给 sessionPath 就反查。
     *   都不给时返回空串，调用方负责出声，不许默默算作“无会话”。）
     */
    sessionIdByPath(sessionPath) {
      const p = String(sessionPath || "").trim();
      if (!p) return "";
      for (const [id, path] of sessions) {
        if (path === p) return id;
      }
      return "";
    },

    size() {
      return sessions.size;
    },

    /**
     * 写一条状态到某会话。
     *
     * @param {string} sessionId
     * @param {string} id      对应 manifest contributes.ui.inputStatus[].id
     * @param {{text?: string, tooltip?: string, visible?: boolean, disabled?: boolean}} patch
     *        **四个字段都要给全**：省略任何一个都等于把它恢复成 manifest 声明值，不是保持不变。
     * @param {{force?: boolean, gen?: number}} [options] force=true 时跳过去重
     * @returns {Promise<boolean>} 是否真的写了
     */
    async apply(sessionId, id, patch, options = {}) {
      const myGen = options.gen ?? gen;
      if (!running || myGen !== gen) return APPLIED.FAILED;
      if (typeof sessionId !== "string" || !sessionId.trim()) return APPLIED.FAILED;
      if (!sdk?.inputStatus?.set) {
        log("warn", "sdk.inputStatus.set 不可用，输入栏状态无法写入");
        return APPLIED.FAILED;
      }
      // 显式补齐为 null 而非留空：让 fingerprint 的形状稳定，
      // 避免这次传 {} 下次传 {text:undefined} 被判成"有变化"而空写一通。
      const full = {
        text: patch?.text ?? null,
        tooltip: patch?.tooltip ?? null,
        visible: patch?.visible ?? null,
        disabled: patch?.disabled ?? null,
      };
      if (!options.force) {
        const prev = lastPushed.get(pushedKey(sessionId, id));
        if (prev && prev.fp === fingerprint(full)) return APPLIED.UNCHANGED;
      }
      // 先占位，**再** await。
      //
      // 早先是 await 成功之后才写 lastPushed。两次并发 paint（例：quota 的
      // repaintAll 与配置变更触发的重铺）会同时读到旧指纹、都判定“需要写”，
      // 然后各自 await；A 先读到后写、B 后读到后写，A 的**旧值可能后落地**，
      // 状态行回退一版且下一轮未必纠正。
      //
      // 写入幂等掩盖了“重复写”，但掩盖不了“顺序颠倒”——所以这里改成先占位：
      // 后来者看到指纹已被占，直接判 UNCHANGED 走人。
      const fp = fingerprint(full);
      const key = pushedKey(sessionId, id);
      lastPushed.set(key, { fp, inflight: true });
      try {
        await sdk.inputStatus.set({ sessionId, id, ...full });
        if (myGen !== gen) {
          // 世代已变：这条写入的归属不可信，把占位撤掉，
          // 否则新代会以为“这个值已经推过了”而跳过重写。
          if (lastPushed.get(key)?.fp === fp) lastPushed.delete(key);
          return APPLIED.FAILED;
        }
        lastPushed.set(key, { fp });
        return APPLIED.WRITTEN;
      } catch (err) {
        // 写失败就不能占着坑：撤掉占位，下一轮还会重试。
        // 不撤的话这个槽位会被永久当成“已推送”，而实际什么都没写。
        if (lastPushed.get(key)?.fp === fp) lastPushed.delete(key);
        log("warn", `写 ${id} 失败（session=${sessionId}）：${err?.message || err}`);
        return APPLIED.FAILED;
      }
    },

    /**
     * 撤回一条状态的动态覆盖，回到 manifest 声明的形态。
     * 用于功能被关闭时 —— remove 是"恢复默认"，不是"隐藏"，隐藏要走 apply({visible:false})。
     */
    async reset(sessionId, id, options = {}) {
      const myGen = options.gen ?? gen;
      if (!running || myGen !== gen) return false;
      if (!sdk?.inputStatus?.remove) return false;
      try {
        await sdk.inputStatus.remove({ sessionId, id });
        lastPushed.delete(pushedKey(sessionId, id));
        return true;
      } catch (err) {
        log("warn", `撤回 ${id} 失败（session=${sessionId}）：${err?.message || err}`);
        return false;
      }
    },

    /**
     * 对所有已跟踪会话跑一次。返回值是 `{written, total}`：
     * total 是目标会话数，written 是实际写入数。两者不等说明有条目没铺上，
     * 调用方据此决定要不要重试。
     * 传入的回调必须是无副作用的纯计算：它会对 N 个会话各跑一次。
     */
    async applyAll(fn, options = {}) {
      const myGen = options.gen ?? gen;
      const ids = [...sessions.keys()];
      // 统计口径：**只有真失败算 missed**。
      //
      // 早先 apply 用 false 同时表示“写成功了但内容没变”和“写失败了”，
      // 两者一起被计成 missed，于是稳定不变的状态（例如本轮速度长期是占位符）
      // 会持续报 “缺 10 条” 并升级成 ERROR —— 每 8 秒一条。
      // 后果比噪音严重：真失败会被这堆假警报淹没，而“失败要永久可见”正是靠这条日志。
      let failed = 0;
      let written = 0;
      // 并发写。早先是逐会话 await，一次全量铺 = 功能数 × 会话数 次**串行** RPC。
      // 16 会话 × 4 功能 = 64 次；单次 50ms 就是 3.2s，200ms 就是 12.8s ——
      // 而工具调用会同步等这个 promise，用户看到的是“操作超时”，
      // 但配置其实写成功了、状态行其实也铺上了。重试一次就是再来一轮。
      //
      // sdk.inputStatus.set 本身是幂等的（同一 sessionId + id 整体替换），
      // 并发不会互相覆盖。lastPushed 的读写在同一 tick 内完成，不跨 await。
      const results = await Promise.all(ids.map(async (sessionId) => {
        if (myGen !== gen) return APPLIED.FAILED;
        let patch = null;
        try {
          patch = await fn(sessionId);
        } catch {
          return APPLIED.FAILED;
        }
        if (!patch) return APPLIED.UNCHANGED;
        return host.apply(sessionId, patch.id, patch.patch ?? patch, { gen: myGen, force: options.force });
      }));
      for (const r of results) {
        if (r === APPLIED.WRITTEN) written += 1;
        else if (r === APPLIED.FAILED) failed += 1;
      }
      return { written, failed, total: ids.length, unchanged: ids.length - written - failed };
    },

    /**
     * 启动：订阅会话事件 + 补齐存量会话，然后调用 onReady 把首屏状态铺一遍。
     * 延后一拍才回调 —— 贡献表要等 apply 落定才注册，立刻写状态会被服务端拒。
     * @param {() => void} [onReady]
     * @param {(sessionId: string) => void} [onSessionGone] 会话关闭/删除时的回调
     * @returns {number} 本代编号，调用方拿它做后续异步的身份核验
     */
    async start(onReady, onSessionGone) {
      gen += 1;
      const myGen = gen;
      running = true;
      // 去重表必须在启动时清空。
      //
      // 文件头自己写了：override 不持久，宿主重启后状态行回到 manifest 声明值，
      // 必须靠 session:list 重建。而 lastPushed 早先只在 stop() 里清，
      // track() 在 id 与 path 都没变时也不清。
      //
      // 于是只要宿主在 App 实例存活期内丢了一次 override（贡献被撤回重注册、
      // 或宿主重启而 App 进程没换），补齐回来的会话会全部命中“内容没变”
      // 而被跳过 → 状态行**永久空白**，而且没有任何日志能解释。
      //
      // 启动时无条件清一次：反正首屏本来就要全量重写。
      lastPushed.clear();
      // 存成模块级变量供 untrack 使用（原因见它的声明处）。
      // 重新赋值而不是只在为空时设：重载后新一代会传入新的回调。
      onSessionGoneHook = typeof onSessionGone === "function" ? onSessionGone : null;

      try {
        unsubscribe = await sdk.bus.subscribe(
          (event, sessionPath) => {
            try {
              const type = event?.type || "";
              if (type === "session_created" || type === "session_forked") {
                if (track(event.sessionId, event.sessionPath || sessionPath)) {
                  log("info", `跟踪会话 ${event.sessionId}`);
                }
              } else if (type === "session_closed" || type === "session_deleted") {
                untrack(event.sessionId);
              }
            } catch (err) {
              // 事件回调是同步入口，抛出去会击穿宿主的事件派发。
              log("warn", `事件处理失败：${err?.message || err}`);
            }
          },
          { types: ["session_created", "session_forked", "session_closed", "session_deleted"] },
        );
      } catch (err) {
        log("warn", `事件订阅失败：${err?.message || err}`);
      }

      try {
        const res = await sdk.bus.request("session:list", SESSION_LIST_ARGS);
        const list = Array.isArray(res?.sessions) ? res.sessions : [];
        for (const item of list) track(item?.sessionId, item?.path);
        log("info", `补齐 ${list.length} 个活跃会话`);
      } catch (err) {
        // 没授权 app/sessions.read 走这里；事件主路仍然有效，不算故障。
        log("warn", `session:list 不可用，仅依赖事件：${err?.message || err}`);
      }

      if (myGen !== gen) return myGen;
      setTimeout(() => {
        if (myGen !== gen || !running) return;
        Promise.resolve(onReady?.(myGen)).catch((err) => log("warn", `首屏铺设失败：${err?.message || err}`));
      }, 0).unref?.();
      return myGen;
    },

    async stop() {
      gen += 1; // 让所有在途回调立刻过期
      running = false;
      try {
        unsubscribe?.();
      } catch {
        /* 忽略 */
      }
      unsubscribe = null;
      // 断开回调引用：不然它会连着上一代的 feature 闭包一直活着，
      // 而那个闭包又持有 __perSession —— 内存与“旧值诈尸”两条都算在它头上。
      onSessionGoneHook = null;
      sessions.clear();
      lastPushed.clear();
    },
  };

  return host;
}
