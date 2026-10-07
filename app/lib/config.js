/**
 * lib/config.js —— 配置层
 *
 * 存在意义：把「配置存哪、怎么读、谁来归一化」这一件事收在一个地方，
 * 让 feature 模块只管声明自己需要哪些字段，而不用各自去碰 SDK。
 *
 * 为什么是 sdk.config 而不是 storage.global：
 *   设置页用**宿主自带的表单**（manifest.contributes.settings.schema）渲染，
 *   宿主表单只会读写 `ctx.config`（旧版的 storage.global 路线需要自己带一个 iframe 进来）。
 *   两个门不通：宿主不写 storage.global，我们不写 sdk.config，值会永远对不上。
 *
 * 形状翻译（重要）：
 *   宿主 schema 只能表达「一个字段一个值」，而额度显示是「**有序的多选**」——
 *   复选框、拖拽排序、实时预览，它一个都给不了。
 *   所以额度被拆成三个 boolean + 一个顺序预设，翻译回内部的 quotaSegments。
 *   这是一次降级，不是等价替换：能选哪几项保留了，自由排序没有。
 *   翻译规则由各 feature 通过 settingsToValues() 自己声明，config 层不认得
 *   「额度」这种业务概念。
 *
 * 约定：
 *   - 读出来的一切都要过类型归一化。配置是用户能直接编辑的 JSON，
 *     类型不对、字段缺失、手改坏值都是常态，不该让它变成下游的崩溃点。
 *   - 后端**不写** sdk.config（除了显式的 setFeatureEnabled）。写入会触发
 *     onChanged 又回来重读，形成自激；写路径只有宿主表单一个入口时才干净。
 */

/** 配置结构版本。字段语义发生变化时 +1。 */
export const CONFIG_VERSION = 1;

/** 上一份读到的配置。null = 还没成功读过。 */
let cache = null;
/**
 * 上一次读取是否失败过。
 *
 * 存在的理由很具体：读失败时我们返回的是**旧值**而不是全开（见 read 的 catch）。
 * 但“旧值”和“真实值”在 features 对象上长得一模一样（都没有 false 字段），
 * 读取方分辨不出来，除非我们主动说一声。
 * 不加这个标志的话，存储一抖 → 功能复活 → 没人知道为什么。
 */
let degraded = false;

/**
 * 配置在 storage.global 里的固定键。整块存一个键，不拆成 config.xxx。
 * 改这个值等于让所有已存配置失联，改之前想清楚。
 */
const STORAGE_KEY = "config";

/**
 * 字段声明表。这里只放**跨 feature 共享**的结构性字段；
 * feature 自己的业务字段（提示词、温度、告警阈值……）由各自声明后并入 DEFAULTS。
 *
 * type 三种：boolean / string / number。每个字段配一个 fallback，
 * 读到的值类型对不上就用它 —— 宁可退回默认值，也不要把 NaN / null 传进业务逻辑。
 */
const FIELD_TYPES = {
  // 这里只放**跨功能通用**的结构性字段。业务字段（额度段、轮询间隔、提示词…）
  // 由各 feature 在自己的 configFields 里声明 —— 否则 config 层就得知道
  // 「额度」这种业务概念，而加一个功能还得回来改这里。
  features: { type: "features", fallback: {} },
  configVersion: { type: "number", fallback: CONFIG_VERSION },
};

/** 字符串数组：只保非空字符串，且去重（顺序保留）。其余一律丢弃。 */
function normalizeStringArray(value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const v of value) {
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * features 桶的专用归一化。
 *
 * 普通的 object 归一化只管"是不是对象"，管不到里面的值，于是
 * `{"quota": "false"}` 会原样透传。而开关判断是 `!== false`，
 * 字符串 "false" 不等于 false，**结果是开启** —— 跟用户"我写了 false 就是关"的直觉相反。
 * 这个错误不报错、不留痕，只表现为"我明明关掉了它怎么还在"。
 *
 * 同时把值里出现的裸字符串键清掉：features 的值只能是布尔，
 * 数组 / 对象 / 数字都是手滑，一律当 false（关）而不是当开。
 */
function normalizeFeatures(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === true || raw === "true") { out[key] = true; continue; }
    out[key] = false;
  }
  return out;
}

