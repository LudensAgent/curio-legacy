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
    // Same destination cell projection as the legacy host risk check.
    const x = Math.floor(edge.to.x), y = Math.floor(edge.to.y + 0.05), z = Math.floor(edge.to.z);
    const feet = recordedName(read, x, y, z);
    if (feet !== null && isDangerousBlock(feet)) {
      return { allow: false, reason: `host policy rejects recorded dangerous block ${feet} at the destination feet cell` };
    }
    const head = recordedName(read, x, y + 1, z);
    if (head !== null && isDangerousBlock(head)) {
      return { allow: false, reason: `host policy rejects recorded dangerous block ${head} at the destination head cell` };
    }
    if (head !== null && isWaterBlock(head)) {
      return { allow: false, reason: `host policy rejects recorded water ${head} at the destination head cell (submersion)` };
    }
    if (!wade && feet !== null && isWaterBlock(feet)) {
      return { allow: false, reason: `host policy rejects recorded water ${feet} at the destination feet cell; wading was not delegated` };
    }
    const support = recordedName(read, x, y - 1, z);
    if (support !== null && isDangerousBlock(support)) {
      return { allow: false, reason: `host policy rejects recorded dangerous block ${support} at the destination support cell` };
    }
    const lavaNeighbors = HORIZONTAL.reduce((count, [dx, dz]) => count
      + [y, y - 1].filter((height) => {
        const name = recordedName(read, x + dx, height, z + dz);
        return name !== null && isLava(name);
      }).length, 0);
    return lavaNeighbors === 0 ? { allow: true } : { allow: true, extraCost: lavaNeighbors * LAVA_EDGE_COST };
  },
});

export const hostLandEdgePolicy = policyFor('host-land-edge-policy.danger-set.fall-only.dry.lava-neighbor-3.v2', new Set(['fall']), false);
export const hostWadingEdgePolicy = policyFor('host-land-edge-policy.danger-set.fall-wade.lava-neighbor-3.v2', new Set(['fall', 'water_contact']), true);
