import type { Landmark } from '../memory/store.ts';

/**
 * 观察者 HUD 上「记得的地点」：从世界记忆里挑几个重要地点，按重要程度和远近排好。
 *
 * 顺序：家（base）→ 最近一次死亡地点 → 自己的东西（“我的…”、路标）和资源 → 其它发现；同一档里按距离从近到远。
 * - 生物群系一类的标记不显示；资源点和记忆里一样，只算 15 分钟内见过的。
 * - 同一位置（2 格内）只留一个，优先留“我的…”。
 * - 距离按当前维度算；在别的维度的地点距离为 null（HUD 显示维度名）。
 */
export interface HudLandmark {
  kind: Landmark['kind'];
  label: string;
  x: number;
  y: number;
  z: number;
  dim: string;
  distance: number | null;
}

const RESOURCE_TTL_MS = 15 * 60_000;

function rank(l: Landmark, latestDeath: Landmark | undefined): number {
  if (l.kind === 'base') return 0;
  if (l.kind === 'death') return l === latestDeath ? 1 : 9;
  if (l.label.startsWith('我的') || l.kind === 'waypoint' || l.kind === 'danger') return 2;
  if (l.kind === 'resource') return 3;
  return 4;
}

export function hudLandmarks(all: readonly Landmark[], here: { pos: { x: number; y: number; z: number }; dim: string } | null,
  max = 6, now = Date.now()): HudLandmark[] {
  const usable = all.filter((l) => !l.label.startsWith('biome:') && l.kind !== 'herd' && (l.kind !== 'resource' || now - l.ts <= RESOURCE_TTL_MS));
  const latestDeath = usable.filter((l) => l.kind === 'death').sort((a, b) => b.ts - a.ts)[0];
  const distance = (l: Landmark) => here && l.dim === here.dim
    ? Math.hypot(l.pos.x - here.pos.x, l.pos.y - here.pos.y, l.pos.z - here.pos.z) : null;
  const ordered = usable
    .map((l) => ({ l, r: rank(l, latestDeath), d: distance(l) }))
    .filter((e) => e.r < 9)
    .sort((a, b) => a.r - b.r || (a.d ?? Infinity) - (b.d ?? Infinity) || b.l.ts - a.l.ts);
  const picked: typeof ordered = [];
  for (const e of ordered) {
    const near = picked.find((p) => p.l.dim === e.l.dim && Math.hypot(p.l.pos.x - e.l.pos.x, p.l.pos.y - e.l.pos.y, p.l.pos.z - e.l.pos.z) <= 2);
    if (near) continue; // 排在前面的（家、“我的…”）已经代表这个位置
    picked.push(e);
    if (picked.length >= max) break;
  }
  return picked.map(({ l, d }) => ({ kind: l.kind, label: l.label, x: l.pos.x, y: l.pos.y, z: l.pos.z, dim: l.dim, distance: d }));
}
