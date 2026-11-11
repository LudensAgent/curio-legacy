import type {
  LandSearchEdgePolicy,
  LandSearchPolicyDecision,
  LandSearchPolicyEdge,
  LandSearchPolicyRead,
} from 'curio-minecraft-3d-memory/navigation';
import { supportTop } from '../perception/geometry.ts';

/**
 * Host-owned admission/cost policy for geometrically OPEN land-search edges.
 *
 * It reproduces the legacy host checks: reject non-fall geometric hazards and
 * recorded dangerous destination cells, then price remembered lava beside the
 * destination. Recorded facts may be stale, foreign-session or incomplete, so
 * the surcharge is a delegation preference for keeping distance from known
 * lava, not a claim that the cells are currently passable.
 */

const DANGER = new Set(['lava', 'fire', 'soul_fire', 'magma_block', 'campfire', 'soul_campfire', 'cactus', 'sweet_berry_bush', 'powder_snow', 'cobweb', 'pointed_dripstone']);

/** Observed block name (bare or minecraft: prefixed) in the legacy danger set. */
export const isDangerousBlock = (name: string): boolean => DANGER.has(name.replace(/^minecraft:/, ''));

/** Legacy per-neighbor surcharge for a remembered lava cell beside the destination. */
export const LAVA_EDGE_COST = 3;

const HORIZONTAL = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
const isLava = (name: string): boolean => name.replace(/^minecraft:/, '') === 'lava';
const WATER = new Set(['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass']);
/** Observed water (bare or minecraft: prefixed). step/drop geometry reports only fall, so the policy reads water itself. */
export const isWaterBlock = (name: string): boolean => WATER.has(name.replace(/^minecraft:/, ''));

/**
 * 身体从 from 到 to 将要新进入的格子（0.6×1.8 身体在两端的并集包围盒，覆盖斜向拐角与台阶/下落的两段），
 * 不含身体此刻已占据的格：站在火里时必须还能走出去。火、岩浆等危险格只要与身体重叠就会伤人，不只落点那三格。
 */
export function sweptBodyCells(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }) {
  const span = (lo: number, hi: number) => [Math.floor(lo + 1e-6), Math.floor(hi - 1e-6)] as const;
  const [fx0, fx1] = span(from.x - 0.3, from.x + 0.3), [fz0, fz1] = span(from.z - 0.3, from.z + 0.3), [fy0, fy1] = span(from.y, from.y + 1.8);
  const [minX, maxX] = span(Math.min(from.x, to.x) - 0.3, Math.max(from.x, to.x) + 0.3);
  const [minZ, maxZ] = span(Math.min(from.z, to.z) - 0.3, Math.max(from.z, to.z) + 0.3);
  const [minY, maxY] = span(Math.min(from.y, to.y), Math.max(from.y, to.y) + 1.8);
  const cells: { x: number; y: number; z: number }[] = [];
  for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) for (let z = minZ; z <= maxZ; z++) {
    if (x >= fx0 && x <= fx1 && y >= fy0 && y <= fy1 && z >= fz0 && z <= fz1) continue;
    cells.push({ x, y, z });
  }
  return cells;
}

/** 落点脚下被身体脚面覆盖的支撑格（岩浆块等站上去就伤人）。 */
export function supportCellsUnder(to: { x: number; y: number; z: number }) {
  const y = Math.floor(to.y + 0.05) - 1;
  const cells: { x: number; y: number; z: number }[] = [];
  for (let x = Math.floor(to.x - 0.3 + 1e-6); x <= Math.floor(to.x + 0.3 - 1e-6); x++)
    for (let z = Math.floor(to.z - 0.3 + 1e-6); z <= Math.floor(to.z + 0.3 - 1e-6); z++) cells.push({ x, y, z });
  return cells;
}

const recordedName = (read: LandSearchPolicyRead, x: number, y: number, z: number): string | null => {
  const cell = read.cell(x, y, z);
  return cell.kind === 'recorded' ? cell.state.name : null;
};

/**
 * 委托显式允许涉水（swim:true）时，接受身体接触水的地面边；淹没、水流与气泡柱仍拒绝。
 * 其余危险格、岩浆加价规则与默认策略完全相同。
 */
/**
 * 水平跳跃的执行能力：身体控制原地起跳、不助跑不疾跑，只能稳定跨过 1 格宽的缺口（水平 2 格）。
 * 更宽的缺口执行必然落空掉进缺口，属于程序能力限制，不规划。
 */
export const MAX_GAP_JUMP_HORIZONTAL = 2;
/** 跳跃落空时会落进缺口：往下看这么多格，先碰到危险格就不规划这次跳跃。 */
const GAP_FALL_LOOKDOWN = 8;

