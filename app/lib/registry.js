/**
 * lib/registry.js —— 扩展点
 *
 * 这个文件回答一个问题：**以后往输入栏加一个新功能，要改哪几个地方？**
 * 答案是三处，而且互相不认识：
 *   1. 写一个 feature 模块（lib/features/<name>.js），导出一个 feature 对象
 *   2. 在 features/index.js 的数组里加一行
 *   3. 在 manifest.json 的 contributes.ui.inputStatus 里加一条同名 id 的贡献
 *
 * index.js 不认识任何具体功能 —— 它只遍历注册表、按开关决定谁启动。
 * 这就是"留下后续扩展空间"的具体含义：不是写一句注释说明以后可以扩展，
 * 而是让 index.js 在结构上就没有能力写死某个功能。
 *
 * feature 契约：
 * {
 *   id:        "quota",          // 全局唯一，同时是配置里 features.{id} 的键
 *   title:     "API 额度",        // 设置页与日志里显示的名字
 *   statusId:  "quota",          // 对应 manifest 里那条 inputStatus 贡献的 id
 *   defaultText:     "—",        // 状态行默认文案（feature 还没算出结果时）
 *   defaultTooltip:  "...",       // 默认 tooltip
 *   // 配置里 features.{id} 不为 false 即视为开启。缺省开启，
 *   // 这样新增 feature 在老配置下也是开的，不会静默隐身。
 *   isEnabled: (values) => boolean,   // 可选，不给就是恒开
 *   start: async (ctx) => {},        // 可选，启用时调用一次
 *   stop:  async (ctx) => {},        // 可选，停用/重载时调用一次
 * }
 *
 * ctx = { sdk, config, status, log, values }
 *   - log(level, msg) 统一日志出口，feature 不该自己去碰 sdk.logger
 *   - status 是 status-host，feature 不直接调 sdk.inputStatus
 *
 * start 抛错不许拖垮别的 feature：注册表逐个隔离捕获，一个功能坏掉
 * 输入栏其他条目照常工作。这跟"失败要永久可见"不冲突 —— 失败会被记进日志和状态行，
 * 只是不会变成整个 App 的沉默。
 */