function normalizeField(key, value, spec) {
  if (value === undefined || value === null) return spec.fallback;
  if (spec.type === "features") {
    return normalizeFeatures(value);
  }
  if (spec.type === "boolean") {
    // "false"（字符串）不是 false。用户从 JSON 手改很容易带字符串进来。
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    return spec.fallback;
  }
  if (spec.type === "number") {
    // 挡掉 "" / null / 数组 / 对象：Number("") 和 Number(null) 都得 0，
    // 一个手滑的空串会静默变成"阈值 0"，这种坑不留。
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
    return spec.fallback;
  }
  if (spec.type === "enum") {
    return Array.isArray(spec.values) && spec.values.includes(value) ? value : spec.fallback;
  }
  if (spec.type === "stringArray") {
    const arr = normalizeStringArray(value);
    // 空数组是**一个合法值**（“我一项都不想显示”），不是“没配过”。
    // 以前这里用 arr.length 判断，两者混在一起，于是把额度全取消勾选会被
    // 悄悄改回默认三项 —— 用户明明都取消了，界面却回到原样。
    // 只有「压根没这个键」或「值不是数组」才用默认值。
    if (arr) return arr;
    return value === undefined || value === null ? spec.fallback : [];
  }
  if (spec.type === "object") {
    return value && typeof value === "object" && !Array.isArray(value) ? value : spec.fallback;
  }
  if (spec.type === "string") {
    return typeof value === "string" ? value : spec.fallback;
  }
  return value;
}

/**
 * @param {object} sdk App SDK
 * @param {object} [options]
 * @param {Record<string, {type: string, fallback: unknown}>} [options.extraFields]
 *        feature 声明的额外字段。同一张表里归一化，避免每个 feature 各写一遍类型检查。
 */
/**
 * 把宿主表单的扁平键还原成内部形状。
 *
 * 保留这段是为了归一化（手改 JSON 会带进字符串 / 数字 / 数组），
 * 但它只在**走宿主表单**（manifest 的 contributes.settings.schema）时才被用到。
 * 现在设置页是自己画的，写入直接落在 storage.global，不经过 sdk.config。
 */

/** 反向：内部形状 -> 宿主表单的扁平键。同样只服务于宿主表单那条路。 */

export { normalizeFeatures, normalizeStringArray };

