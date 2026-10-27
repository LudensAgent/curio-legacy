import type { AgentState, Vec3Like } from '../adapter/types.ts';
import type { WorldMemory } from '../memory/store.ts';
import { buildingArchiveFor } from '../skills/build.ts';

/**
 * “家”和“我盖过的东西”：真人玩家一直记得家在哪、哪座房子还没盖完。
 * 这些都是自己做过/到过的事实（地标、作品档案），不是推测。
 */
export interface BuildNote { id: string; name: string; status: string; pos: Vec3Like; dist: number; missing: number; accepted?: boolean; attempts: number; lastWorkedAt: number; recentProgress: number | null }
export interface HomeNote { label: string; pos: Vec3Like; dist: number; dir: string }

const dirOf = (from: Vec3Like, to: Vec3Like) => {
  const a = Math.atan2(to.x - from.x, -(to.z - from.z)) * 180 / Math.PI;
  return ['北', '东北', '东', '东南', '南', '西南', '西', '西北'][Math.round(((a + 360) % 360) / 45) % 8];
};

export function myBuilds(memory: WorldMemory, state: Pick<AgentState, 'worldId' | 'dim' | 'pos'>, n = 5): BuildNote[] {
  let projects: ReturnType<ReturnType<typeof buildingArchiveFor>['list']> = [];
  try { projects = buildingArchiveFor(memory).list(); } catch { return []; }
  // 放弃了的不再记挂（只在选址时避开那块地）
  return projects.filter((p) => p.worldId === state.worldId && p.dimension === state.dim && p.status !== 'abandoned').map((p) => {
    const last = p.inspections.at(-1);
    return { id: p.id, name: p.versions.at(-1)?.spec.name ?? '作品', status: p.status, pos: p.origin,
      dist: Math.round(Math.hypot(p.origin.x - state.pos.x, p.origin.z - state.pos.z)), missing: last && !last.complete ? last.defects.length : 0,
      ...(p.acceptance ? { accepted: true } : {}), attempts: p.inspections.length, lastWorkedAt: p.updatedAt,
      // 最近几次验收少了几处缺口（null：验收次数太少看不出来）
      recentProgress: p.inspections.length >= 4 ? p.inspections.at(-4)!.defects.length - (last?.defects.length ?? 0) : null };
  }).sort((a, b) => Number(a.status === 'complete') - Number(b.status === 'complete') || a.dist - b.dist).slice(0, n);
}

/** 家：盖好的住处优先，其次是基地地标，再次是自己的床 */
export function homeOf(memory: WorldMemory, state: Pick<AgentState, 'worldId' | 'dim' | 'pos'>): HomeNote | null {
  const here = state.pos;
  const note = (label: string, pos: Vec3Like): HomeNote => ({ label, pos, dist: Math.round(Math.hypot(pos.x - here.x, pos.z - here.z)), dir: dirOf(here, pos) });
  const built = myBuilds(memory, state, 20).filter((b) => b.status === 'complete').sort((a, b) => a.dist - b.dist)[0];
  if (built) return note(built.name, built.pos);
  const marks = memory.landmarks().filter((l) => l.dim === state.dim && (!l.worldId || l.worldId === state.worldId));
  // 有首选基地就是它（自己定的家）；没有才在像家的地点里挑最近的
  const base = marks.find((l) => l.kind === 'base' && l.primary) ?? marks.filter((l) => l.kind === 'base' || /家|基地|小屋/.test(l.label))
    .sort((a, b) => Math.hypot(a.pos.x - here.x, a.pos.z - here.z) - Math.hypot(b.pos.x - here.x, b.pos.z - here.z))[0];
  if (base) return note(base.label, base.pos);
  const bed = marks.find((l) => /我的床/.test(l.label));
  return bed ? note('我的床', bed.pos) : null;
}

export function describeBuild(b: BuildNote): string {
  const st = b.status === 'complete' ? (b.accepted ? `收工了，能住${b.missing ? `（逐格还差 ${b.missing} 处，不必补）` : ''}` : '盖好了') : b.missing ? `没盖完，还差 ${b.missing} 处${b.attempts >= 5 ? `，已经验收过 ${b.attempts} 次` : ''}` : b.status === 'planned' ? '刚规划' : '没盖完';
  return `${b.name}[${b.id}] ${st} (${Math.round(b.pos.x)},${Math.round(b.pos.y)},${Math.round(b.pos.z)}) ${b.dist}格`;
}
