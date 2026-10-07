/**
 * lib/features/index.js —— 功能清单
 *
 * 往输入栏加功能的第二步就是往这个数组里加一行。加上第一步的 feature 模块、
 * 第三步的 manifest 贡献项，一共三处，index.js 不用动。
 *
 * 顺序即输入栏从左到右的排布。放在前面的应该是不常关、最常用、最不该被挤进
 * `…` 溢出条的那些 —— 宿主保留前缀，放不下的从上方 `…` 露出来。
 */

import { quota, QUOTA_ACTIONS } from "./quota.js";
import { polisher, POLISHER_ACTIONS } from "./polisher.js";
import { cachehit, CACHEHIT_ACTIONS } from "./cachehit.js";
import { speed, SPEED_ACTIONS } from "./speed.js";

/**
 * 顺序即输入栏从左到右的排布。
 * 额度在前：它是被看的东西，不是被操作的东西，应该待在不显眼但常在的位置。
 * 缓存命中率、本轮速度居中：两者都是纯信息，量级相同（都是“这一轮怎么样”），
 * 挨着放好对比 —— 缓存高但速度慢、缓存低但速度快，都是常见且值得一看的组合。
 * 优化在后：它会抢占用户注意力（进行中/可撤销都有状态），放后面更稳。
 */
export const FEATURES = [quota, cachehit, speed, polisher];

/**
 * feature 动作表：key 是 feature id，动作名对应 manifest 里 args.action。
 *
 * 工具层只做路由，不解释每个功能想干什么 —— 那是 feature 自己的事。
 * 加一个动作 = 在 feature 模块里写处理函数，在这里挂到它的 id 上。
 */
export const FEATURE_ACTIONS = {
  quota: QUOTA_ACTIONS,
  cachehit: CACHEHIT_ACTIONS,
  speed: SPEED_ACTIONS,
  polisher: POLISHER_ACTIONS,
};