export function createConfig(sdk, options = {}) {
  const extraFields = options.extraFields || {};
  /** 最后一次成功读到的值。冷启动未读时是 null —— 读之前不许当它有效。 */
  let cache = null;

  const fieldTable = () => ({ ...FIELD_TYPES, ...extraFields });
  const warn = (msg) => sdk?.logger?.warn?.(`[input-toolkit] ${msg}`);
  /** 配置存放的地方。不提前取：defineApp 早期拿到的 sdk 可能还没接完。 */
  const store = () => sdk?.storage?.global ?? null;

  return {
    /**
     * 读全部配置并归一化。结果缓存 —— 一次 App 生命周期内反复读同一份没意义，
     * 而且每次都要过一次宿主存储，N 个 feature 读 N 次纯属浪费。
     * @param {boolean} [force] 强制绕过缓存（轮询或配置变更后用它刷新）
     */
    async read(force = false) {
      if (cache && !force) return cache;
      const spec = fieldTable();
      const values = {};
      const bucket = store();
      let raw = {};
      if (bucket) {
        try {
          const envelope = await bucket.get(STORAGE_KEY);
          // 后端返回**裸值**。万一哪天变成 {key, value} 包装（前端那种形状），
          // 也不能把它整个当成配置对象 —— 那样字段全变 undefined 且不报错。
          const bare = envelope && typeof envelope === "object" && !Array.isArray(envelope) && "value" in envelope;
          const raw0 = bare ? envelope.value : envelope;
          raw = (raw0 && typeof raw0 === "object" && !Array.isArray(raw0) ? raw0 : {}) || {};
        } catch (err) {
          // 读失败**不能**退回全开的默认值。
          //
          // 早先这里是 raw = {}，接着 normalizeFeatures({}) 得到全空的 fallback，
          // 而功能开关的判据是 `!== false` —— 空对象等于**全部开启**。
          // 后果：一次瞬时的存储失败（权限抖动、宿主未就绪）就把用户明确关掉的
          // 功能全部复活，而且 cache = values 把这份错状态立刻钉死，
          // 后面再也读不回旧值。无报错、只一行 warn。
          //
          // 正确做法：保留上一份好数据，并把“这次没读到”记下来。
          // 宁可暂时用旧配置，也不能拿一个编造的“全开”去覆盖用户的决定。
          degraded = true;
          warn(`读取配置失败，沿用上一份缓存（本次可能是旧值）：${err?.message || err}`);
          if (cache) return cache;
          // 冷启动且手上一份都没有：没得选，只能用默认值。
          // 但这个状态必须能被看出来 —— 上面已经置了 degraded。
          raw = {};
        }
      }
      for (const [key, s] of Object.entries(spec)) {
        values[key] = normalizeField(key, raw?.[key], s);
      }
      cache = values;
      degraded = false;
      return values;
    },

    /** 同步读已缓存的值。冷启动期返回 null，让调用方自己决定拿不到怎么办。 */
    peek() {
      return cache;
    },

    /**
     * 上一次读取是否失败过（返回的是缓存而不是真实配置）。
     *
     * 存在的意义：把“数据不确定”与“数据就是全开”区分开。
     * 两者在 features 这个对象上长得一模一样（都是没有 false 字段），
     * 调用方无法分辨，除非我们主动告知。
     */
    isDegraded() {
      return degraded;
    },

    /**
     * 写整块配置。先归一化再存：不让脏值经手写进存储，
     * 否则下次读取时要重新防御一遍，而那层防御在读取路径上已经足够了。
     *
     * 注意：宿主表单**不是**通过这里写的（它自己直接写 sdk.config），
     * 这个方法只在 App 自己需要改值时用。
     */
    /**
     * 写整块配置。整块存一个键，拆成 config.xxx 分键会导致读写键空间对不上。
     * 写之前先归一化：不让脏值经手写进存储。
     */
    async write(nextValues) {
      const bucket = store();
      if (!bucket) throw new Error("配置存储不可用，无法写入");
      const spec = fieldTable();
      const clean = {};
      for (const [key, s] of Object.entries(spec)) {
        clean[key] = normalizeField(key, nextValues?.[key], s);
      }
      clean.configVersion = CONFIG_VERSION;
      await bucket.set(STORAGE_KEY, clean);
      cache = { ...cache, ...clean };
      return clean;
    },

    async set(key, value) {
      const current = await this.read();
      return this.write({ ...current, [key]: value });
    },

    /** 批量改。逐个 key 应用后一次写入——批量是语义上的（同一份配置），不是多次存储往返。 */
    async setMany(patch) {
      const current = await this.read();
      return this.write({ ...current, ...(patch || {}) });
    },

    /**
     * feature 开关。存在即开、缺失即开 —— 只有显式 false 才算关。
     * 这样新增 feature 不会因为老配置里没有它的键而默认不显示。
     */
    isFeatureEnabled(values, featureId) {
      const features = values?.features;
      if (!features || typeof features !== "object") return true;
      return features[featureId] !== false;
    },

    async setFeatureEnabled(featureId, on) {
      // 必须 read(true)（强制绕过缓存），不能用缓存那份当基底。
      //
      // write() 是以整块 config 为基底覆盖的，基底一旦是陈旧的：
      // 用户在设置页改了 A，同时（或在 150ms 合并窗口内）点了状态行开关 →
      // 这次 toggle 就把设置页的 A 整块盖回去。静默丢数据，无报错无日志。
      // 强制读一次真实值，代价是一次多读，换的是不会覆写别人的改动。
      const values = (await this.read(true)) || {};
      const features = { ...(values.features || {}), [featureId]: !!on };
      return this.setMany({ features });
    },
  };
}
