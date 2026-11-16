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

/** 某一层里被身体脚面（0.6×0.6）覆盖的格；y 由调用方按整数/分数脚高决定。 */
export function supportColumnsUnder(to: { x: number; z: number }, y: number) {
  const cells: { x: number; y: number; z: number }[] = [];
  for (let x = Math.floor(to.x - 0.3 + 1e-6); x <= Math.floor(to.x + 0.3 - 1e-6); x++)
    for (let z = Math.floor(to.z - 0.3 + 1e-6); z <= Math.floor(to.z + 0.3 - 1e-6); z++) cells.push({ x, y, z });
  return cells;
}

/** 落点脚下被身体脚面覆盖的支撑格（岩浆块等站上去就伤人）。 */
export function supportCellsUnder(to: { x: number; y: number; z: number }) {
  return supportColumnsUnder(to, Math.floor(to.y + 0.05) - 1);
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
 * 水平跳跃的执行能力：身体控制走到起点边缘起跳、不疾跑，只能稳定跨过 1 格宽的缺口（水平 2 格）。
 * 更宽的缺口执行必然落空掉进缺口，属于程序能力限制，不规划。
 */
export const MAX_GAP_JUMP_HORIZONTAL = 2;
/** 跳跃落空时会落进缺口：往下看这么多格，先碰到危险格就不规划这次跳跃。 */
const GAP_FALL_LOOKDOWN = 8;

/** 边缘站姿（脚底中心是空/未知，但身体足印压住邻列已记录支撑）的额外代价。 */
export const EDGE_STANCE_COST = 6;

const policyFor = (version: string, allowedHazards: ReadonlySet<string>, wade: boolean): LandSearchEdgePolicy => ({
  version,
  evaluate(edge: LandSearchPolicyEdge, read: LandSearchPolicyRead): LandSearchPolicyDecision {
    if (edge.kind === 'jump') {
      const horizontal = Math.hypot(edge.to.x - edge.from.x, edge.to.z - edge.from.z);
      if (horizontal > MAX_GAP_JUMP_HORIZONTAL + 0.01) {
        return { allow: false, reason: `host body control jumps from the start edge without sprinting and cannot clear a ${horizontal.toFixed(1)}-block horizontal gap jump (limit ${MAX_GAP_JUMP_HORIZONTAL})` };
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
      const supportsFoot = (sx: number, sz: number) => {
        const cell = read.cell(sx, supportY, sz);
        if (cell.kind !== 'recorded') return false;
        // 楼梯等多面形状可能同时有低面和整块顶面；这里只确认该列有可站立支撑，
        // 具体脚高由 land-search 的 supportFaces 与执行层确认，不再用单一面高卡死。
        return supportTop(cell.state.name.replace(/^minecraft:/, ''), cell.state.properties) !== null;
      };
      const cell = read.cell(x, supportY, z);
      if (!supportsFoot(x, z)) {
        // 边缘站姿的脚底中心没有支撑：先看中心列下面会落到什么。连续行走会在停稳时滑过目标一点，
        // 若擦边的邻列旁边就是水/岩浆，这一点滑移就足以让人掉进去——这种站姿不能按“旧矿道桥头”放行。
        if (cell.kind === 'recorded') {
          for (let dy = 0; dy < GAP_FALL_LOOKDOWN; dy++) {
            const below = recordedName(read, x, supportY - dy, z);
            if (below === null) break; // 再往下没有已记录事实，按下面的观察/拒绝路径处理
            if (isWaterBlock(below)) {
              return { allow: false, reason: `host policy rejects an edge stance whose unsupported feet-centre column drops into recorded water at (${x},${supportY - dy},${z})` };
            }
            if (isDangerousBlock(below)) {
              return { allow: false, reason: `host policy rejects recorded dangerous block ${below} below the unsupported feet centre at (${x},${supportY - dy},${z})` };
            }
            if (supportTop(below.replace(/^minecraft:/, '')) !== null) break; // 下面是实地：落下去也只是小落差
          }
        }
        // 身体足印覆盖到的邻列有已记录支撑：站得住，但连续行走可能滑出边缘，给额外代价。
        // 旧矿道/台阶大量是这种站姿；默认允许比“脚底中心必须自己有支撑”更接近原版。
        const edgeSupport = supportColumnsUnder(edge.to, supportY)
          .some((under) => (under.x !== x || under.z !== z) && supportsFoot(under.x, under.z));
        if (edgeSupport) return { allow: true, extraCost: EDGE_STANCE_COST };
        if (cell.kind === 'unknown') {
          // 未记录 ≠ 没有支撑：这一格可能只是还没看过。把它作为观察边界交回，
          // 让协调器看清脚底中心后再决定；不是永久策略拒绝。
          return { allow: false, observe: true, reason: `support under the feet centre at (${x},${supportY},${z}) is not recorded yet`,
            supportColumn: { minY: supportY, maxY: supportY } };
        }
        return { allow: false, reason: `host policy rejects a stance with no observed support under the feet centre or body footprint at (${x},${supportY},${z})` };
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

/** 策略拒绝是否来自火/岩浆等会伤人的格，而不是涉水未授权或支撑/跳跃能力限制。 */
export function isDangerPolicyRejection(reason: string): boolean {
  return reason.includes('recorded dangerous block')
    || reason.includes('gap jump whose miss would land in recorded')
    || reason.includes('lava_contact');
}

/** 策略拒绝是否由火/灵魂火引起：授权 dig 时它们可以被打掉，其余危险格不行。 */
export function isFirePolicyRejection(reason: string): boolean {
  return /(recorded dangerous block|gap jump whose miss would land in recorded) (minecraft:)?(soul_fire|fire)\b/.test(reason);
}

/**
 * 这个拒绝原因是否能由显式授权的 place 修复（补脚下支撑 / 搭桥跨过缺口），
 * 而不是液体、涉水未授权或危险格这类不能靠“垫一块”改变的安全/模式限制。
 */
export function isConstructionFixablePolicyRejection(reason: string): boolean {
  return reason.includes('no observed support under the feet centre or body footprint')
    || reason.includes('unsupported feet-centre column drops into recorded water')
    || (reason.includes('cannot clear a') && reason.includes('horizontal gap jump'));
}

/**
 * 这条策略拒绝能由哪种委托授权改变（事实，不是建议）：回执据此告诉代理换什么授权、
 * 还是任何授权都改不了，免得它反复用同一种授权重试同一条边。未知原因返回空串，不猜。
 */
export function policyRemedy(reason: string, opts: { fireClearable: boolean }): string {
  const geometric = reason.match(/geometric (.+?) hazard/)?.[1]?.split(', ') ?? [];
  if (geometric.includes('submersion') || reason.includes('destination head cell (submersion)')) {
    return '淹头/淹没：swim:true 只放宽脚格水和几何 water_contact，这条边授权也改不了；swim:true 的游泳段走 swim_path 的水面路线，不走这条边；';
  }
  if (reason.includes('destination feet cell; wading was not delegated')) return '脚格是水：swim:true 会让这条边变成涉水边；';
  const stillRejected = geometric.filter((kind) => kind !== 'water_contact');
  if (geometric.includes('water_contact')) {
    return stillRejected.length === 0
      ? '几何碰到水：water_contact 这类边要 swim:true 才允许；'
      : `几何碰到水：swim:true 只放宽 water_contact，${stillRejected.join('、')} 仍拒绝这条边；`;
  }
  if (isConstructionFixablePolicyRejection(reason)) {
    return reason.includes('horizontal gap jump')
      ? '缺口超过 2 格：place 能搭桥缩短缺口；'
      : '脚底中心缺支撑：只有 place 能补（那一格可放置时才有效）；';
  }
  if (isFirePolicyRejection(reason) && reason.includes('gap jump whose miss would land in recorded')) {
    return '落空路径下方是火：宿主顺手灭火只处理身体要占的格，不会改变这条 jump；';
  }
  if (isFirePolicyRejection(reason) && reason.includes('destination support cell')) {
    return '支撑格是火：place 会把方块直接放在火的位置上（火可替换），不会自动打灭；';
  }
  if (isFirePolicyRejection(reason)) {
    return opts.fireClearable
      ? '这格是火：宿主会顺手打灭，不需要为此加 dig/place 授权；'
      : '这格是火：本次委托没有开路授权，宿主不会打灭；';
  }
  if (isDangerPolicyRejection(reason) || geometric.length > 0) return '危险格（岩浆等）：本次委托的授权不会改变这条边；';
  return '';
}

export const hostLandEdgePolicy = policyFor('host-land-edge-policy.danger-swept.edge-stance-cost-6.water-below-8.gap-jump-2.fall-only.dry.lava-neighbor-3.v8', new Set(['fall']), false);
export const hostWadingEdgePolicy = policyFor('host-land-edge-policy.danger-swept.edge-stance-cost-6.water-below-8.gap-jump-2.fall-wade.lava-neighbor-3.v8', new Set(['fall', 'water_contact']), true);
