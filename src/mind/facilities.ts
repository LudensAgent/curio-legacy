import type { Vec3Like } from '../adapter/types.ts';
import { isResourceBlock } from '../memory/ore-spots.ts';
import { passageDeepestAnchor, passageFarthestAnchor, passageLevels, passageRoute } from '../memory/passages.ts';
import type { Landmark, PassageRecord, WorldMemory } from '../memory/store.ts';
import { STATION_LABEL } from '../skills/stations.ts';
import { chestLocation, describeChest, isContainerLandmark } from '../memory/chest-memory.ts';
import { dirName } from '../perception/perception.ts';

/** 算“设施”的地标：工作台、熔炉、床、箱子这些功能方块，加上农田；盖的房子在 my_builds 里另说 */
export const FACILITY_LABELS = new Set([...Object.values(STATION_LABEL), '我的床', '我的农田']);

/**
 * “我的设施”：自己在世界里留下、以后还能接着用的东西——箱子、工作台熔炉这些工作站、床、挖过的通道。
 * 以前它们各记各的、只在“认真想”时混在一堆地点里给出去，于是它存了东西不去拿、有矿道还从脚下重新挖。
 * 这里是查它们的统一入口：认真想时列出来，需要的时候（缺材料、想下矿）按需提一句。
 */
export type FacilityKind = 'chest' | 'station' | 'bed' | 'passage';
export interface Facility { kind: FacilityKind; label: string; pos: Vec3Like; dist: number; text: string; radius?: number; precise?: boolean; observedAt?: number; /** 通道：靠近历史路线点，不代表当前在通道里 */ inside?: boolean; /** 通道：沿旧矿道回入口的下一个路点（几何记忆，未验证当前地形） */ next?: Vec3Like }

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

