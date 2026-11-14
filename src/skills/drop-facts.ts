import type { Vec3Like } from '../adapter/types.ts';

/** 掉落物正常寿命约 5 分钟；近期掉落位置只保留这个窗口。 */
export const DROP_MEMORY_MS = 300_000;
/** 实体名和掉落物名只差一个 item: 前缀。 */
export const dropName = (name: string) => name.replace(/^item:/, '');

export interface KnownDrop { id: number; name: string; pos: Vec3Like; ageMs?: number }

/** 把仍然记得/看得见的掉落物写成可核对的坐标、脚位高差和最近见过时间；不判断能否走到。 */
export function describeDrops(drops: readonly KnownDrop[], here: Vec3Like): string {
  return drops.map((drop) => {
    const dy = Math.round(drop.pos.y - here.y);
    return `${drop.name} (${Math.round(drop.pos.x)},${Math.round(drop.pos.y)},${Math.round(drop.pos.z)})`
      + `${dy < 0 ? `，在脚下 ${-dy} 格` : dy > 0 ? `，在上方 ${dy} 格` : ''}`
      + `${drop.ageMs === undefined ? '' : `，${Math.max(1, Math.round(drop.ageMs / 1000))} 秒前见过`}`;
  }).join('、');
}
