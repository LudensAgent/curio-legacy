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
    const d = dist3(here, l.pos);
    if (d <= maxDist) out.push({ pos: l.pos, dist: Math.round(d), from: 'memory' });
  }
  return out.sort((a, b) => a.dist - b.dist)[0] ?? null;
}
