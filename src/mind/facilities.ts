import type { Vec3Like } from '../adapter/types.ts';
import { passageLevels } from '../memory/passages.ts';
import type { Landmark, PassageRecord, WorldMemory } from '../memory/store.ts';
import { STATION_LABEL } from '../skills/stations.ts';

/** 算“设施”的地标：工作台、熔炉、床、箱子这些功能方块，加上农田；盖的房子在 my_builds 里另说 */
export const FACILITY_LABELS = new Set([...Object.values(STATION_LABEL), '我的床', '我的农田']);

/**
 * “我的设施”：自己在世界里留下、以后还能接着用的东西——箱子、工作台熔炉这些工作站、床、挖过的通道。
 * 以前它们各记各的、只在“认真想”时混在一堆地点里给出去，于是它存了东西不去拿、有矿道还从脚下重新挖。
 * 这里是查它们的统一入口：认真想时列出来，需要的时候（缺材料、想下矿）按需提一句。
 */
export type FacilityKind = 'chest' | 'station' | 'bed' | 'passage';
export interface Facility { kind: FacilityKind; label: string; pos: Vec3Like; dist: number; text: string; /** 通道：人就在里面 */ inside?: boolean }

type State = { worldId: string; dim: string; pos: Vec3Like };
const flat = (a: Vec3Like, b: Vec3Like) => Math.round(Math.hypot(a.x - b.x, a.z - b.z));
const d3 = (a: Vec3Like, b: Vec3Like) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const at = (p: Vec3Like) => `(${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)})`;
const mine = (l: Landmark, s: State) => l.dim === s.dim && (!l.worldId || l.worldId === s.worldId);

/** 自己放下/用过的工作站和床（“我的X”），同一格的只算一个 */
function myStations(memory: Pick<WorldMemory, 'landmarks'>, s: State): Landmark[] {
  const out: Landmark[] = [];
  for (const l of memory.landmarks()) {
    if (l.kind !== 'discovery' || !FACILITY_LABELS.has(l.label) || !mine(l, s)) continue;
    if (out.some((o) => o.label === l.label && d3(o.pos, l.pos) <= 2)) continue;
    out.push(l);
  }
  return out;
}

/** 一条通道说成一句话：从哪下去、多深、横巷在哪几层、挖到过什么、底下有什么 */
export function describePassage(rec: PassageRecord, here: Vec3Like, stations: Landmark[] = [], resources: Landmark[] = []): { text: string; entrance: Vec3Like; dist: number; inside: boolean } {
  const entrance = [...rec.entrances].sort((a, b) => flat(a, here) - flat(b, here))[0]
    ?? [...rec.path].sort((a, b) => b.y - a.y)[0];
  const dist = flat(entrance, here);
  const inside = rec.path.some((p) => d3(p, here) <= 3);
  const levels = passageLevels(rec).filter((y) => y !== entrance.y);
  const ores = Object.entries(rec.ores).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, c]) => `${n}×${c}`);
  const near = (l: Landmark, r: number) => rec.path.some((p) => d3(p, l.pos) <= r);
  const things = [...new Set(stations.filter((l) => near(l, 4)).map((l) => l.label.replace(/^我的/, '')))];
  const seen = [...new Set(resources.filter((l) => /_ore$/.test(l.label) && near(l, 6)).map((l) => l.label))].slice(0, 3);
  const text = `${rec.entrances.length ? `入口 ${at(entrance)}` : `最高处 ${at(entrance)}`}${inside ? '' : `（${dist} 格外）`}，能走到 y${rec.deepestY}`
    + `${levels.length ? `，横巷在 y${levels.join('、y')}` : ''}${ores.length ? `，挖到过 ${ores.join('、')}` : ''}`
    + `${seen.length ? `，沿途见过 ${seen.join('、')}` : ''}${things.length ? `，里面有${things.join('、')}` : ''}`;
  return { text, entrance, dist, inside };
}

/** 自己的设施，近的在前；kinds 不给就全要 */
export function myFacilities(memory: Pick<WorldMemory, 'landmarks' | 'chests' | 'passages'>, s: State, kinds?: FacilityKind[]): Facility[] {
  const want = (k: FacilityKind) => !kinds || kinds.includes(k);
  const out: Facility[] = [];
  const stations = myStations(memory, s);
  if (want('chest')) {
    for (const c of memory.chests(s.dim)) {
      if (c.worldId && c.worldId !== s.worldId) continue;
      // 按数量挑最多的几样说（以前按存进去的先后，铁锭、原木排在后面就看不到）
      const top = [...c.items].filter((i) => i.count > 0).sort((a, b) => b.count - a.count).slice(0, 6).map((i) => `${i.name}×${i.count}`);
      out.push({ kind: 'chest', label: '我的箱子', pos: c.pos, dist: flat(c.pos, s.pos), text: `箱子 ${at(c.pos)} ${flat(c.pos, s.pos)}格：${top.join('、') || '空'}${c.items.length > 6 ? ` 等 ${c.items.length} 样` : ''}` });
    }
  }
  for (const l of stations) {
    if (l.label === '我的箱子' && want('chest')) continue; // 箱子按存货说，上面已经有了
    const kind: FacilityKind = l.label === '我的床' ? 'bed' : 'station';
    if (!want(kind) || l.label === '我的箱子') continue;
    out.push({ kind, label: l.label, pos: l.pos, dist: flat(l.pos, s.pos), text: `${l.label.replace(/^我的/, '')} ${at(l.pos)} ${flat(l.pos, s.pos)}格` });
  }
  if (want('passage')) {
    const resources = memory.landmarks().filter((l) => l.kind === 'resource' && mine(l, s));
    for (const rec of memory.passages(s.dim)) {
      if (rec.worldId && rec.worldId !== s.worldId) continue;
      const d = describePassage(rec, s.pos, stations, resources);
      out.push({ kind: 'passage', label: '我挖的通道', pos: d.entrance, dist: d.inside ? 0 : d.dist, text: `挖过的通道：${d.text}`, inside: d.inside });
    }
  }
  return out.sort((a, b) => a.dist - b.dist);
}
