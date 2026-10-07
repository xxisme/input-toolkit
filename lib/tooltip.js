/**
 * lib/tooltip.js —— 输入栏 hint 的统一约束
 *
 * 为什么要有这个：hint 显示在输入栏上方的浮层里，宽度有限，超出就被裁掉。
 * 真机上踩过——优化那条 35 字被裁成半截，缓存那条带错误信息时能到 52 字。
 *
 * 为什么不各写各的：polisher 用 `slice(0, 100)` 截错误，cachehit 直接拼原始错误串，
 * 两套做法都是“先拼上去再说”，结果一个截太狠（100 字照样超）一个根本不截。
 * 外部来的错误串长度不可控，必须在**写入前**统一收敛。
 *
 * 24 字这个数是量出来的，不是拍的：缓存命中率 14 字不溢出，额度两家 19 字不溢出。
 * 留 5 字余量给不同字号的字体渲染差异。
 */

/** 单条 hint 的字数上限。 */
export const TOOLTIP_MAX = 24;

/**
 * 收敛成一行且不超过上限。
 *
 * @param {string} text 原文
 * @param {{limit?: number, ellipsis?: string}} [options]
 *        ellipsis 默认 "…"；省掉它可以给「设置」页这类不怕宽的地方用。
 * @returns {string}
 */
export function fitTooltip(text, options = {}) {
  const limit = options.limit ?? TOOLTIP_MAX;
  const ellipsis = options.ellipsis ?? "…";
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= limit) return s;
  // 截断时给省略号留位置，不然最后会被半个字切掉。
  return s.slice(0, Math.max(0, limit - ellipsis.length)).trimEnd() + ellipsis;
}

/**
 * 收敛「固定部分 + 可变原因」这种两段式文案。
 *
 * 错误串来自宿主或外部，长度不可控。硬拼的结果是：原因一长，
 * **固定部分（也就是“这是什么的 hint”）被截没了** —— 真机踩到过：
 * 丢到 24 字时只剩 “没有 app/usage.read 授权，请到…”，用户不知道这是哪一项的提示。
 *
 * 所以：**固定部分必须完整保留**，超长的只砍原因。
 *
 * @param {string} fixed  固定部分（不可丢）
 * @param {string} reason 出错原因（可被截断）
 * @param {string} [sep]  分隔符
 */
export function fitTooltipWithAction(fixed, reason, sep = "：") {
  const f = String(fixed ?? "").replace(/\s+/g, " ").trim();
  const r = String(reason ?? "").replace(/\s+/g, " ").trim();
  if (!f) return fitTooltip(r);
  if (!r) return fitTooltip(f);
  const room = TOOLTIP_MAX - f.length - sep.length;
  if (room <= 1) return fitTooltip(f);
  const tail = fitTooltip(r, { limit: room });
  // 分隔符有根有用的用：原因被砍到只剩省略号时，不加反而像半个句子。
  return tail.length <= 2 ? f : fitTooltip(`${f}${sep}${tail}`);
}
