import type { VoxelMap } from 'curio-minecraft-3d-memory';
import type { Vec3Like } from '../../adapter/types.ts';
import type { LandSearchBoundary } from '../../spatial/land-search.ts';
import type { SkillCtx } from '../types.ts';

/**
 * 边界观察：只对与当前搜索边界相关的有限格集合发起一次观察。
 * 观察结果必须让“相关格”的证据版本变化，才允许重新搜索；单纯新增无关格、
 * 进入新区块或总 observedCells 增加都不能单独授权重搜。
 */

export interface ObservationReceipt {
  boundary: LandSearchBoundary;
  cells: Vec3Like[];
  attempted: boolean;
  observed: number;
  /** 本批观察造成的 VoxelMap 已观测格增量（与“相关证据变化”分开报告）。 */
  newObservedCells: number;
  /** 边界相关格中证据版本/可观测性发生变化的具体格。 */
  relatedCells: Vec3Like[];
  relatedChanged: boolean;
  turned: boolean;
}

const PROBE_LIMIT = 32;
const directionStep: Record<LandSearchBoundary['direction'], Vec3Like> = {
  N: { x: 0, y: 0, z: -1 },
  E: { x: 1, y: 0, z: 0 },
  S: { x: 0, y: 0, z: 1 },
  W: { x: -1, y: 0, z: 0 },
  UP: { x: 0, y: 1, z: 0 },
  DOWN: { x: 0, y: -1, z: 0 },
  HERE: { x: 0, y: 0, z: 0 },
};

const cellOf = (p: Vec3Like): Vec3Like => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const keyOf = (p: Vec3Like) => `${p.x},${p.y},${p.z}`;

/**
 * 与边界相关的观察格：边界终点、落点支撑、身体占用格、transition 前方一格。
 * 不扫全向，也不把未知列整列加入。
 */
export function boundaryProbeCells(boundary: LandSearchBoundary, limit = PROBE_LIMIT): Vec3Like[] {
  const to = cellOf(boundary.to);
  const step = directionStep[boundary.direction];
  const cells = [
    to,
    { x: to.x, y: to.y - 1, z: to.z },
    { x: to.x, y: to.y + 1, z: to.z },
    { x: to.x + step.x, y: to.y, z: to.z + step.z },
    { x: to.x + step.x, y: to.y - 1, z: to.z + step.z },
    cellOf(boundary.from),
    { x: cellOf(boundary.from).x, y: cellOf(boundary.from).y + 1, z: cellOf(boundary.from).z },
  ];
  const seen = new Set<string>();
  return cells.filter((cell) => {
    const key = keyOf(cell);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit);
}

/** 一格当前证据的版本签名：未观测、观测 id、revision、freshness 共同决定。 */
function signatureOf(voxel: VoxelMap, dim: string, cell: Vec3Like): string {
  const view = voxel.cellAt(dim, cell.x, cell.y, cell.z);
  if (!view.observed) return 'unknown';
  return `${view.evidence.revision}:${view.evidence.freshness}:${view.evidence.observation.state.name}`;
}

function yawTo(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz);
}

export async function observeBoundary(
  ctx: SkillCtx,
  opts: { boundary: LandSearchBoundary; maxCells: number },
): Promise<ObservationReceipt> {
  const spatial = ctx.spatial;
  const state = ctx.adapter.state();
  const voxel = spatial?.session?.voxel;
  const cells = boundaryProbeCells(opts.boundary, Math.max(0, Math.min(PROBE_LIMIT, opts.maxCells)));
  const before = new Map(cells.map((cell) => [keyOf(cell), voxel === undefined ? 'unknown' : signatureOf(voxel, state.dim, cell)]));
  const base = {
    boundary: opts.boundary, cells, attempted: false, observed: 0, newObservedCells: 0,
    relatedCells: [] as Vec3Like[], relatedChanged: false, turned: false,
  };
  if (voxel === undefined || ctx.senses.observeBlocks === undefined || cells.length === 0) return base;
  const observedCellsBefore = voxel.checkpointFullCounts().observedCells;

  const observeOnce = () => ctx.senses.observeBlocks!(cells);
  let observed = observeOnce();
  let turned = false;
  // 7.4：当前视角没有取得相关格时，朝边界方向最多转一次头再观察一次；不做无界扫描。
  if (!observed.some((block) => cells.some((cell) => cell.x === block.pos.x && cell.y === block.pos.y && cell.z === block.pos.z))) {
    const eye = ctx.adapter.eye();
    const target = opts.boundary.to;
    if (eye !== null) {
      const dx = target.x + 0.5 - eye.x, dy = target.y + 0.5 - eye.y, dz = target.z + 0.5 - eye.z;
      await ctx.adapter.look(yawTo(dx, dz), Math.atan2(dy, Math.hypot(dx, dz)), ctx.signal);
      turned = true;
      observed = observeOnce();
    }
  }

  const relatedCells = cells.filter((cell) => signatureOf(voxel, state.dim, cell) !== before.get(keyOf(cell)));
  return {
    ...base,
    attempted: true,
    observed: observed.length,
    newObservedCells: voxel.checkpointFullCounts().observedCells - observedCellsBefore,
    relatedCells,
    relatedChanged: relatedCells.length > 0,
    turned,
  };
}