export function createRegistry() {
  const features = [];
  const byId = new Map();
  /** sdk 只用于日志。feature 自己不碰 sdk —— 它们该走 ctx.status / ctx.config 那些收窄过的出口。 */
  let sdk = null;

  const api = {
    /**
     * 注册一个 feature。同 id 重复注册直接抛错 —— 静默覆盖会让人调试时怀疑人生，
     * 而重复 id 一定是写错了，不是想表达"覆盖"。
     */
    use(feature) {
      if (!feature || typeof feature !== "object") {
        throw new Error("feature 必须是对象");
      }
      if (typeof feature.id !== "string" || !feature.id.trim()) {
        throw new Error("feature 缺少 id");
      }
      if (byId.has(feature.id)) {
        throw new Error(`feature id 重复：${feature.id}`);
      }
      features.push(feature);
      byId.set(feature.id, feature);
      return api;
    },

    all() {
      return features.slice();
    },

    /**
     * 汇总所有 feature 声明的配置字段。
     *
     * 为什么要走这里而不是让 config.js 写死：配置字段属于功能，config 层不该知道
     * 「提示词温度」这种业务概念。加一个功能要改 config.js 是设计失败。
     * 后 id 冲突时保留先注册的那个，并在返回值里给出冲突列表让调用方记日志——
     * 静默覆盖会让两个功能读到对方的值。
     */
    configFields() {
      const merged = {};
      const conflicts = [];
      for (const f of features) {
        for (const [key, spec] of Object.entries(f.configFields || {})) {
          if (merged[key]) {
            conflicts.push({ key, owner: f.id, other: merged[key].__owner });
            continue;
          }
          merged[key] = { ...spec, __owner: f.id };
        }
      }
      return { fields: merged, conflicts };
    },

    get(id) {
      return byId.get(id) ?? null;
    },

    /** 某个 feature 此刻是否该显示。isEnabled 缺省为开。 */
    isEnabled(feature, values) {
      // values 缺失时一律判为**关闭**。判成开启会是一个安静而致命的错误：
      // feature.isEnabled(undefined) 里的可选链会返回 undefined，
      // `undefined !== false` 为 true，于是所有功能集体复活。
      if (values === undefined || values === null) return false;
      if (typeof feature?.isEnabled === "function") {
        try {
          return feature.isEnabled(values) !== false;
        } catch (err) {
          api.log("warn", `feature ${feature.id} 的 isEnabled 抛错，按关闭处理：${err?.message || err}`);
          return false;
        }
      }
      return true;
    },

    /** 筛出当前该显示的 feature。顺序即注册顺序 —— 输入栏从左到右的排布由它决定。 */
    enabled(values) {
      return features.filter((f) => api.isEnabled(f, values));
    },

    log(level, msg) {
      // sdk.logger[level]，不是 sdk[level] —— 后者恒为 undefined，
      // 后果是注册表里所有的启动失败与告警都会静默消失。
      try {
        sdk?.logger?.[level]?.(`[input-toolkit] ${msg}`);
      } catch {
        /* 忽略 */
      }
    },

    /**
     * 启动所有启用的 feature。逐个隔离：一个 start 抛错不影响后面的。
     * 返回 {started, failed}，调用方拿它决定要不要在日志里留一条汇总。
     *
     * ctx.features[id] 存在时优先用它：index.js 给每个 feature 准备了带
     * setText/setTooltip 的专属 ctx，共用的那个只够做不需要自我更新的 feature。
     */
    async startAll(ctx) {
      const results = { started: [], failed: [] };
      for (const feature of features) {
        if (!api.isEnabled(feature, ctx?.values)) continue;
        const ownCtx = ctx?.features?.[feature.id] ?? ctx;
        if (typeof feature.start !== "function") {
          results.started.push(feature.id);
          continue;
        }
        try {
          await feature.start(ownCtx);
          results.started.push(feature.id);
        } catch (err) {
          results.failed.push({ id: feature.id, error: String(err?.message || err) });
          api.log("error", `feature ${feature.id} 启动失败：${err?.message || err}`);
        }
      }
      return results;
    },

    /**
     * 启停**单个** feature。
     *
     * 为什么需要它：startAll/stopAll 都是“全量”，适用于启动和卸载。
     * 但用户在设置页点一下开关时，变的只是其中一两个功能的启停状态，
     * 总不能为了关一个功能把另一个也停了重启。
     *
     * 开关不生效的根源也在这：以前配置变更只会重铺状态行，
     * 没有人调用 stop() —— 轮询定时器继续跑、继续取数、继续写 visible:true，
     * 关掉的额度过几分钟自己又冒出来了。
     *
     * 幂等：重复 start 同一个 feature 是调用方的事，这里不做去重。
     */
    async startOne(feature, ctx) {
      if (!feature || typeof feature.start !== "function") return;
      try {
        await feature.start(ctx?.features?.[feature.id] ?? ctx);
        api.log("info", `feature ${feature.id} 已启动`);
      } catch (err) {
        api.log("error", `feature ${feature.id} 启动失败：${err?.message || err}`);
      }
    },

    async stopOne(feature, ctx) {
      if (!feature || typeof feature.stop !== "function") return;
      try {
        await feature.stop(ctx?.features?.[feature.id] ?? ctx);
        api.log("info", `feature ${feature.id} 已停止`);
      } catch (err) {
        api.log("warn", `feature ${feature.id} 停止失败：${err?.message || err}`);
      }
    },

    async stopAll(ctx) {
      // 逆序停：注册顺序里后面的更可能依赖前面的资源。
      for (const feature of [...features].reverse()) {
        if (typeof feature.stop !== "function") continue;
        try {
          await feature.stop(ctx?.features?.[feature.id] ?? ctx);
        } catch (err) {
          api.log("warn", `feature ${feature.id} 停止失败：${err?.message || err}`);
        }
      }
    },
  };

  // sdk 由 index.js 在拿到 defineApp 的 sdk 后注入，保证日志出口一直可用。
  return Object.assign(api, {
    attachSdk(s) {
      sdk = s;
    },
  });
}
