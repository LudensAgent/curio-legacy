import type { GameAdapter, Vec3Like } from '../adapter/types.ts';
import { isSoftBlock, LIQUID_BLOCKS } from './surroundings.ts';

/**
 * 以身体为原点的局部坐标：[前, 上, 右]，前 = 指定的朝向（N/E/S/W）。
 * 模型用它说出“确切是哪一格”：[1,1,0] = 前方一格、高一格；[0,2,0] = 头顶上方那一格；[0,-1,0] = 脚下。
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

export function toWorld(feet: Vec3Like, facing: Facing, rel: [number, number, number]): Vec3Like {
  const [f, u, r] = rel;
  return { x: feet.x + FORWARD[facing][0] * f + RIGHT[facing][0] * r, y: feet.y + u, z: feet.z + FORWARD[facing][1] * f + RIGHT[facing][1] * r };
}

const AIR = new Set(['air', 'cave_air', 'void_air']);

/**
 * 身边的方块图（不透视）：以脚为原点的 5×5×5（上下 u=-1..3），从脚所在的空气出发，
 * 只有和身边连通的空气格、以及贴着这些空气格的方块才算“看得见/摸得到”，其余标 ?。
 * 行从前（f=+2）到后（f=-2），列从左（r=-2）到右（r=+2），中间那列就是自己（Y）。
 */
export function localMap(adapter: Pick<GameAdapter, 'blockAt'>, pos: Vec3Like, facing: Facing) {
  const feet = feetCell(pos);
  const R = 2, U0 = -1, U1 = 3;
  const key = (f: number, u: number, r: number) => `${f},${u},${r}`;
  const name = new Map<string, string | null>();
  const at = (f: number, u: number, r: number) => {
    const k = key(f, u, r);
    if (!name.has(k)) name.set(k, adapter.blockAt(toWorld(feet, facing, [f, u, r])));
    return name.get(k) ?? null;
  };
  const open = (n: string | null) => n !== null && (AIR.has(n) || isSoftBlock(n) || LIQUID_BLOCKS.has(n));
  // 从身体占的两格出发，沿连通的空气/软方块向外看
  const seen = new Set<string>();
  const queue: [number, number, number][] = [[0, 0, 0], [0, 1, 0]];
  for (const c of queue) seen.add(key(...c));
  for (let i = 0; i < queue.length; i++) {
    const [f, u, r] = queue[i];
    if (!open(at(f, u, r)) && !(f === 0 && r === 0 && (u === 0 || u === 1))) continue;
    for (const [df, du, dr] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const n: [number, number, number] = [f + df, u + du, r + dr];
      if (Math.abs(n[0]) > R || Math.abs(n[2]) > R || n[1] < U0 || n[1] > U1) continue;
      const k = key(...n);
      if (seen.has(k)) continue;
      seen.add(k);
      queue.push(n);
    }
  }
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
        const n = seen.has(key(f, u, r)) ? at(f, u, r) : null;
        row += n === null ? '?' : symbol(n);
      }
      rows.push(row);
    }
    layers[`u${u >= 0 ? '+' : ''}${u}`] = rows;
  }
  // 帮模型把方块图读成“能站哪、能往哪放”：读字符层做空间换算对模型很难，程序算好直接给
  const known = (f: number, u: number, r: number) => seen.has(key(f, u, r)) ? at(f, u, r) : null;
  const isOpen = (n: string | null) => n !== null && (AIR.has(n) || isSoftBlock(n)) && !LIQUID_BLOCKS.has(n);
  const isSolid = (n: string | null) => n !== null && !AIR.has(n) && !isSoftBlock(n) && !LIQUID_BLOCKS.has(n);
  const word = (f: number, u: number, r: number) => `${f > 0 ? '前' : f < 0 ? '后' : ''}${r < 0 ? '左' : r > 0 ? '右' : ''}${u > 0 ? `上${u}` : u < 0 ? `下${-u}` : ''}` || '原地';
  const stand: string[] = [], place: string[] = [];
  for (const u of [0, -1, 1]) for (let f = 1; f >= -1; f--) for (let r = -1; r <= 1; r++) {
    if (f === 0 && r === 0) continue;
    if (u === 1 && !isOpen(known(0, 2, 0))) continue; // 往上迈要先跳，头顶得空
    if (isOpen(known(f, u, r)) && isOpen(known(f, u + 1, r)) && isSolid(known(f, u - 1, r))) stand.push(`[${f},${u},${r}] ${word(f, u, r)}`);
  }
  for (const u of [0, -1, 1, 2]) for (let f = 1; f >= -1; f--) for (let r = -1; r <= 1; r++) {
    if (f === 0 && r === 0 && (u === 0 || u === 1)) continue;
    if (!isOpen(known(f, u, r))) continue;
    const touching = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([df, du, dr]) => isSolid(known(f + df, u + du, r + dr)));
    if (touching) place.push(`[${f},${u},${r}] ${word(f, u, r)}`);
  }
  return { facing, frame: '[前,上,右]；每层的行从前(f=+2)到后(f=-2)，列从左(r=-2)到右(r=+2)，中间是自己', legend, layers,
    spots: { stand: stand.slice(0, 8), place: place.slice(0, 8), note: 'stand：step 能直接迈到的格子；place：place_at 放得住的格子（贴着实心方块）；[0,0,0] 是自己脚下那格（放实心方块=跳起来垫脚；梯子等贴墙物可放进自己站的格子）' } };
}

export function describeCell(adapter: Pick<GameAdapter, 'blockAt'>, pos: Vec3Like): string {
  const n = adapter.blockAt(pos);
  return n === null ? '未知' : AIR.has(n) ? '空气' : n;
}
