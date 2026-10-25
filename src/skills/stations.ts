import type { Vec3Like } from '../adapter/types.ts';
import { dist3 } from '../util.ts';
import { INTERACTIVE_BLOCKS, interactiveName } from '../perception/vision.ts';
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
  ctx.memory.addLandmark('discovery', `我的${zh}`, ctx.adapter.state().dim, pos, 2);
}

type StationMemory = { landmarks(): { id?: string; label: string; dim: string; pos: Vec3Like; worldId?: string }[]; removeLandmark?(id: string): boolean };

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

/** 拆掉了一个工作站：记忆里这一格（床是两格）的“我的X”/“X”一起忘掉 */
export function forgetStationAt(memory: StationMemory, dim: string, cells: Vec3Like[], blockName: string): number {
  const zh = interactiveName(blockName);
  if (!zh) return 0;
  let n = 0;
  for (const l of memory.landmarks()) {
    if (l.dim !== dim || (l.label !== `我的${zh}` && l.label !== zh) || !l.id) continue;
    if (cells.some((c) => dist3(c, l.pos) <= 1.5) && memory.removeLandmark?.(l.id)) n++;
  }
  return n;
}

/** 自己放过/睡过的床（当前世界、当前维度里最近的一张）：放下后床就不在背包里了，但它还在那儿；给了 blockAt 就顺便核对它还在不在 */
export function myBed(memory: StationMemory,
  state: { dim: string; worldId: string; pos: Vec3Like }, blockAt?: (p: Vec3Like) => string | null): { pos: Vec3Like; dist: number } | null {
  let best: { pos: Vec3Like; dist: number } | null = null;
  for (const l of memory.landmarks()) {
    if (l.label !== '我的床' || l.dim !== state.dim || (l.worldId && l.worldId !== state.worldId)) continue;
    if (!stillThere(memory, l, state.pos, blockAt, (n) => n.endsWith('_bed'))) continue;
    const d = Math.round(dist3(state.pos, l.pos));
    if (!best || d < best.dist) best = { pos: { ...l.pos }, dist: d };
  }
  return best;
}

/** 先看视野/近期视觉记忆，再看自己记下的工作站地标；返回最近的一个 */
export function findStation(ctx: SkillCtx, kinds: string[], maxDist: number): { pos: Vec3Like; dist: number; from: 'seen' | 'memory' } | null {
  const s = ctx.adapter.state();
  const here = s.pos;
  const out: { pos: Vec3Like; dist: number; from: 'seen' | 'memory' }[] = [];
  const seen = ctx.senses.knownBlocks(kinds, maxDist)[0];
  if (seen) out.push({ pos: seen.pos, dist: Math.round(dist3(here, seen.pos)), from: 'seen' });
  // 自己的（我的X）和看见过的（X）都算
  const labels = new Set(kinds.flatMap((k) => { const zh = interactiveName(k); return zh ? [`我的${zh}`, zh] : []; }));
  for (const l of ctx.memory.landmarks()) {
    if (!labels.has(l.label) || l.dim !== s.dim || (l.worldId && l.worldId !== s.worldId)) continue;
    if (!stillThere(ctx.memory, l, here, (p) => ctx.adapter.blockAt(p), (n) => kinds.includes(n))) continue;
    const d = dist3(here, l.pos);
    if (d <= maxDist) out.push({ pos: l.pos, dist: Math.round(d), from: 'memory' });
  }
  return out.sort((a, b) => a.dist - b.dist)[0] ?? null;
}
