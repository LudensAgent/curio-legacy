import type { Vec3Like } from '../adapter/types.ts';

/**
 * 最近动过哪些方块（挖掉 / 放下），记在哪个任务名下。
 * 技能做完时把这些记到技能名下，就能看出“一个技能放的块被另一个技能挖了”（或反过来）——两个技能在互相拆台。
 */
export interface BlockEdit { at: number; taskId: string; kind: 'dig' | 'place'; key: string; skill?: string }
const log: BlockEdit[] = [];
const KEEP_MS = 20 * 60_000;

export function noteEdit(taskId: string | undefined, kind: BlockEdit['kind'], pos: Vec3Like, at = Date.now()) {
  if (!taskId) return;
  log.push({ at, taskId, kind, key: `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}` });
  while (log.length > 2000 || (log.length && at - log[0].at > KEEP_MS)) log.shift();
}

/**
 * 某个任务做完了、知道它是哪个技能了：把它的改动记到技能名下，返回被它推翻的别的技能（它挖掉了别人放的、或者在别人挖开的地方又放上）。
 * 只看这一格上一回是谁动的：上一回是别的技能、动作相反，才算拆台。
 */
export function claimEdits(taskId: string, skill: string): { skill: string; cells: number }[] {
  const mine = log.filter((e) => e.taskId === taskId && !e.skill);
  const undone = new Map<string, number>();
  for (const e of mine) {
    e.skill = skill;
    const prev = [...log].reverse().find((p) => p !== e && p.key === e.key && p.at <= e.at && p.taskId !== taskId);
    if (prev?.skill && prev.skill !== skill && prev.kind !== e.kind) undone.set(prev.skill, (undone.get(prev.skill) ?? 0) + 1);
  }
  return [...undone].map(([s, cells]) => ({ skill: s, cells }));
}

export function resetEdits() { log.length = 0; }