/** 历史通道记录：地表参考点、曾到达的高度以及附近记忆，不推断当前通路。 */
export function describePassage(rec: PassageRecord, here: Vec3Like, stations: Landmark[] = [], resources: Landmark[] = []): { text: string; entrance: Vec3Like; dist: number; inside: boolean; next?: Vec3Like; nextDown?: Vec3Like } {
  const recs = [rec]; // 入口/最深两个方向共用一张图，避免同一份记录建两次
  // 桥/路：没有挖矿专属字段，只给两端、长度和沿桥回近端的下一步
  if (rec.kind === 'bridge') {
    const ends = rec.path.length ? [rec.path[0], rec.path[rec.path.length - 1]] : rec.entrances;
    const entrance = [...ends].sort((a, b) => flat(a, here) - flat(b, here))[0];
    const dist = flat(entrance, here);
    const inside = rec.path.some((p) => d3(p, here) <= 2);
    const route = passageRoute(recs, here, entrance, { near: 6 });
    const next = route && route.length > 1 ? route[1] : undefined;
    const otherEnd = ends.find((e) => d3(e, entrance) > 1);
    const text = `我搭的桥${ends.length >= 2 ? `，两端 ${at(ends[0])} 和 ${at(ends[1])}` : ''}${inside ? '，你正站在桥上' : `，近端 ${at(entrance)}（水平 ${dist} 格外）`}，桥面约 ${rec.path.length} 格${next ? `，沿桥往近端的下一步 ${at(next)}` : ''}${otherEnd ? `，另一端 ${at(otherEnd)}` : ''}；桥块被拆/被炸会自己清掉`;
    return { text, entrance, dist, inside, ...(next ? { next } : {}) };
  }
  // 身体有时把地下误判成 surface，会记出过深的假入口（y 比通道地表低很多）；先滤掉，只留贴近地表的
  const surfaceY = rec.path.length ? Math.max(...rec.path.map((p) => p.y)) : Math.max(...rec.entrances.map((e) => e.y));
  const validEntrances = rec.entrances.filter((e) => surfaceY - e.y <= 6);
  const entrance = [...validEntrances].sort((a, b) => flat(a, here) - flat(b, here))[0]
    ?? [...rec.path].sort((a, b) => b.y - a.y)[0];
  const dist = flat(entrance, here);
  const inside = rec.path.some((p) => d3(p, here) <= 3);
  // 站在旧矿道里时，沿它从脚下回到入口的几何路线（只给方向，未验证点间通行或当前地形）
  const route = passageRoute(recs, here, entrance, { near: 6 });
  const next = route && route.length > 1 ? route[1] : undefined;
  // 下行方向：朝这条通道记下的最深脚点走（想下更深时给下一步；已在最深点下面则不给）
  const deepest = [...rec.path].sort((a, b) => a.y - b.y)[0];
  const routeDown = passageRoute(recs, here, deepest, { near: 6 });
  const nextDown = routeDown && routeDown.length > 1 ? routeDown[1] : undefined;
  const levels = passageLevels(rec).filter((y) => y !== entrance.y);
  const ores = Object.entries(rec.ores).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, c]) => `${n}×${c}`);
  const near = (l: Landmark, r: number) => rec.path.some((p) => d3(p, l.pos) <= r);
  const things = [...new Set(stations.filter((l) => near(l, 4)).map((l) => l.label.replace(/^我的/, '')))];
  const seen = [...new Set(resources.filter((l) => isResourceBlock(l.label) && near(l, 6)).map((l) => l.label))].slice(0, 3);
  // 真实洞口：离入口最近的最高脚点（可能比记的地表入口低一两格），告诉心智要从地表往下挖几格
  const opening = [...rec.path].filter((p) => flat(p, entrance) <= 6).sort((a, b) => b.y - a.y)[0];
  const depthHint = opening && entrance.y - opening.y >= 2 ? `，通道脚点最高 y${opening.y}（比入口低 ${entrance.y - opening.y} 格，从地表往下挖）` : '';
  const where = `${validEntrances.length ? `入口 ${at(entrance)}` : `历史路线最高记录点 ${at(entrance)}`}${depthHint}${inside ? '，你正沿着这条旧矿道' : `（水平 ${dist} 格外）`}${next ? `，沿旧矿道回入口的下一个路点 ${at(next)}` : ''}`;
  // 只报从 here 真的走得到的深度：here 离网太远或目标走不到时 passageRoute 返回 null，不猜。
  // 两侧同源比较脚点表里的最低 y（pathLow）；deepestY 可能来自抽稀前的观测，单独说明，不断言在哪一段。
  const reach = passageDeepestAnchor(recs, here);
  const reached = (reach ? passageRoute(recs, here, reach, { near: 6 }) : null)?.at(-1) ?? null;
  const pathLow = rec.path.length ? Math.min(...rec.path.map((p) => p.y)) : rec.deepestY;
  const reachNote = reached && reached.y > pathLow + 2
    ? `；从你现在的位置沿记录方向能到 y${reached.y}；记录里更低的脚点 y${pathLow} 这次走不到（可能是反向落差或另一段，尚未验证）`
    : '';
  const observedNote = rec.path.length > 0 && rec.deepestY < pathLow - 2
    ? `；记录里还有更低的观测点 y${rec.deepestY}，脚点表未保留/没在这一段`
    : '';
  // 下界找要塞/结构探索要的是“更远”，不是“更深”；主世界下矿仍以最深为主。
  const far = rec.dim === 'the_nether' ? passageFarthestAnchor(recs, here, { reachableOnly: true }) : null;
  const farDist = far ? Math.hypot(far.x - here.x, far.z - here.z) : 0;
  const farNote = far && farDist >= 16
    ? `；沿记录方向水平最远能到 ${at(far)}，约 ${Math.round(farDist)} 格（${dirName(far.x - here.x, far.z - here.z)}），沿途是旧几何，当前是否可通需现场确认`
    : '';
  const text = `${where}，曾到达最低 y${rec.deepestY}${reachNote}${observedNote}${farNote}`
    + `${levels.length ? `，历史脚点较多的高度有 y${levels.join('、y')}` : ''}${ores.length ? `，挖到过 ${ores.join('、')}` : ''}`
    + `${seen.length ? `，历史路线附近记得见过 ${seen.join('、')}` : ''}${things.length ? `，历史路线附近记得有${things.join('、')}` : ''}${validEntrances.length ? '；洞口可能被堵或地形变了，走到附近再确认' : '；当前路线是否可通尚未确认'}`;
  return { text, entrance, dist, inside, ...(next ? { next } : {}), ...(nextDown ? { nextDown } : {}) };
}

/** 自己的设施，近的在前；kinds 不给就全要 */
export function myFacilities(memory: Pick<WorldMemory, 'landmarks' | 'chests' | 'passages' | 'chestClock'>, s: State, kinds?: FacilityKind[]): Facility[] {
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
  if (want('passage')) {
    const resources = memory.landmarks().filter((l) => l.kind === 'resource' && mine(l, s));
    for (const rec of memory.passages(s.dim)) {
      if (rec.worldId && rec.worldId !== s.worldId) continue;
      if (rec.kind === 'walked') continue; // 只是走过的天然洞穴，不算"我挖的通道"
      const d = describePassage(rec, s.pos, stations, resources);
      const isBridge = rec.kind === 'bridge';
      out.push({ kind: 'passage', label: isBridge ? '我搭的桥' : '我挖的通道', pos: d.entrance, dist: d.inside ? 0 : d.dist,
        text: `${isBridge ? '我搭的桥' : '挖过的通道'}：${d.text}${isBridge ? '' : `；记录 ${rec.id}（passages 查询可读历史脚点）`}`, inside: d.inside, ...(d.next ? { next: d.next } : {}) });
    }
  }
  return out.sort((a, b) => a.dist - b.dist);
}
