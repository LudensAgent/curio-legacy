import type { Vec3Like } from '../adapter/types.ts';
import type { Landmark } from './store.ts';

/**
 * 记得的矿点：感知看见矿时记下的资源地标（每种矿每 24 格记一处）。
 * 心智想“挖铁”时要能想起“铁矿记得在哪”，采集看不见时要能说出“记得在哪”。
 */

/** 矿的种类：深板岩变种和普通的算一种（iron_ore / deepslate_iron_ore → iron） */
export const oreKind = (name: string) => name.replace(/^deepslate_/, '').replace(/^nether_/, 'nether ').replace(/_ore$/, '');

/** 中文里说起这种矿的词：回想按词重叠打分，“挖铁”“粗铁”要能想起 iron_ore */
const ORE_ZH: Record<string, string> = {
  iron: '铁矿 挖铁 找铁 粗铁 铁锭', coal: '煤矿 挖煤 找煤 煤炭', copper: '铜矿 挖铜 找铜 粗铜 铜锭', gold: '金矿 挖金 找金 粗金 金锭',
  diamond: '钻石 钻石矿 挖钻', redstone: '红石 红石矿', lapis: '青金石 青金石矿', emerald: '绿宝石 绿宝石矿',
  'nether quartz': '石英 下界石英', 'nether gold': '下界金矿',
};
export function oreAlias(label: string): string { return /_ore$/.test(label) ? ORE_ZH[oreKind(label)] ?? '' : ''; }

const DIRS = ['东', '东南', '南', '西南', '西', '西北', '北', '东北'];
function dir(dx: number, dz: number): string {
  if (Math.hypot(dx, dz) < 1) return '';
  const a = (Math.atan2(dz, dx) * 180 / Math.PI + 360 + 22.5) % 360; // 东=x+，南=z+
  return DIRS[Math.floor(a / 45)];
}

export interface OreSpot { label: string; kind: string; pos: Vec3Like; dist: number; text: string; id: string }

/** 某个位置附近记得的矿点（同一世界、同一维度），近的在前；only 限定只要哪些方块名 */
export function oreSpotsNear(landmarks: Landmark[], at: { worldId?: string; dim: string; pos: Vec3Like }, opts: { only?: string[]; radius?: number; excludeWithin?: number } = {}): OreSpot[] {
  const radius = opts.radius ?? 256, skipNear = opts.excludeWithin ?? 0;
  return landmarks
    .filter((l) => l.kind === 'resource' && /_ore$/.test(l.label) && l.dim === at.dim && (!at.worldId || !l.worldId || l.worldId === at.worldId)
      && (!opts.only || opts.only.includes(l.label)))
    .map((l) => {
      const dx = l.pos.x - at.pos.x, dy = Math.round(l.pos.y - at.pos.y), dz = l.pos.z - at.pos.z;
      const dist = Math.round(Math.hypot(dx, dy, dz));
      const height = dy >= 2 ? `，高 ${dy} 格` : dy <= -2 ? `，低 ${-dy} 格` : '';
      return { label: l.label, kind: oreKind(l.label), pos: l.pos, dist, id: l.id, text: `(${l.pos.x},${l.pos.y},${l.pos.z}) ${dir(dx, dz)}${Math.round(Math.hypot(dx, dz))}格${height}` };
    })
    .filter((o) => o.dist <= radius && o.dist >= skipNear)
    .sort((a, b) => a.dist - b.dist);
}

/** 按矿种归拢：每种只留最近的 perKind 处 */
export function oreSpotsByKind(spots: OreSpot[], perKind: number, maxKinds = 8): Record<string, string> {
  const out: Record<string, string[]> = {};
  for (const s of spots) {
    const k = s.kind;
    if (!out[k] && Object.keys(out).length >= maxKinds) continue;
    (out[k] ??= []);
    if (out[k].length < perKind) out[k].push(s.text);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [`${k}_ore`, v.join('；')]));
}