const policyFor = (version: string, allowedHazards: ReadonlySet<string>, wade: boolean): LandSearchEdgePolicy => ({
  version,
  evaluate(edge: LandSearchPolicyEdge, read: LandSearchPolicyRead): LandSearchPolicyDecision {
    if (edge.kind === 'jump') {
      const horizontal = Math.hypot(edge.to.x - edge.from.x, edge.to.z - edge.from.z);
      if (horizontal > MAX_GAP_JUMP_HORIZONTAL + 0.01) {
        return { allow: false, reason: `host body control jumps from standing without a run-up and cannot clear a ${horizontal.toFixed(1)}-block horizontal gap jump (limit ${MAX_GAP_JUMP_HORIZONTAL})` };
      }
      // 缺口下方：起点列与落点列之间被跨过的列，从脚下一层往下找第一个非空格；是危险格就拒绝。
      const fromCol = { x: Math.floor(edge.from.x), z: Math.floor(edge.from.z) }, toCol = { x: Math.floor(edge.to.x), z: Math.floor(edge.to.z) };
      const steps = Math.max(Math.abs(toCol.x - fromCol.x), Math.abs(toCol.z - fromCol.z));
      for (let i = 1; i < steps; i++) {
        const gx = fromCol.x + Math.sign(toCol.x - fromCol.x) * i, gz = fromCol.z + Math.sign(toCol.z - fromCol.z) * i;
        for (let dy = 1; dy <= GAP_FALL_LOOKDOWN; dy++) {
          const name = recordedName(read, gx, Math.round(edge.from.y) - dy, gz);
          if (name === null) break;
          if (isDangerousBlock(name)) {
            return { allow: false, reason: `host policy rejects a gap jump whose miss would land in recorded ${name} at (${gx},${Math.round(edge.from.y) - dy},${gz})` };
          }
          if (supportTop(name.replace(/^minecraft:/, '')) !== null || isWaterBlock(name)) break;
        }
      }
    }
    const nonFall = [...new Set(edge.hazards
      .filter((hazard) => !allowedHazards.has(hazard.kind))
      .map((hazard) => hazard.kind))];
    if (nonFall.length > 0) {
      return { allow: false, reason: `host policy rejects geometric ${nonFall.join(', ')} hazard; only ${[...allowedHazards].join(', ')} is allowed` };
    }
    const x = Math.floor(edge.to.x), y = Math.floor(edge.to.y + 0.05), z = Math.floor(edge.to.z);
    const feet = recordedName(read, x, y, z);
    if (feet !== null && isDangerousBlock(feet)) {
      return { allow: false, reason: `host policy rejects recorded dangerous block ${feet} at the destination feet cell` };
    }
    const head = recordedName(read, x, y + 1, z);
    if (head !== null && isDangerousBlock(head)) {
      return { allow: false, reason: `host policy rejects recorded dangerous block ${head} at the destination head cell` };
    }
    // 身体扫过的其余格：火、岩浆等与身体重叠即伤人；几何评估只报岩浆/水，火要在这里读。
    for (const cell of sweptBodyCells(edge.from, edge.to)) {
      if (cell.x === x && cell.z === z && (cell.y === y || cell.y === y + 1)) continue;
      const name = recordedName(read, cell.x, cell.y, cell.z);
      if (name !== null && isDangerousBlock(name)) {
        return { allow: false, reason: `host policy rejects recorded dangerous block ${name} at (${cell.x},${cell.y},${cell.z}) in the swept body` };
      }
    }
    if (head !== null && isWaterBlock(head)) {
      return { allow: false, reason: `host policy rejects recorded water ${head} at the destination head cell (submersion)` };
    }
    if (!wade && feet !== null && isWaterBlock(feet)) {
      return { allow: false, reason: `host policy rejects recorded water ${feet} at the destination feet cell; wading was not delegated` };
    }
    for (const cell of supportCellsUnder(edge.to)) {
      const support = recordedName(read, cell.x, cell.y, cell.z);
      if (support !== null && isDangerousBlock(support)) {
        return { allow: false, reason: `host policy rejects recorded dangerous block ${support} at the destination support cell` };
      }
    }
    // 落点脚底中心所在那一列必须自己有已记录的支撑：只靠邻列擦边（身体压住 0.01 格）几何上站得住，
    // 但身体连续行走时多滑一点就离开支撑掉下去（桥头、崖边）。站在水里（涉水/落水）不要求。
    if (edge.kind !== 'ladder' && !(feet !== null && isWaterBlock(feet))) {
      // 脚高接近整数：支撑是下面那格；分数脚高（半砖、雪层）：支撑就在脚所在那格。
      const supportY = Math.abs(edge.to.y - Math.round(edge.to.y)) <= 0.05 ? Math.round(edge.to.y) - 1 : Math.floor(edge.to.y);
      const cell = read.cell(x, supportY, z);
      if (cell.kind !== 'recorded' || supportTop(cell.state.name.replace(/^minecraft:/, ''), cell.state.properties) === null) {
        return { allow: false, reason: `host policy rejects a stance supported only by a neighbouring column's edge: no recorded support under the feet centre at (${x},${supportY},${z})` };
      }
    }
    // 旁边的岩浆会流动、也可能被碰到：脚部、头部与脚下一层的岩浆邻格都加价，规划更愿意离远一点。
    const lavaNeighbors = HORIZONTAL.reduce((count, [dx, dz]) => count
      + [y + 1, y, y - 1].filter((height) => {
        const name = recordedName(read, x + dx, height, z + dz);
        return name !== null && isLava(name);
      }).length, 0);
    return lavaNeighbors === 0 ? { allow: true } : { allow: true, extraCost: lavaNeighbors * LAVA_EDGE_COST };
  },
});

export const hostLandEdgePolicy = policyFor('host-land-edge-policy.danger-swept.centre-support.gap-jump-2.fall-only.dry.lava-neighbor-3.v5', new Set(['fall']), false);
export const hostWadingEdgePolicy = policyFor('host-land-edge-policy.danger-swept.centre-support.gap-jump-2.fall-wade.lava-neighbor-3.v5', new Set(['fall', 'water_contact']), true);
