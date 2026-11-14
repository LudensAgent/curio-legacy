import type { Vec3Like } from '../adapter/types.ts';
import { dist3 } from '../util.ts';
import { INTERACTIVE_BLOCKS, interactiveName } from '../perception/vision.ts';
import { chestLocation, isContainerLandmark } from '../memory/chest-memory.ts';
import type { SkillCtx } from './types.ts';

/**
 * 功能方块记忆（工作台、熔炉、箱子、铁砧、附魔台、床……）：自己放下或用过的记成“我的X”，
 * 看见的记成“X”；用的时候先去最近的那个，附近既看不见也不记得才现做。地标也会出现在 LLM 的 known_locations 里。
 */
export const STATION_LABEL: Record<string, string> = Object.fromEntries(Object.entries(INTERACTIVE_BLOCKS).map(([k, zh]) => [k, `我的${zh}`]));
export const isStation = (block: string) => !!interactiveName(block);

export function rememberStation(ctx: SkillCtx, kind: string, pos: Vec3Like | undefined) {
  const zh = interactiveName(kind);
  if (!zh || !pos) return;
  ctx.memory.addLandmark('discovery', `我的${zh}`, ctx.adapter.state().dim, pos, isContainerLandmark(kind) ? 0.1 : 2);
}

type StationMemory = {
  landmarks(): { id?: string; label: string; dim: string; pos: Vec3Like; worldId?: string; ts?: number }[];
  removeLandmark?(id: string): boolean;
  forgetChest?(dim: string, pos: Vec3Like): void;
  forgetFurnace?(dim: string, pos: Vec3Like): void;
};

/**
 * 记得的工作站还在不在：离得够近（区块加载着）、那一格看得清，又不是这种方块了——那就是被拆了、烧了或者别人拿走了，
 * 从记忆里删掉。人走回去看见床没了，就不会再说“我有张床在那儿”。
 */
function stillThere(memory: StationMemory, l: { id?: string; pos: Vec3Like }, here: Vec3Like, blockAt: ((p: Vec3Like) => string | null) | undefined, is: (name: string) => boolean): boolean {
  if (!blockAt || dist3(here, l.pos) > 48) return true;
  const name = blockAt({ x: Math.floor(l.pos.x), y: Math.floor(l.pos.y), z: Math.floor(l.pos.z) });
  if (name === null || is(name)) return true;
  if (l.id) memory.removeLandmark?.(l.id);
  return false;
}

/** Confirmed removal invalidates the station and its local storage or furnace contents together. */
export function forgetStationAt(memory: StationMemory, dim: string, cells: Vec3Like[], blockName: string): number {
  const zh = interactiveName(blockName);
  let n = 0;
  for (const l of memory.landmarks()) {
    if (l.dim !== dim || !l.id || !(zh && (l.label === `我的${zh}` || l.label === zh) || l.label.endsWith(`（${blockName}）`))) continue;
    if (cells.some((c) => dist3(c, l.pos) <= 0.1) && memory.removeLandmark?.(l.id)) n++;
  }
  if (['chest', 'trapped_chest', 'barrel'].includes(blockName) || blockName.endsWith('shulker_box')) cells.forEach((pos) => memory.forgetChest?.(dim, pos));
  if (['furnace', 'blast_furnace', 'smoker'].includes(blockName)) cells.forEach((pos) => memory.forgetFurnace?.(dim, pos));
  return n;
}

/** 自己放过/睡过的床（当前世界、当前维度里最近的一张）：放下后床就不在背包里了，但它还在那儿；给了 blockAt 就顺便核对它还在不在 */
export function myBed(memory: StationMemory,
  state: { dim: string; worldId: string; pos: Vec3Like }, blockAt?: (p: Vec3Like) => string | null): { pos: Vec3Like; dist: number; observedAt?: number } | null {
  let best: { pos: Vec3Like; dist: number; observedAt?: number } | null = null;
  for (const l of memory.landmarks()) {
    if (l.label !== '我的床' || l.dim !== state.dim || (l.worldId && l.worldId !== state.worldId)) continue;
    if (!stillThere(memory, l, state.pos, blockAt, (n) => n.endsWith('_bed'))) continue;
    const d = Math.round(dist3(state.pos, l.pos));
    if (!best || d < best.dist) best = { pos: { ...l.pos }, dist: d, ...(l.ts !== undefined ? { observedAt: l.ts } : {}) };
  }
  return best;
}

/** 先看视野/近期视觉记忆，再看自己记下的工作站地标；返回最近的一个。readOnly 只查记忆，不观察、不删除过时地标。 */
export function findStation(ctx: SkillCtx, kinds: string[], maxDist: number, opts: { readOnly?: boolean } = {}): { pos: Vec3Like; dist: number; from: 'seen' | 'memory'; radius?: number } | null {
  const s = ctx.adapter.state();
  const here = s.pos;
  const out: { pos: Vec3Like; dist: number; from: 'seen' | 'memory'; radius?: number }[] = [];
  if (!opts.readOnly) {
    const known = ctx.senses.knownBlocks(kinds, maxDist);
    const visibleContainers = new Set((ctx.senses.observeBlocks?.(known.filter((b) => isContainerLandmark(b.name)).slice(0, 32).map((b) => b.pos)) ?? [])
      .filter((b) => kinds.includes(b.name)).map((b) => `${b.pos.x},${b.pos.y},${b.pos.z}`));
    const seen = known.find((b) => !isContainerLandmark(b.name) || visibleContainers.has(`${b.pos.x},${b.pos.y},${b.pos.z}`));
    if (seen) out.push({ pos: seen.pos, dist: Math.round(dist3(here, seen.pos)), from: 'seen' });
  }
  // 自己的（我的X）和看见过的（X）都算
  const labels = new Set(kinds.flatMap((k) => { const zh = interactiveName(k); return zh ? [`我的${zh}`, zh] : []; }));
  for (const l of ctx.memory.landmarks()) {
    if (!labels.has(l.label) || l.dim !== s.dim || (l.worldId && l.worldId !== s.worldId)) continue;
    if (!opts.readOnly && !stillThere(ctx.memory, l, here, (p) => ctx.senses.observeBlocks?.([p])[0]?.name ?? null, (n) => kinds.includes(n))) continue;
    const location = isContainerLandmark(l.label) ? chestLocation(l) : { pos: l.pos, radius: 0 };
    const d = dist3(here, location.pos);
    if (d <= maxDist) out.push({ pos: location.pos, dist: Math.round(d), from: 'memory', radius: location.radius });
  }
  return out.sort((a, b) => a.dist - b.dist)[0] ?? null;
}
