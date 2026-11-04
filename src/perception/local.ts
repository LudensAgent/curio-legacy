import type { GameAdapter, Vec3Like } from '../adapter/types.ts';
import { config } from '../config.ts';
import { isSoftBlock, LIQUID_BLOCKS } from './surroundings.ts';
import { bodyProbe, footSurfaceY, hasAnyCollision, isPassableDoor, isReplaceable, placementReference, supportTop, type ObservedState } from './geometry.ts';

/**
 * 以身体为原点的局部坐标：[前, 上, 右]，前 = 指定的朝向（N/E/S/W）。
 * 模型用它说出“确切是哪一格”：[1,1,0] = 前方一格、高一格；[0,2,0] = 头顶上方那一格；[0,-1,0] = 脚部下方支撑格。
 */
export type Facing = 'N' | 'E' | 'S' | 'W';
export const FACINGS: Facing[] = ['N', 'E', 'S', 'W'];
const FORWARD: Record<Facing, [number, number]> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
const RIGHT: Record<Facing, [number, number]> = { N: [1, 0], E: [0, 1], S: [-1, 0], W: [0, -1] };

/** mineflayer 的 yaw：0 朝北，π/2 朝西，π 朝南，-π/2 朝东 */
export function facingOfYaw(yaw: number): Facing {
  const a = ((yaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const i = Math.round(a / (Math.PI / 2)) % 4;
  return (['N', 'W', 'S', 'E'] as Facing[])[i];
}

export const feetCell = (pos: Vec3Like): Vec3Like => ({ x: Math.floor(pos.x), y: Math.floor(pos.y + 0.05), z: Math.floor(pos.z) });

/**
 * 脚下实际支撑的那一格：半砖、耕地、床这类高度不足一格的方块，支撑就在脚所在那格本身（脚高是 x.5 之类），
 * 而整块方块的支撑在脚下一格。所以“往下挖一格”要挖的是这一格，不能拿 feetCell 的 y-1 直接套。
 */
export const supportCell = (pos: Vec3Like): Vec3Like => ({ x: Math.floor(pos.x), y: Math.floor(pos.y - 0.05), z: Math.floor(pos.z) });

export function toWorld(feet: Vec3Like, facing: Facing, rel: [number, number, number]): Vec3Like {
  const [f, u, r] = rel;
  return { x: feet.x + FORWARD[facing][0] * f + RIGHT[facing][0] * r, y: feet.y + u, z: feet.z + FORWARD[facing][1] * f + RIGHT[facing][1] * r };
}

const AIR = new Set(['air', 'cave_air', 'void_air']);

/**
 * 身边的方块图（不透视）：以脚为原点的 (2R+1)×6×(2R+1)（上下 u=-2..3），包含下一级落点的支撑层。
 * R 由 LOCAL_MAP_RADIUS 配置（默认 4，即 9×9）。只显示本次视觉确认的格子；身体所在的两格标 Y，
 * 其余未知标 ?（视野外、被挡或没加载的格子都是 ?）。行从前（f=+R）到后（f=-R），列从左（r=-R）到右（r=+R）。
 * spots.stand/place 与 step/place_at 用同一套碰撞形状判断，未知格一律不当作空气或空位。
 */
export function localMap(_adapter: Pick<GameAdapter, 'blockAt'>, pos: Vec3Like, facing: Facing,
  observe?: (positions: Vec3Like[]) => readonly { name: string; pos: Vec3Like; properties?: Record<string, string | number | boolean> }[], radius = config.vision.localRadius) {
  const feet = feetCell(pos);
  const R = Math.max(1, Math.min(8, Math.floor(radius))), U0 = -2, U1 = 3;
  const key = (p: Vec3Like) => `${p.x},${p.y},${p.z}`;
  const positions: Vec3Like[] = [];
  for (let u = U0; u <= U1; u++) for (let f = -R; f <= R; f++) for (let r = -R; r <= R; r++) positions.push(toWorld(feet, facing, [f, u, r]));
  const observed = new Map<string, ObservedState>(Array.from({ length: Math.ceil(positions.length / 32) }, (_, i) => observe?.(positions.slice(i * 32, (i + 1) * 32)) ?? [])
    .flat().map((block) => [key(block.pos), { name: block.name, properties: block.properties ?? {} }]));
  const at = (f: number, u: number, r: number): ObservedState | null => observed.get(key(toWorld(feet, facing, [f, u, r]))) ?? null;
  const stateAtWorld = (p: Vec3Like): ObservedState | null => observed.get(key(p)) ?? null;
  const legend: Record<string, string> = { '.': '空气', Y: '自己', '?': '看不见/未知' };
  const charOf = new Map<string, string>();
  const pool = 'ABCDEFGHIJKLMNOPQRSTUVWXZ0123456789';
  const symbol = (n: string) => {
    if (AIR.has(n)) return '.';
    if (n === 'water') { legend['~'] = 'water'; return '~'; }
    if (n === 'lava') { legend['!'] = 'lava'; return '!'; }
    let c = charOf.get(n);
    if (!c) {
      const first = n.replace(/^(minecraft:)/, '')[0]?.toUpperCase() ?? 'A';
      c = pool.includes(first) && ![...charOf.values()].includes(first) ? first : [...pool].find((x) => ![...charOf.values()].includes(x)) ?? '#';
      charOf.set(n, c); legend[c] = n;
    }
    return c;
  };
  const layers: Record<string, string[]> = {};
  for (let u = U1; u >= U0; u--) {
    const rows: string[] = [];
    for (let f = R; f >= -R; f--) {
      let row = '';
      for (let r = -R; r <= R; r++) {
        if (f === 0 && r === 0 && (u === 0 || u === 1)) { row += 'Y'; continue; }
        const n = at(f, u, r);
        row += n === null ? '?' : symbol(n.name);
      }
      rows.push(row);
    }
    layers[`u${u >= 0 ? '+' : ''}${u}`] = rows;
  }
  // 帮模型把方块图读成“能站哪、能往哪放”：用与 step/place_at 相同的碰撞顶面、身体净空和贴面判断，
  // 不再按方块名猜“实心/空”，也不把未知格补成可站/可放。
  const isOpen = (s: ObservedState | null) => !!s && (AIR.has(s.name) || isSoftBlock(s.name) || isPassableDoor(s.name, s.properties ?? {})) && !LIQUID_BLOCKS.has(s.name);
  const blocksEntry = (s: ObservedState | null) => {
    if (!s || isOpen(s)) return false;
    const top = supportTop(s.name, s.properties ?? {});
    return top !== null ? top >= 1 - 1e-6 : hasAnyCollision(s.name, s.properties ?? {});
  };
  const word = (f: number, u: number, r: number) => `${f > 0 ? '前' : f < 0 ? '后' : ''}${r < 0 ? '左' : r > 0 ? '右' : ''}${u > 0 ? `上${u}` : u < 0 ? `下${-u}` : ''}` || '原地';
  const stand: string[] = [], place: string[] = [];
  for (const u of [0, -1, 1]) for (let f = 1; f >= -1; f--) for (let r = -1; r <= 1; r++) {
    if (f === 0 && r === 0) continue;
    if (u === 1 && !isOpen(at(0, 2, 0))) continue; // 往上迈要先跳，头顶得空
    const cell = toWorld(feet, facing, [f, u, r]);
    const state = stateAtWorld(cell);
    if (!state || blocksEntry(state)) continue;
    const foot = footSurfaceY(cell, stateAtWorld);
    if (foot === null) continue;
    // 和 step 的相对目标一致：只列相对脚格 ±0.51 内的实际支撑面。
    if (Math.abs(foot - (feet.y + u)) > 0.51) continue;
    const probe = bodyProbe(foot, cell.x, cell.z, stateAtWorld);
    if (probe.unknown.length || probe.blockers.length) continue;
    const offset = Math.abs(foot - (feet.y + u)) > 0.01 ? `（脚高 ${foot.toFixed(2)}）` : '';
    stand.push(`[${f},${u},${r}] ${word(f, u, r)}${offset}`);
  }
  for (const u of [0, -1, 1, 2]) for (let f = 1; f >= -1; f--) for (let r = -1; r <= 1; r++) {
    if (f === 0 && r === 0 && (u === 0 || u === 1)) continue;
    const cell = toWorld(feet, facing, [f, u, r]);
    const state = stateAtWorld(cell);
    if (!state || !isReplaceable(state.name)) continue;
    if (placementReference(cell, stateAtWorld, null) !== 'observed') continue;
    place.push(`[${f},${u},${r}] ${word(f, u, r)}`);
  }
  return { facing, source: 'current_vision', frame: `[前,上,右]；每层的行从前(f=+${R})到后(f=-${R})，列从左(r=-${R})到右(r=+${R})，中间是自己；只显示本次看见的格子，? 是未知`, legend, layers,
    spots: { stand: stand.slice(0, 8), place: place.slice(0, 8), note: 'stand 是脚部目标格（括号里的脚高按实际碰撞顶面，半砖/雪层等可为分数）；place 是已看清的空位且旁边有已观察的可贴面方块。两者都按当前可见格和碰撞形状估计，未知格不计入；实际移动和放置仍需动作确认。[0,0,0] 是当前脚部占据格，[0,-1,0] 是其下方支撑格' } };
}

export function describeCell(adapter: Pick<GameAdapter, 'blockAt'>, pos: Vec3Like): string {
  const n = adapter.blockAt(pos);
  return n === null ? '未知' : AIR.has(n) ? '空气' : n;
}
