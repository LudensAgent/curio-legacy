import type { Vec3Like } from '../../adapter/types.ts';
import { FACINGS, facingOfYaw, localMap, type Facing } from '../../perception/local.ts';
import { surroundings } from '../../perception/surroundings.ts';
import type { SkillCtx } from '../types.ts';

export type Rel = [number, number, number];

/** 模型常用的几种写法都认：at / to / pos / offset / rel / cell，数组、字符串、{f,u,r}。 */
export function relValue(a: Record<string, unknown>): unknown {
  const v = a.at ?? a.to ?? a.pos ?? a.position ?? a.offset ?? a.rel ?? a.cell;
  if (typeof v === 'string') return v.split(/[,\s]+/).filter(Boolean).map(Number);
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const f = o.f ?? o.forward ?? o.front, u = o.u ?? o.up, r = o.r ?? o.right;
    if ([f, u, r].every((n) => n !== undefined)) return [Number(f), Number(u), Number(r)];
  }
  return v;
}

export function parseRel(v: unknown, bounds: { f: number; u: [number, number]; r: number }): Rel | string {
  if (!Array.isArray(v) || v.length !== 3 || v.some((n) => !Number.isInteger(n))) return '需要 "at":[前,上,右] 三个整数，例如 {"at":[1,1,0]}';
  const [f, u, r] = v as number[];
  if (f === 0 && r === 0 && u < bounds.u[0]) return `够不到脚下 ${-u} 格：先挖/补支撑再下去`;
  if (Math.abs(f) > bounds.f || Math.abs(r) > bounds.r || u < bounds.u[0] || u > bounds.u[1]) {
    return `只能是身边的格子：前后 ±${bounds.f}、左右 ±${bounds.r}、上下 ${bounds.u[0]}..${bounds.u[1]}`;
  }
  return [f, u, r];
}

/** 绝对坐标："xyz":[x,y,z]、"x,y,z" 或 {"x":…,"y":…,"z":…}。 */
export function absValue(v: unknown): Vec3Like | null {
  const arr = typeof v === 'string' ? v.split(/[,\s]+/).filter(Boolean).map(Number)
    : Array.isArray(v) ? v.map(Number)
      : v && typeof v === 'object' ? [(v as Record<string, unknown>).x, (v as Record<string, unknown>).y, (v as Record<string, unknown>).z].map(Number)
        : null;
  return arr && arr.length === 3 && arr.every(Number.isFinite) ? { x: arr[0], y: arr[1], z: arr[2] } : null;
}

export function after(ctx: SkillCtx, facing: Facing | null, target?: Vec3Like) {
  const s = ctx.adapter.state();
  return {
    position: { ...s.pos },
    ...(target ? { targetCell: { ...target } } : {}),
    ...(facing !== null ? { local: localMap(ctx.adapter, s.pos, facing, ctx.senses.observeBlocks?.bind(ctx.senses)) } : {}),
    around: surroundings(ctx.adapter).text,
  };
}

/** 只认本次视线确认的方块状态；未观察 = 未知，不读墙后数据。 */
export function visibleStates(ctx: SkillCtx, positions: Vec3Like[]) {
  ctx.senses.refresh();
  return new Map((ctx.senses.observeBlocks?.(positions) ?? []).map((b) => [
    `${b.pos.x},${b.pos.y},${b.pos.z}`,
    { name: b.name, properties: b.properties ?? {} },
  ]));
}

export function visibleCells(ctx: SkillCtx, positions: Vec3Like[]) {
  ctx.senses.refresh();
  return new Map((ctx.senses.observeBlocks?.(positions) ?? []).map((b) => [`${b.pos.x},${b.pos.y},${b.pos.z}`, b.name]));
}

/** 世界坐标换回以脚为原点的 [前,上,右]。 */
const FWD: Record<Facing, [number, number]> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
const RGT: Record<Facing, [number, number]> = { N: [1, 0], E: [0, 1], S: [-1, 0], W: [0, -1] };

export function toRel(feet: Vec3Like, facing: Facing, p: Vec3Like): Rel {
  const dx = p.x - feet.x, dz = p.z - feet.z;
  return [dx * FWD[facing][0] + dz * FWD[facing][1], p.y - feet.y, dx * RGT[facing][0] + dz * RGT[facing][1]];
}

export function facingArg(raw: unknown, adapter: { eye(): { yaw: number } | null }): Facing | string {
  if (raw === undefined || raw === null) {
    const eye = adapter.eye();
    return eye ? facingOfYaw(eye.yaw) : 'N';
  }
  const f = String(raw).trim().toUpperCase();
  return FACINGS.includes(f as Facing) ? f as Facing : 'facing 只能是 N/E/S/W';
}
