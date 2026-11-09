import type { Vec3Like } from '../adapter/types.ts';
import type { Landmark, WorldMemory } from '../memory/store.ts';
import { STATION_LABEL } from '../skills/stations.ts';
import { chestLocation, describeChest, isContainerLandmark } from '../memory/chest-memory.ts';

/** 算“设施”的地标：工作台、熔炉、床、箱子这些功能方块，加上农田；盖的房子在 my_builds 里另说 */
export const FACILITY_LABELS = new Set([...Object.values(STATION_LABEL), '我的床', '我的农田']);

/**
 * “我的设施”：自己在世界里留下、以后还能接着用的东西——箱子、工作台熔炉这些工作站、床。
 * 以前它们各记各的、只在“认真想”时混在一堆地点里给出去，于是它存了东西不去拿。
 * 这里是查它们的统一入口：认真想时列出来，需要的时候（缺材料）按需提一句。
 * 挖过的通道不在这里：下矿时由 prompt 的 decisionReminders 按距离提附近几条，路线复用走 travel_to 的 via。
 */
export type FacilityKind = 'chest' | 'station' | 'bed';
export interface Facility { kind: FacilityKind; label: string; pos: Vec3Like; dist: number; text: string; radius?: number; precise?: boolean; observedAt?: number }

type State = { worldId: string; dim: string; pos: Vec3Like; worldDay?: number };
const flat = (a: Vec3Like, b: Vec3Like) => Math.round(Math.hypot(a.x - b.x, a.z - b.z));
const d3 = (a: Vec3Like, b: Vec3Like) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const at = (p: Vec3Like) => `(${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)})`;
const mine = (l: Landmark, s: State) => l.dim === s.dim && (l.worldId ?? 'default') === s.worldId;

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
/** 自己的设施，近的在前；kinds 不给就全要 */
export function myFacilities(memory: Pick<WorldMemory, 'landmarks' | 'chests' | 'chestClock'>, s: State, kinds?: FacilityKind[]): Facility[] {
  const want = (k: FacilityKind) => !kinds || kinds.includes(k);
  const out: Facility[] = [];
  const stations = myStations(memory, s);
  if (want('chest')) {
    const clock = memory.chestClock(s.worldDay);
    for (const c of memory.chests(s.dim)) {
      if ((c.worldId ?? 'default') !== s.worldId) continue;
      const location = chestLocation(c, clock);
      out.push({ kind: 'chest', label: '用过的容器', pos: location.pos, dist: flat(location.pos, s.pos), radius: location.radius,
        precise: location.precise, observedAt: location.observedAt, text: `${describeChest(c, clock)}${location.precise ? `，${flat(location.pos, s.pos)}格` : ''}` });
    }
    for (const l of memory.landmarks()) {
      if (l.kind !== 'discovery' || !mine(l, s) || !isContainerLandmark(l.label)) continue;
      if (memory.chests(s.dim).some((c) => d3(c.pos, l.pos) <= 0.1)) continue;
      const location = chestLocation(l, clock);
      out.push({ kind: 'chest', label: l.label, pos: location.pos, dist: flat(location.pos, s.pos), radius: location.radius,
        precise: location.precise, observedAt: location.observedAt, text: `${l.label} ${location.text}，只记得地点，内容未知` });
    }
  }
  for (const l of stations) {
    if (isContainerLandmark(l.label)) continue;
    const kind: FacilityKind = l.label === '我的床' ? 'bed' : 'station';
    if (!want(kind)) continue;
    out.push({ kind, label: l.label, pos: l.pos, dist: flat(l.pos, s.pos), text: `${l.label.replace(/^我的/, '')} ${at(l.pos)} ${flat(l.pos, s.pos)}格` });
  }
  return out.sort((a, b) => a.dist - b.dist);
}
