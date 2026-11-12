/**
 * 前台动作计数：Agent 的技能执行期间，后台空间记忆 checkpoint 不应抢占共享的
 * 单 I/O 门。库把所有 checkpoint/load/query 串在同一个门上，后台保存一提交，
 * 前台的 section prepare 就会被拒绝成 busy；让后台在动作执行时让路，比让技能
 * 等一个不确定长度的保存更可靠。
 *
 * 这里只表示“身体正在做一个动作”，不是世界状态，也不改变持久化语义；
 * checkpoint 仍会在动作之间的空闲窗口按原周期执行。
 */
let active = 0;

export function beginSpatialForeground(): void {
  active += 1;
}

export function endSpatialForeground(): void {
  active = Math.max(0, active - 1);
}

export function spatialForegroundActive(): boolean {
  return active > 0;
}
