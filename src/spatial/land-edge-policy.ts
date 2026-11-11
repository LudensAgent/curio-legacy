import type {
  LandSearchEdgePolicy,
  LandSearchPolicyDecision,
  LandSearchPolicyEdge,
  LandSearchPolicyRead,
} from 'curio-minecraft-3d-memory/navigation';

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
 * 身体从 from 到 to 扫过的格子（0.6×1.8 身体在两端的并集包围盒，覆盖斜向拐角与台阶/下落的两段）。
 * 火、岩浆等危险格只要与身体重叠就会伤人，不只落点那三格。
 */
export function sweptBodyCells(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }) {
  const minX = Math.floor(Math.min(from.x, to.x) - 0.3 + 1e-6), maxX = Math.floor(Math.max(from.x, to.x) + 0.3 - 1e-6);
  const minZ = Math.floor(Math.min(from.z, to.z) - 0.3 + 1e-6), maxZ = Math.floor(Math.max(from.z, to.z) + 0.3 - 1e-6);
  const minY = Math.floor(Math.min(from.y, to.y) + 1e-6), maxY = Math.floor(Math.max(from.y, to.y) + 1.8 - 1e-6);
  const cells: { x: number; y: number; z: number }[] = [];
  for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) for (let z = minZ; z <= maxZ; z++) cells.push({ x, y, z });
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
const policyFor = (version: string, allowedHazards: ReadonlySet<string>, wade: boolean): LandSearchEdgePolicy => ({
  version,
  evaluate(edge: LandSearchPolicyEdge, read: LandSearchPolicyRead): LandSearchPolicyDecision {
    const nonFall = [...new Set(edge.hazards
      .filter((hazard) => !allowedHazards.has(hazard.kind))
      .map((hazard) => hazard.kind))];
    if (nonFall.length > 0) {
      return { allow: false, reason: `host policy rejects geometric ${nonFall.join(', ')} hazard; only ${[...allowedHazards].join(', ')} is allowed` };
    }
    const x = Math.floor(edge.to.x), y = Math.floor(edge.to.y + 0.05), z = Math.floor(edge.to.z);
    // 身体扫过的每一格：火、岩浆等与身体重叠即伤人；几何评估只报岩浆/水，火要在这里读。
    for (const cell of sweptBodyCells(edge.from, edge.to)) {
      const name = recordedName(read, cell.x, cell.y, cell.z);
      if (name !== null && isDangerousBlock(name)) {
        return { allow: false, reason: `host policy rejects recorded dangerous block ${name} at (${cell.x},${cell.y},${cell.z}) in the swept body` };
      }
    }
    const feet = recordedName(read, x, y, z);
    const head = recordedName(read, x, y + 1, z);
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
    // 旁边的岩浆会流动、也可能被碰到：脚部、头部与脚下一层的岩浆邻格都加价，规划更愿意离远一点。
    const lavaNeighbors = HORIZONTAL.reduce((count, [dx, dz]) => count
      + [y + 1, y, y - 1].filter((height) => {
        const name = recordedName(read, x + dx, height, z + dz);
        return name !== null && isLava(name);
      }).length, 0);
    return lavaNeighbors === 0 ? { allow: true } : { allow: true, extraCost: lavaNeighbors * LAVA_EDGE_COST };
  },
});

export const hostLandEdgePolicy = policyFor('host-land-edge-policy.danger-swept.fall-only.dry.lava-neighbor-3.v3', new Set(['fall']), false);
export const hostWadingEdgePolicy = policyFor('host-land-edge-policy.danger-swept.fall-wade.lava-neighbor-3.v3', new Set(['fall', 'water_contact']), true);
