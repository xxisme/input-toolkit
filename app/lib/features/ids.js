/**
 * lib/features/ids.js —— 输入栏条目 id 的单一出处
 *
 * manifest.json 里的 contributes.ui.inputStatus[].id 和 feature 的 statusId 必须一致，
 * 而 manifest 是 JSON、这里是 ESM，没法互相 import。这个文件把字面量收在一处，
 * 改的时候至少有明确的对照点 —— 否则改了一边，症状是"功能启动了但输入栏没反应"。
 *
 * 注意 statusId 不必等于 feature.id：优化功能的 feature id 叫 polisher（配置键、设置页都用它），
 * 但输入栏条目沿用旧的 optimize —— 换了会让用户已有的宿主状态缓存对不上。
 *
 * 增删功能时这里加一行，manifest 同步加一条。
 */

export const QUOTA_STATUS_ID = "quota";
export const POLISHER_STATUS_ID = "optimize";
export const CACHEHIT_STATUS_ID = "cachehit";
export const SPEED_STATUS_ID = "speed";
