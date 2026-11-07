/**
 * 步行观察边界：只被 walk_path 的执行链（src/skills/movement/walk.ts）引用。
 * 地图由合法视锥观测喂 VoxelMap：移动中持续更新当前身体周边格。
 * 观测遵守 Vision 的批次限制（≤32 格/次），变化报告整批合并喂给地图，不丢支撑拆除通知。
 */

import type {
  ChangeReport,
  Observation,
  Vec3Like,
  VoxelMap,
} from 'curio-minecraft-3d-memory';
import type { BlockObservation } from '../adapter/types.ts';
import type { SkillCtx } from './types.ts';

function toObservation(b: BlockObservation): Observation {
  // 库要求 state.properties 为 Record<string,string>；本边界把 boolean/number
  // 统一成语义字符串（如 open→'true'、level→'3'），不猜测、不补默认值。
  const properties = Object.fromEntries(Object.entries(b.properties ?? {}).map(([k, v]) => [k, String(v)]));
  return {
    worldId: b.worldId, dim: b.dimension, sessionId: b.sessionId,
    observedAt: b.observedAt, sequence: b.observationId,
    source: 'vision', evidence: 'seen', stateComplete: b.stateComplete === true,
    state: { name: b.name, properties }, pos: { ...b.pos },
  };
}

function dedupe(cells: Vec3Like[]): Vec3Like[] {
  const seen = new Set<string>();
  const out: Vec3Like[] = [];
  for (const c of cells) {
    const k = `${c.x},${c.y},${c.z}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ x: c.x, y: c.y, z: c.z });
  }
  return out;
}

/**
 * 观察一组格；遵守 Vision 的 ≤32 格/次批次限制。
 * 共享模式下只触发实际合法 Vision 观测（服务/真实视觉是唯一写者），不再写地图；
 * 独立模式下保持单次 observeBatch 的既有路径，供其自身的有界批测试使用。
 */
export function observeCells(ctx: SkillCtx, map: VoxelMap, cells: Vec3Like[]): ChangeReport | null {
  if (!ctx.senses.observeBlocks) return null;
  const unique = dedupe(cells);
  const shared = ctx.spatial !== undefined;
  const observations: Observation[] = [];
  for (let i = 0; i < unique.length; i += 32) {
    const batch = ctx.senses.observeBlocks(unique.slice(i, i + 32));
    // 共享模式：Vision 在返回前已通过服务同步写入并派发报告。
    if (shared) continue;
    for (const b of batch) observations.push(toObservation(b));
  }
  if (shared || observations.length === 0) return null;
  return map.observeBatch({ observations, unobserved: [] });
}

/** 身体附近的有界局部观察格：3×3 水平邻域 × 脚高/支撑/头/净空（3×3×4），不枚举包围矩形。 */
export function bodyLocalCells(pos: Vec3Like): Vec3Like[] {
  const fx = Math.floor(pos.x), fy = Math.floor(pos.y), fz = Math.floor(pos.z);
  const cells: Vec3Like[] = [];
  for (let x = fx - 1; x <= fx + 1; x++)
    for (let z = fz - 1; z <= fz + 1; z++)
      for (let y = fy - 1; y <= fy + 2; y++) cells.push({ x, y, z });
  return cells;
}

