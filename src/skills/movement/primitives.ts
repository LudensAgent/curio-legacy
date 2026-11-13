import type { PlacementFaceAttempt, Vec3Like } from '../../adapter/types.ts';
import { facingOfYaw, feetCell, supportCell, toWorld, type Facing } from '../../perception/local.ts';
import { bodyCells, estimatedFallDamage, isReplaceable, MIN_STEP_DELTA, PLAYER_STEP_HEIGHT, supportCellsUnderBody, supportTop, verticalStepKind, type StateAt } from '../../perception/geometry.ts';
import { LIQUID_BLOCKS } from '../../perception/surroundings.ts';
import { sleep, throwIfAborted } from '../../util.ts';
import { breakCell, why } from '../body.ts';
import { classifyBlock, MAN_MADE_NOTE, OWN_BUILDING_HINT, ownBuildingAt, storedChestAt } from '../build.ts';
import { noteEdit } from '../../mind/edits.ts';
import { isDangerousBlock } from '../../spatial/land-search.ts';
import { markSelfModified } from '../../spatial/shared-session.ts';
import { ANY_FILL_NOTE, PLACEABLE, PLACEABLE_DOC } from '../survival.ts';
import { isStation, rememberStation } from '../stations.ts';
import { codeFromError, fail, isAbort, obj, ok, type Skill, type SkillCtx } from '../types.ts';
import { absValue, after, facingArg, parseRel, relValue, toRel, visibleCells, visibleStates, type Rel } from './coordinates.ts';
import { consumptionReceipt, consumptionText, countItems, inspectBody, inspectStandableBelow, inspectSupport, inspectSupportDigRisk, reconcileBlockMutation, stateAt, stateReader } from './facts.ts';
import { effectConfirmed, effectUnconfirmed, placementMayHaveExecuted, placementProblem, problemOf, REFERENCE_PROBLEMS, withExecutionLink, type PrimitiveProblemKind } from './receipt.ts';

const AIR = new Set(['air', 'cave_air', 'void_air']);
const KEEPSAKE = /_bed$|^(crafting_table|furnace|smoker|blast_furnace|chest|barrel|anvil|jukebox|ender_chest|enchanting_table|brewing_stand|cartography_table|smithing_table|loom|stonecutter|grindstone)$|_door$|shulker_box$/;
/** 会落成悬空顶面的火把变体（place_cell 核对实际方块名时用）。 */
const WALL_TORCH: Record<string, string> = { torch: 'wall_torch', soul_torch: 'soul_wall_torch', redstone_torch: 'redstone_wall_torch' };
/**
 * 挖掉脚下支撑块时，未经 fall:true 允许的最大落差。
 * 1 格是 move_step 明确接受的同一级落差；2 格以上必须由调用者显式接受风险。
 */
const SAFE_UNCONSENTED_SUPPORT_DROP = 1;
/**
 * validate 与 run 之间身体连续位置的容许漂移（格）。只比脚格不够：同一列内从 0.15 挪到
 * 0.85 时脚格没变，但身体已经压到边缘，起跳/贴边条件已经不同。
 */
const START_POSITION_TOLERANCE = 0.05;

interface CellArgs { at: Rel; facing: Facing; xyz?: Vec3Like }
interface OriginSnapshot { pos: Vec3Like; feet: Vec3Like; worldId: string; sessionId: string; dim: string }
interface MoveArgs extends CellArgs { origin?: OriginSnapshot; allowHazard?: boolean }
interface MineArgs extends CellArgs { own?: boolean; wet?: boolean; lava?: boolean; fall?: boolean; tool?: string; autoTool?: boolean; allowUnknownAdjacent?: boolean }
interface PlaceArgs extends CellArgs { item: string }
interface SupportArgs extends CellArgs { item: string }
type PlaceAttempt = {
  stance: string; position: Vec3Like; endPosition?: Vec3Like; ok?: true; reason?: string; detail?: string;
  attemptedFaces?: PlacementFaceAttempt[]; reconciled?: boolean;
  problem?: { kind: PrimitiveProblemKind };
  effect?: 'support' | 'unchanged' | 'changed_without_support' | 'unknown' | 'not_attempted';
};

/** 目标相对当前脚位的方向；用于把 2+ 格高差交给 excavate_run，不替 Agent 决定挖不挖。 */
function stairHandoff(feet: Vec3Like, target: Vec3Like, delta: number): { mode: 'stairs' | 'stairs_up'; direction: 'north' | 'east' | 'south' | 'west'; steps: number } {
  const dx = target.x - feet.x, dz = target.z - feet.z;
  const direction = Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : (dz > 0 ? 'south' : 'north');
  return { mode: delta > 0 ? 'stairs_up' : 'stairs', direction, steps: Math.max(1, Math.min(8, Math.ceil(Math.abs(delta)))) };
}

/** 高差超出 move_step 时并列能做到的几类做法，不偏向任何一种、不给可直接照抄的施工命令。 */
function stairHint(stair: ReturnType<typeof stairHandoff>): string {
  const ways = stair.mode === 'stairs_up'
    ? ['pillar_one 原地垫高后再迈', 'place_support 在前方补一级', 'travel_to/navigate_to 走别的已知路（travel_to 写 place 可代为垫高）', `excavate_run stairs_up 朝 ${stair.direction} 开上行阶梯`]
    : ['assess_landings 选落点后 descend_to', 'travel_to/navigate_to 允许 drop 下去', `excavate_run stairs 朝 ${stair.direction} 开下行阶梯`];
  return `这是 ${stair.steps} 格高差，move_step 不处理；可选：${ways.join('；')}（由你决定）`;
}

/**
 * 候选脚高是不是真的能站：方块顶面只是 surfaceCandidateY，上方两格被占时不能当作可站立脚高。
 * 只回报阻挡格坐标，不回显方块名——没有经过视觉确认的方块不能在动作反馈里被点名。
 */
function standableFootProblem(at: StateAt, footY: number, cell: Vec3Like): { kind: PrimitiveProblemKind; blocker?: { cell: Vec3Like } } | null {
  const body = inspectBody(at, footY, cell.x, cell.z);
  const blocker = body.blockers[0];
  if (blocker) return {
    kind: blocker.cell.y <= Math.floor(footY + 0.05) ? 'TARGET_BLOCKED' : 'HEAD_BLOCKED',
    blocker: { cell: blocker.cell },
  };
  return body.unknown.length ? { kind: 'UNKNOWN_GEOMETRY' } : null;
}

function shapeOf(name: string, properties: Record<string, string | number | boolean> = {}): string {
  const top = supportTop(name, properties);
  if (name === 'snow') return `雪层（${String(properties.layers ?? 1)} 层）`;
  if (/_carpet$/.test(name)) return '地毯（薄层）';
  if (/_slab$/.test(name)) return `${properties.type === 'top' ? '上半砖' : '下半砖'}${top !== null ? `（顶面 ${top}）` : ''}`;
  if (/_door$/.test(name)) return `门（${properties.half === 'upper' ? '上半' : '下半'}，${properties.open === true ? '打开' : '关闭'}）`;
  if (/torch$/.test(name)) return '火把（无碰撞、不承重）';
  if (/_trapdoor$/.test(name)) return `活板门（${properties.open === true ? '打开' : '关闭'}）`;
  if (/_stairs$/.test(name)) return '台阶';
  if (/_bed$/.test(name)) return '床';
  if (name === 'ladder') return '梯子（不承重）';
  return top === null ? '非完整方块' : `可站立顶面 ${top}`;
}

/**
 * 站到相邻一格的纯移动元语。
 * 只执行调用者明确指定的那一列：同列 ±1 内的实际脚高由宿主解析，不换列、不向下扫描更远的落点，不自动补支撑。
 */
const moveStepSkill: Skill<MoveArgs> = {
  name: 'move_step',
  description: '站到身边相邻的一格（[前,上,右] 或 xyz）。相对写法只锁定相邻那一列：同列在当前脚高 ±1 格内若有唯一可站立脚高（含半砖、雪层、地毯、土径等分数脚高），宿主按实际碰撞顶面执行，“上”分量写错也不拒绝，回执用 requestedAt/resolvedAt 写明实际是同层/上一级（高 0.01–1 格，如 [1,1,0]）/下一级（支撑顶面低 0.01–1 格）；绝对 xyz 的 y 是你写明的脚高，须与实际一致。上升超过 0.6 格要起跳，头顶需净空；脚下是梯子时 [0,1,0] 沿梯子爬一格。同列 ±1 内没有可站立面（下方是空腔、落差或高差超过 1 格）时如实返回支撑格和落差，不换列、不自动改落点；补支撑用 place_support，更大落差用 descend_to。落点身体格/支撑格是岩浆、火、岩浆块、仙人掌、细雪等，或旁边/头顶有可流入的岩浆时默认不迈并列出危险格，allowHazard:true 显式接受后照迈。在岩浆/水里或乘骑时不做普通迈步。',
  catalog: '{"to":[前,上,右],"facing"?:"N|E|S|W"} 或 {"xyz":[x,y,z]}，"allowHazard"?:true：迈到相邻一格（同层或上下一级，高差 ≤1 格）；落点危险默认不迈',
  argsDoc: '{"to":[前,上,右], "facing"?:"N|E|S|W", "allowHazard"?true} 或 {"xyz":[x,y,z], "allowHazard"?true}（xyz 的 x/z 是整数方块列，只有 y 是目标脚高、可为分数，例如半砖 {"xyz":[1,63.5,0]}；前后/左右 ±1，上下 -1..1；相对写法 [1,0,0]/[1,1,0]/[1,-1,0] 都锁定同一相邻列，宿主在 ±1 内（上一级高 0.01–1 格，超过 0.6 格要起跳；下一级支撑顶面低 0.01–1 格）按实际脚高执行；同列 [0,1,0] 只在梯子上可爬；allowHazard 默认 false）',
  timeoutMs: 8000,
  movement: true,
  // 计划录入只检查写法；相邻性、落差、支撑和净空由每一步执行前的 validate + run 用最新位置确认。
  validatePlan(raw, adapter) {
    const a = obj(raw);
    const facing = facingArg(a.facing, adapter);
    if (typeof facing !== 'string' || !['N', 'E', 'S', 'W'].includes(facing)) return { ok: false, error: String(facing) };
    if (a.allowHazard !== undefined && typeof a.allowHazard !== 'boolean') return { ok: false, error: 'allowHazard 需要布尔值' };
    const hazard = a.allowHazard === true ? { allowHazard: true } : {};
    const xyz = a.xyz ?? a.abs ?? a.world;
    if (xyz !== undefined) {
      const p = absValue(xyz);
      if (!p) return { ok: false, error: 'xyz 需要 [x,y,z] 三个有限数字' };
      if (!Number.isInteger(p.x) || !Number.isInteger(p.z)) return { ok: false, error: 'xyz 的 x/z 必须是整数方块列；y 才是可分数的脚高' };
      return { ok: true, args: { at: [0, 0, 0] as Rel, facing: facing as Facing, xyz: p, ...hazard } };
    }
    const to = parseRel(relValue(a), { f: 1, u: [-1, 1], r: 1 });
    if (typeof to === 'string') return { ok: false, error: to };
    return { ok: true, args: { at: to, facing: facing as Facing, ...hazard } };
  },
  validate(raw, adapter) {
    const a = obj(raw);
    const xyz = a.xyz ?? a.abs ?? a.world;
    const facing = facingArg(a.facing, adapter);
    if (typeof facing !== 'string' || !['N', 'E', 'S', 'W'].includes(facing)) return { ok: false, error: String(facing) };
    if (a.allowHazard !== undefined && typeof a.allowHazard !== 'boolean') return { ok: false, error: 'allowHazard 需要布尔值' };
    const hazard = a.allowHazard === true ? { allowHazard: true } : {};
    // validate 只记录起点快照；run 会重新读取并与它比对，避免检查后世界/身体已变化。
    const state = adapter.state();
    const feet = feetCell(state.pos);
    const origin: OriginSnapshot = {
      pos: { ...state.pos }, feet: { ...feet }, worldId: state.worldId, sessionId: state.sessionId, dim: state.dim,
    };
    if (xyz !== undefined) {
      const p = absValue(xyz);
      if (!p) return { ok: false, error: 'xyz 需要 [x,y,z] 三个有限数字' };
      // xyz 的 x/z 是方块列；分数点会被 run 按格心验收，不能静默当成相邻一步。
      if (!Number.isInteger(p.x) || !Number.isInteger(p.z)) return { ok: false, error: 'xyz 的 x/z 必须是整数方块列；y 才是可分数的脚高' };
      const dx = p.x - feet.x, dz = p.z - feet.z, dy = p.y - state.pos.y;
      const horizontal = Math.abs(dx) + Math.abs(dz);
      if (horizontal > 1) return { ok: false, error: `(${p.x},${p.y},${p.z}) 不在身边能迈到的范围：前后/左右只能 ±1` };
      if (horizontal === 0 && dy > 0 && adapter.blockAt(feet) !== 'ladder') {
        return { ok: false, error: '原地向上不是 move_step：脚下没有梯子；原地垫高用 pillar_one' };
      }
      if (horizontal === 0 && dy <= 0) return { ok: false, error: '原地上下不是 move_step：要下挖用 mine_cell，要垫高用 pillar_one' };
      if (dy < -1.01 || dy > 1.01) return { ok: false, error: `(${p.x},${p.y},${p.z}) 的脚高与当前相差 ${dy.toFixed(2)} 格，move_step 只处理 ±1 格` };
      return { ok: true, args: { at: [dx, p.y - feet.y, dz] as Rel, facing: facing as Facing, xyz: p, origin, ...hazard } };
    }
    const to = parseRel(relValue(a), { f: 1, u: [-1, 1], r: 1 });
    if (typeof to === 'string') return { ok: false, error: to };
    if (to[0] === 0 && to[2] === 0) {
      if (!(to[1] === 1 && adapter.blockAt(feet) === 'ladder')) {
        return { ok: false, error: '原地上下不是 move_step：往上只有脚下有梯子才能爬；要原地垫高用 pillar_one，要迈上台阶用 [1,1,0]' };
      }
    }
    return { ok: true, args: { at: to, facing: facing as Facing, origin, ...hazard } };
  },
  async run(ctx, args) {
    throwIfAborted(ctx.signal);
    const adapter = ctx.adapter;
    const at = stateReader(adapter);
    const s0 = adapter.state();
    if (!s0.onGround && !s0.inWater && !s0.inLava && !s0.riding && adapter.blockAt(feetCell(s0.pos)) !== 'ladder') {
      const settleBy = Math.min(ctx.deadline, Date.now() + 800);
      while (!adapter.state().onGround && Date.now() < settleBy) {
        throwIfAborted(ctx.signal);
        await sleep(50, ctx.signal);
      }
    }
    // 等待结束不等于已经稳定：期限用完仍在空中时如实拒绝，不把超时当成落地。
    const settled = adapter.state();
    if (!settled.onGround && !settled.inWater && !settled.inLava && !settled.riding && adapter.blockAt(feetCell(settled.pos)) !== 'ladder') {
      return fail('EFFECT_NOT_CONFIRMED', '身体尚未稳定，暂不执行普通迈步：等待落地超时，仍未触地', {
        movementNotAttempted: true,
        ...problemOf('BODY_NOT_STABLE', 'precondition'), ...effectUnconfirmed('movement'), ...after(ctx, args.facing),
      });
    }
    // 一次快照解析起点：连续位置、脚格、会话都从这里取，run 内不再各自推导。
    const startState = adapter.state();
    const startPos = { ...startState.pos };
    const feet = { ...feetCell(startPos) };
    const drift = args.origin === undefined ? 0 : Math.hypot(
      startPos.x - args.origin.pos.x, startPos.y - args.origin.pos.y, startPos.z - args.origin.pos.z,
    );
    const startChanged = args.origin !== undefined && (
      drift > START_POSITION_TOLERANCE
      || args.origin.feet.x !== feet.x || args.origin.feet.y !== feet.y || args.origin.feet.z !== feet.z
      || args.origin.worldId !== startState.worldId || args.origin.sessionId !== startState.sessionId || args.origin.dim !== startState.dim
    );
    if (startChanged) {
      return fail('BAD_ARGS', '没有执行迈步：计划检查后起点已经变化（连续位置、脚下格、维度或会话不同），旧计划不再成立', {
        origin: { ...args.origin!.pos }, originFeet: { ...args.origin!.feet }, currentFeet: { ...feet }, positionDrift: drift,
        movementNotAttempted: true, ...effectUnconfirmed('movement'), ...problemOf('START_CHANGED', 'precondition'), ...after(ctx, args.facing),
      });
    }
    // target 是离散目标格；绝对 xyz 的 y 另外保留为精确脚高（targetFoot）。
    let target: Vec3Like;
    let targetFoot = args.xyz?.y;
    let rel: Rel;
    if (args.xyz !== undefined) {
      target = { x: args.xyz.x, y: feetCell(args.xyz).y, z: args.xyz.z };
      // 回执里的相对位移按请求脚高算，几何判断仍用离散目标格。
      rel = toRel({ x: feet.x, y: feet.y, z: feet.z }, args.facing, { x: target.x, y: args.xyz.y, z: target.z });
    } else {
      rel = args.at;
      target = toWorld(feet, args.facing, rel);
    }
    const partial = (extra?: Record<string, unknown>) => {
      const s = adapter.state();
      return { at: rel, facing: args.facing, ...(args.xyz !== undefined ? { xyz: args.xyz } : {}), target: { ...target }, ...(targetFoot !== undefined ? { targetFoot } : {}), position: { ...s.pos }, moved: s.pos.x !== startPos.x || s.pos.y !== startPos.y || s.pos.z !== startPos.z, ...(extra ?? {}) };
    };
    // 相邻一步的硬边界在 run 内再验一次：validate 的实时位置不作为执行授权。
    const horizontal = Math.abs(target.x - feet.x) + Math.abs(target.z - feet.z);
    if (horizontal > 1 || (args.xyz !== undefined && (!Number.isInteger(target.x) || !Number.isInteger(target.z)))) {
      return fail('BAD_ARGS', '没有执行迈步：目标不是身边相邻的一格（前后/左右只能 ±1，xyz 的 x/z 必须是整数方块列）', {
        ...partial(), movementNotAttempted: true, ...effectUnconfirmed('movement'), ...problemOf('NOT_ADJACENT', 'precondition'), ...after(ctx, args.facing, target),
      });
    }
    if (horizontal === 0 && !(target.y > feet.y + 0.01 && adapter.blockAt(feet) === 'ladder')) {
      return fail('BAD_ARGS', '没有执行迈步：原地上下不是 move_step；往上只有脚下有梯子才能爬', {
        ...partial(), movementNotAttempted: true, ...effectUnconfirmed('movement'), ...problemOf('NOT_ADJACENT', 'precondition'), ...after(ctx, args.facing, target),
      });
    }
    // 梯子上爬一格
    const sameColumn = Math.abs(target.x - feet.x) < 0.01 && Math.abs(target.z - feet.z) < 0.01;
    if (sameColumn && target.y > feet.y + 0.01 && adapter.blockAt(feet) === 'ladder') {
      const ladderFoot = targetFoot ?? target.y;
      const ladderBody = inspectBody(at, ladderFoot, target.x, target.z);
      const blocker = ladderBody.blockers[0];
      if (blocker) {
        const digRel = toRel(feet, args.facing, blocker.cell);
        return fail('PATH_NOT_FOUND', `梯子往上爬不动：头顶上方是 ${blocker.name}（先 mine_cell [${digRel}]）`, { ...partial(), remediation: { dig: digRel, reason: 'ladder-head' }, ...problemOf('HEAD_BLOCKED', 'precondition'), ...effectUnconfirmed('movement'), ...after(ctx, args.facing, target) });
      }
      if (ladderBody.unknown.length) {
        return fail('PATH_NOT_FOUND', '梯子往上爬时身体空间有未加载格，不能当作可通行', {
          ...partial(), unknown: ladderBody.unknown, ...problemOf('UNKNOWN_GEOMETRY', 'precondition'), ...effectUnconfirmed('movement'), ...after(ctx, args.facing, target),
        });
      }
      try {
        await adapter.moveTo({ kind: 'ladder', x: target.x, y: ladderFoot, z: target.z }, { signal: ctx.signal, timeoutMs: Math.max(1000, Math.min(6000, ctx.deadline - Date.now())) });
      } catch (e) {
        if (isAbort(e)) {
          (e as Error & { partial?: Record<string, unknown> }).partial = partial({ targetFoot: ladderFoot });
          throw e;
        }
        return fail(codeFromError(e), `没有爬到指定格：${(e as Error).message}`, { ...partial(), ...problemOf('MOVE_REJECTED', 'execution', true), ...effectUnconfirmed('movement', true), ...after(ctx, args.facing, target) });
      }
      const end = feetCell(adapter.state().pos);
      if (end.x !== target.x || end.y !== target.y || end.z !== target.z) {
        return fail('EFFECT_NOT_CONFIRMED', `没有爬到指定格，实际在 (${end.x},${end.y},${end.z})`, { ...partial(), ...problemOf('POSITION_NOT_CONFIRMED', 'verification'), ...effectUnconfirmed('movement', true), ...after(ctx, args.facing, target) });
      }
      return ok(`沿梯子爬上了一格（现在 y=${end.y}）`, { moved: [0, 1, 0], ...effectConfirmed('movement'), ...after(ctx, args.facing, target) });
    }
    // 非普通地面状态在入口明确分派，不落入普通步行流程后等超时。
    const live = adapter.state();
    if (live.inWater) {
      return fail('BAD_ARGS', '在水里不用 move_step 爬岸；用 swim_path 指定干岸或水中点', { ...partial(), ...problemOf('UNSUPPORTED_ENVIRONMENT', 'precondition'), ...effectUnconfirmed('movement'), ...after(ctx, args.facing, target) });
    }
    if (live.inLava) {
      return fail('BAD_ARGS', '在岩浆里不做普通迈步：move_step 不处理岩浆中的移动；先离开岩浆或换用明确的上岸/救援动作', { ...partial(), ...problemOf('UNSUPPORTED_ENVIRONMENT', 'precondition'), ...effectUnconfirmed('movement'), ...after(ctx, args.facing, target) });
    }
    if (live.riding) {
      return fail('BAD_ARGS', `正在乘坐 ${live.riding}：先 dismount；驾驶载具用 boat_path，不做普通迈步`, { ...partial(), ...problemOf('UNSUPPORTED_ENVIRONMENT', 'precondition'), ...effectUnconfirmed('movement'), ...after(ctx, args.facing, target) });
    }
    // 目标格的唯一几何解析：连续起点脚高 + 目标格实际支撑顶面。
    // 相对写法 [前,上,右] 只锁定相邻列：同列 ±1 内的可站立脚高由宿主按实际碰撞顶面解析，
    // “上”只是预期；绝对 xyz 的 y 是调用者写明的脚高，仍须一致。
    const absolute = args.xyz !== undefined;
    const baseFoot = startPos.y;
    const requestedRel = rel;
    if (!absolute) {
      // 同一列 ±1 内最多只有一个可站立脚高（身体 1.8 格高）；找到就按它锁定目标格，找不到再走下面的如实拒绝。
      const resolved = ([1, 0, -1] as const)
        .map((u) => {
          const cell = toWorld(feet, args.facing, [rel[0], u, rel[2]]);
          return { cell, foot: inspectSupport(at, cell).foot };
        })
        .find((c) => c.foot !== null && verticalStepKind(c.foot - baseFoot) !== null && standableFootProblem(at, c.foot, c.cell) === null);
      if (resolved) {
        rel = [rel[0], verticalStepKind(resolved.foot! - baseFoot)!, rel[2]];
        target = { x: resolved.cell.x, y: feetCell({ x: resolved.cell.x, y: resolved.foot!, z: resolved.cell.z }).y, z: resolved.cell.z };
      }
    }
    const direct = inspectSupport(at, target).foot;
    const wanted = absolute ? targetFoot! : baseFoot + rel[1];
    if (direct === null) {
      const belowScan = inspectStandableBelow(at, target, wanted);
      const below = belowScan.landing;
      const facts = below
        ? { landing: { x: target.x, y: below.foot, z: target.z, drop: below.drop }, support: { ...target, y: target.y - 1 } }
        : { support: { ...target, y: target.y - 1 }, ...(belowScan.unknown ? { geometryUnknown: true } : {}) };
      // 目标脚格没有支撑时，用“最近的同列可站立面相对当前脚高”判断它属于同层还是 ±1；
      // u 是目标格相对脚格的竖直偏移，不能直接按“下方第几格”硬套（半砖会让脚高与格偏移不一致）。
      const correctedU = below === null ? null : verticalStepKind(below.foot - baseFoot);
      const stair = below !== null && Math.abs(below.foot - baseFoot) > 1 + MIN_STEP_DELTA
        ? stairHandoff(feet, target, below.foot - baseFoot) : null;
      // 顶面候选不等于可站立脚高：候选处身体空间被占/未知时，先给真实阻挡，不给必败的“改脚高”。
      const standable = correctedU !== null && below !== null ? standableFootProblem(at, below.foot, target) : null;
      if (standable !== null) {
        const where = standable.blocker
          ? `候选脚高 y=${below!.foot.toFixed(2)} 处的身体空间被 (${standable.blocker.cell.x},${standable.blocker.cell.y},${standable.blocker.cell.z}) 的方块占据`
          : `候选脚高 y=${below!.foot.toFixed(2)} 处有未加载格`;
        return fail('PATH_NOT_FOUND', `没有执行迈步：目标格 (${target.x},${target.y},${target.z}) 的支撑顶面候选是 y=${below!.foot.toFixed(2)}，但那不是可站立脚高：${where}；move_step 不给脚高修正建议，先处理这一格的阻挡/证据，或换落点`, {
          ...facts, surfaceCandidateY: below!.foot, standableFootY: null, movementNotAttempted: true,
          ...(standable.blocker ? { blocker: standable.blocker } : {}),
          ...problemOf(standable.kind, 'precondition'), ...effectUnconfirmed('movement'), ...after(ctx, args.facing, target),
        });
      }
      const dropRemediation = correctedU === null && below !== null && below.drop > 1.01
        ? { assess: true as const, landing: { x: target.x, y: below.foot, z: target.z }, drop: below.drop,
            descend: { target: { x: target.x, y: below.foot, z: target.z } } }
        : null;
      // 相对写法在 ±1 内的可站立脚高已在上面解析；走到这里的 ±1 候选只剩绝对 xyz 写错了 y。
      const remediation = correctedU !== null
        ? { xyz: { x: target.x, y: below!.foot, z: target.z } }
        : dropRemediation
          ? { ...dropRemediation, ...(stair ? { stairs: stair } : {}) }
          : stair ? { stairs: stair } : null;
      const correction = (correctedU === null
        ? below
          ? `同列下方 ${below.drop.toFixed(2)} 格才有可站立脚面 y=${below.foot.toFixed(2)}，与当前脚高相差 ${Math.abs(below.foot - baseFoot).toFixed(2)} 格，不符合 move_step 的同层/±1 规则；要下去先用 assess_landings 确认落点，再 descend_to（move_step 不处理 >1 落差），或补支撑后按同层走`
          : belowScan.unknown ? '同列下方有未加载格，无法确认落点；先靠近或看清这一列再决定'
            : '同列下方没有找到可站立面；要补支撑用 place_support 目标脚下方那一格'
        : `同一列可站立脚高是 y=${below!.foot.toFixed(2)}；把 y 写成 ${below!.foot.toFixed(2)}`) + (stair ? `；${stairHint(stair)}` : '');
      const problemKind = belowScan.unknown ? 'UNKNOWN_GEOMETRY'
        : below === null ? 'NO_SUPPORT'
          : correctedU !== null ? 'FOOT_HEIGHT_MISMATCH'
            : Math.abs(below.foot - baseFoot) > 1 + MIN_STEP_DELTA ? 'UNSUPPORTED_STEP_HEIGHT' : 'FOOT_HEIGHT_MISMATCH';
      // 同列有可站立面但落差超出 ±1：这是能力边界，不是普通“寻路无解”；
      // problem.kind 已结构化分类，failureCode 也用 BAD_ARGS + unsupportedGeometry 明确标出。
      const unsupported = problemKind === 'UNSUPPORTED_STEP_HEIGHT';
      return fail(unsupported ? 'BAD_ARGS' : correctedU === null ? 'PATH_NOT_FOUND' : 'BAD_ARGS', `没有执行迈步：目标格 (${target.x},${target.y},${target.z}) 在当前脚高 ${wanted.toFixed(2)} 没有可站立面；${correction}`, { ...facts, movementNotAttempted: true, ...(unsupported ? { unsupportedGeometry: true } : {}), ...(remediation ? { remediation } : {}), ...problemOf(problemKind, 'precondition'), ...effectUnconfirmed('movement'), ...after(ctx, args.facing, target) });
    }
    // 绝对 xyz 的 y 是调用者指定的脚高：支撑面必须与它一致，不能悄悄改成实际支撑面。
    if (absolute && Math.abs(direct - targetFoot!) > MIN_STEP_DELTA) {
      const standable = standableFootProblem(at, direct, target);
      if (standable !== null) {
        const where = standable.blocker
          ? `候选脚高 y=${direct.toFixed(2)} 处的身体空间被 (${standable.blocker.cell.x},${standable.blocker.cell.y},${standable.blocker.cell.z}) 的方块占据`
          : `候选脚高 y=${direct.toFixed(2)} 处有未加载格`;
        return fail('PATH_NOT_FOUND', `没有执行迈步：目标格 (${target.x},${target.y},${target.z}) 的支撑顶面候选是 y=${direct.toFixed(2)}，但那不是可站立脚高：${where}；不提供脚高修正建议，先处理这一格的阻挡/证据，或换落点`, {
          targetCell: target, expectedFoot: targetFoot, surfaceCandidateY: direct, standableFootY: null, movementNotAttempted: true,
          ...(standable.blocker ? { blocker: standable.blocker } : {}),
          ...problemOf(standable.kind, 'precondition'), ...effectUnconfirmed('movement'), ...after(ctx, args.facing, target),
        });
      }
      const stair = Math.abs(direct - baseFoot) > 1.01 ? stairHandoff(feet, target, direct - baseFoot) : null;
      return fail('BAD_ARGS', `没有执行迈步：目标格 (${target.x},${target.y},${target.z}) 的支撑面在 y=${direct.toFixed(2)}，与绝对脚高 ${targetFoot!.toFixed(2)} 不符；若要到这一格，把 y 写成 ${direct.toFixed(2)}。未执行迈步${stair ? `；${stairHint(stair)}` : ''}`, { targetCell: target, expectedFoot: targetFoot, actualSupport: direct, surfaceCandidateY: direct, standableFootY: direct, movementNotAttempted: true, remediation: { xyz: { x: target.x, y: direct, z: target.z }, ...(stair ? { stairs: stair } : {}) }, ...problemOf('FOOT_HEIGHT_MISMATCH', 'precondition'), ...effectUnconfirmed('movement'), ...after(ctx, args.facing, target) });
    }
    if (!absolute) {
      const delta = direct - baseFoot;
      const corrected = verticalStepKind(delta);
      // 支撑顶面只是候选：两格高的整块墙会把顶面算到下一层，但那一层的身体空间仍被占。
      // 这种情况下先报真实阻挡，不给出一个下一轮必败的“上一级”修正。
      const standable = corrected !== null ? standableFootProblem(at, direct, target) : null;
      if (standable !== null) {
        const where = standable.blocker
          ? `候选脚高 y=${direct.toFixed(2)} 处的身体空间被 (${standable.blocker.cell.x},${standable.blocker.cell.y},${standable.blocker.cell.z}) 的方块占据`
          : `候选脚高 y=${direct.toFixed(2)} 处有未加载格`;
        return fail('PATH_NOT_FOUND', `没有执行迈步：目标格 (${target.x},${target.y},${target.z}) 的支撑顶面候选是 y=${direct.toFixed(2)}，但那不是可站立脚高：${where}；不提供脚高修正建议，先处理这一格的阻挡/证据，或换落点`, {
          actualFoot: direct, expectedFoot: wanted, surfaceCandidateY: direct, standableFootY: null, targetCell: target, movementNotAttempted: true,
          ...(standable.blocker ? { blocker: standable.blocker } : {}),
          ...problemOf(standable.kind, 'precondition'), ...effectUnconfirmed('movement'), ...after(ctx, args.facing, target),
        });
      }
      // >1 格的落差不是 move_step 能处理的；给出“先 assess_landings 再 descend_to”的结构化交接。
      if (corrected === null) {
        const stair = stairHandoff(feet, target, delta);
        const dropBelow = inspectStandableBelow(at, target, wanted).landing;
        const dropRemediation = dropBelow && dropBelow.drop > 1 + MIN_STEP_DELTA
          ? { assess: true as const, landing: { x: target.x, y: dropBelow.foot, z: target.z }, drop: dropBelow.drop,
              descend: { target: { x: target.x, y: dropBelow.foot, z: target.z } } }
          : null;
        return fail('BAD_ARGS', `没有执行迈步：目标列的实际脚高是 y=${direct.toFixed(2)}，当前 y=${baseFoot.toFixed(2)}，实际落差 ${Math.abs(delta).toFixed(2)} 格，超出 move_step 的 ±1 范围${dropRemediation ? '；要下去先用 assess_landings 确认落点，再 descend_to' : ''}；${stairHint(stair)}`, {
          actualFoot: direct, expectedFoot: wanted, surfaceCandidateY: direct, standableFootY: direct, movementNotAttempted: true, unsupportedGeometry: true,
          remediation: dropRemediation ? { ...dropRemediation, stairs: stair } : { stairs: stair },
          ...problemOf('UNSUPPORTED_STEP_HEIGHT', 'precondition'), ...effectUnconfirmed('movement'), ...after(ctx, args.facing, target),
        });
      }
    }
    const targetY = absolute ? targetFoot! : direct;
    if (targetY > baseFoot + PLAYER_STEP_HEIGHT) {
      const jumpBody = inspectBody(at, targetY, feet.x, feet.z);
      const jump = jumpBody.blockers[0];
      if (jump) {
        const digRel = toRel(feet, args.facing, jump.cell);
        return fail('PATH_NOT_FOUND', `没有执行迈步：往上迈时自己头顶/起跳路径上是 ${jump.name}（先 mine_cell [${digRel}]）`, {
          targetCell: target, movementNotAttempted: true, remediation: { dig: digRel, reason: 'jump-head' }, ...problemOf('HEAD_BLOCKED', 'precondition'), ...effectUnconfirmed('movement'), ...after(ctx, args.facing, target),
        });
      }
      if (jumpBody.unknown.length) {
        return fail('PATH_NOT_FOUND', '没有执行迈步：起跳路径有未加载格，不能当作空旷', {
          targetCell: target, movementNotAttempted: true, unknown: jumpBody.unknown, ...problemOf('UNKNOWN_GEOMETRY', 'precondition'), ...effectUnconfirmed('movement'), ...after(ctx, args.facing, target),
        });
      }
    }
    const targetBody = inspectBody(at, targetY, target.x, target.z);
    const blocker = targetBody.blockers[0];
    if (blocker) {
      const digRel = toRel(feet, args.facing, blocker.cell);
      const atTarget = blocker.cell.y === target.y;
      return fail('PATH_NOT_FOUND', `没有执行迈步：${atTarget ? '目标格' : '目标格上方'}是 ${blocker.name}（先 mine_cell [${digRel}]）`, {
        problems: [`${atTarget ? '目标格' : '目标格上方'}是 ${blocker.name}`], targetCell: target,
        movementNotAttempted: true, remediation: { dig: digRel, reason: atTarget ? 'feet' : 'head' }, ...problemOf(atTarget ? 'TARGET_BLOCKED' : 'HEAD_BLOCKED', 'precondition'), ...effectUnconfirmed('movement'), ...after(ctx, args.facing, target),
      });
    }
    if (targetBody.unknown.length) {
      return fail('PATH_NOT_FOUND', '没有执行迈步：目标格身体空间有未加载格，不能当作空旷', {
        targetCell: target, movementNotAttempted: true, unknown: targetBody.unknown, ...problemOf('UNKNOWN_GEOMETRY', 'precondition'), ...effectUnconfirmed('movement'), ...after(ctx, args.facing, target),
      });
    }
    // 危险是事实不是禁令：身体格/支撑格是岩浆、火、岩浆块、仙人掌等，或身体旁/头顶有可流入的岩浆时默认不迈，
    // allowHazard:true 由调用者显式接受（与 mine_cell 的 lava 标志同口径）。只检查，不绕行、不换落点。
    if (!args.allowHazard) {
      const body = bodyCells(targetY, target.x, target.z);
      const top = body.at(-1)!;
      const support = supportCell({ x: target.x, y: targetY, z: target.z });
      const near = [...body.flatMap((c) => [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => ({ x: c.x + dx!, y: c.y, z: c.z + dz! }))), { ...top, y: top.y + 1 }];
      const hazards = [
        ...[...body, support].map((cell) => ({ cell, name: adapter.blockAt(cell), where: cell === support ? 'support' as const : 'body' as const }))
          .filter((h) => h.name !== null && isDangerousBlock(h.name)),
        ...near.map((cell) => ({ cell, name: adapter.blockAt(cell), where: 'adjacent' as const })).filter((h) => h.name === 'lava'),
      ];
      if (hazards.length) {
        return fail('BAD_ARGS', `没有执行迈步：目标落点有危险——${hazards.map((h) => `${h.where === 'body' ? '身体格' : h.where === 'support' ? '脚下支撑' : '旁边可流入'} (${h.cell.x},${h.cell.y},${h.cell.z}) 是 ${h.name}`).join('、')}；要照样迈过去写 allowHazard:true`, {
          targetCell: target, targetFoot: targetY, hazards, movementNotAttempted: true,
          ...problemOf('HAZARD_RISK_UNAUTHORIZED', 'precondition'), ...effectUnconfirmed('movement'), ...after(ctx, args.facing, target),
        });
      }
    }
    try {
      await adapter.moveTo({ kind: 'xyz', x: target.x, y: targetY, z: target.z }, { signal: ctx.signal, timeoutMs: Math.max(1000, Math.min(6000, ctx.deadline - Date.now())), adjacentStep: true });
    } catch (e) {
      if (isAbort(e)) {
        (e as Error & { partial?: Record<string, unknown> }).partial = partial({ targetFoot: targetY });
        throw e;
      }
      const code = codeFromError(e);
      return fail(code, `没有站到指定格：${(e as Error).message}`, { ...partial(), targetFoot: targetY, movementAttempted: true, ...problemOf(code === 'TIMEOUT' ? 'MOVE_TIMEOUT' : 'MOVE_REJECTED', 'execution', code === 'TIMEOUT'), ...effectUnconfirmed('movement', true), ...after(ctx, args.facing, target) });
    }
    const settleBy = Math.min(ctx.deadline, Date.now() + 2000);
    while (!adapter.state().onGround && Date.now() < settleBy) {
      throwIfAborted(ctx.signal);
      await sleep(50, ctx.signal);
    }
    const state = adapter.state();
    const end = feetCell(state.pos);
    if (!state.onGround || end.x !== target.x || end.z !== target.z || Math.abs(state.pos.y - targetY) > 0.01) {
      const why = !state.onGround ? '身体没有站稳' : end.x !== target.x || end.z !== target.z ? `实际列 (${end.x},${end.z}) 与目标不符` : `实际脚高 ${state.pos.y.toFixed(2)} 与目标脚高 ${targetY.toFixed(2)} 不符`;
      return fail('EFFECT_NOT_CONFIRMED', `没有站到指定格：${why}`, { ...partial(), targetFoot: targetY, movementAttempted: true, ...problemOf('POSITION_NOT_CONFIRMED', 'verification'), ...effectUnconfirmed('movement', true), ...after(ctx, args.facing, target) });
    }
    const drop = baseFoot - targetY;
    const damage = drop > 0 ? estimatedFallDamage(drop) : 0;
    const resolvedU = requestedRel[1] !== rel[1];
    return ok(`站到了 [${rel}]（脚高 y=${targetY.toFixed(2)}）${resolvedU ? `；你写的是 [${requestedRel}]，同一相邻列的实际可站立脚高在 ${rel[1] > 0 ? '上一级' : rel[1] < 0 ? '下一级' : '同层'}，按它执行` : ''}${drop > 0 ? `，下落 ${drop.toFixed(2)} 格` : ''}${damage ? `（预计约 ${damage} 点摔伤）` : ''}`, {
      // moved 是实测脚所在格相对起点的差；绝对 xyz 的分数脚高不冒充位移向量。
      moved: [target.x - feet.x, target.y - feet.y, target.z - feet.z], targetFoot: targetY, standableFootY: targetY, ...effectConfirmed('movement'),
      ...(resolvedU ? { requestedAt: requestedRel, resolvedAt: rel } : {}),
      ...(args.allowHazard ? { allowHazard: true } : {}),
      ...(drop > 0 ? { drop, fall: { drop, damage } } : {}), ...after(ctx, args.facing, target),
    });
  },
};

/** 挖掉确切的一格。用户明确指定目标、可接受的风险和工具；代码只执行并核对。 */
const mineCellSkill: Skill<MineArgs> = {
  name: 'mine_cell',
  description: '挖掉身边指定的一格（[前,上,右] 或 xyz）。相对坐标 [0,-1,0] 指脚部支撑格（站半砖/床/雪层时就是脚所在那一格，脚高可为分数），不是脚的整数格下方一格。身边能挖到的格以当前已加载方块状态为准：视线只是补充观察，看不见/被遮挡但已加载的格照常开挖（不把未看见当空气，也不当成未知），只有未加载才返回未知、不挖别处。只用 tool 指定的工具；没写 tool 时默认只用当前手持（空手就空手挖），不自动换更合适的、也不自动造工具；autoTool:true 时由身体按方块从背包挑合适的工具装备到主手（挖完不会自动换回）。指定 tool 不在背包返回 TOOL_MISSING；不掉落也照挖并回报 noDrop，换工具先 hold_item。没指定时按适配器真实规则返回 noDrop、超时等事实。液体邻格默认不挖；wet/lava 显式接受进水/进岩浆。邻格已加载时按实时状态检查；未加载、无法排除侧后方液体流入时默认不挖，allowUnknownAdjacent:true 显式接受未加载邻格风险。挖脚下支撑块时，下方 1 格是实心落点可直接挖；2–3 格落差或落点未知要 fall:true，落点是水/岩浆还要 wet:true/lava:true。挖掉脚下支撑后会等落地（有界）并回报 onGround、AABB 下剩余支撑格和实际落差；仍在空中时标 pendingFall，不会把目标格已空当作已落地。只挖不走，不挖基岩。',
  catalog: '{"at":[前,上,右],"facing"?:"N|E|S|W"} 或 {"xyz":[x,y,z]}，"tool"?:"物品名"，"autoTool"?true，"wet"?/"lava"?/"fall"?/"allowUnknownAdjacent"?:true：挖掉身边指定的一格（[0,-1,0] 是脚下支撑）；autoTool 由身体挑工具；液体邻格、挖脚下落差、邻格未看清要显式授权',
  argsDoc: '{"at":[前,上,右], "facing"?:"N|E|S|W", "tool"?:"物品注册名（只用这一把；不掉落也挖并报 noDrop）", "autoTool"?true（由身体按方块从背包挑合适的工具装备到主手；不写 tool 时默认只用当前手持）, "wet"?true, "lava"?true, "fall"?true, "allowUnknownAdjacent"?true} 或 {"xyz":[x,y,z], "facing"?:"N|E|S|W", "tool"?:"物品注册名", "autoTool"?true, "wet"?true, "lava"?true, "fall"?true, "allowUnknownAdjacent"?true}（xyz 是整数方块格坐标；前后/左右 ±2，上下 -1..3；[0,-1,0] 是脚部支撑格）',
  timeoutMs: 30000,
  movement: false,
  // 计划录入只检查写法；目标是否在挖得到的范围、邻格和落点由执行前按最新位置确认。
  validatePlan(raw, adapter) {
    const a = obj(raw);
    const facing = facingArg(a.facing, adapter);
    if (typeof facing !== 'string') return { ok: false, error: String(facing) };
    const tool = a.tool;
    if (tool !== undefined && (typeof tool !== 'string' || !/^[a-z0-9_]{1,80}$/.test(tool))) return { ok: false, error: 'tool 为可选物品注册名（小写字母、数字、下划线）' };
    const flags = { ...(tool !== undefined ? { tool } : {}), ...(a.autoTool === true ? { autoTool: true } : {}), ...(a.own === true ? { own: true } : {}), ...(a.wet === true ? { wet: true } : {}), ...(a.lava === true ? { lava: true } : {}), ...(a.fall === true ? { fall: true } : {}), ...(a.allowUnknownAdjacent === true ? { allowUnknownAdjacent: true } : {}) };
    const rawXyz = a.xyz ?? a.abs ?? a.world;
    if (rawXyz !== undefined) {
      const xyz = absValue(rawXyz);
      if (!xyz) return { ok: false, error: 'xyz 需要 [x,y,z] 三个有限数字' };
      if (![xyz.x, xyz.y, xyz.z].every(Number.isInteger)) return { ok: false, error: 'xyz 是方块格坐标，x/y/z 都必须是整数' };
      return { ok: true, args: { at: [0, 0, 0] as Rel, facing: facing as Facing, xyz, ...flags } };
    }
    const at = parseRel(relValue(a), { f: 2, u: [-1, 3], r: 2 });
    if (typeof at === 'string') return { ok: false, error: at };
    return { ok: true, args: { at, facing: facing as Facing, ...flags } };
  },
  validate(raw, adapter) {
    const a = obj(raw);
    const facing = facingArg(a.facing, adapter);
    if (typeof facing !== 'string') return { ok: false, error: String(facing) };
    const tool = a.tool;
    if (tool !== undefined && (typeof tool !== 'string' || !/^[a-z0-9_]{1,80}$/.test(tool))) return { ok: false, error: 'tool 为可选物品注册名（小写字母、数字、下划线）' };
    const rawXyz = a.xyz ?? a.abs ?? a.world;
    if (rawXyz !== undefined) {
      const xyz = absValue(rawXyz);
      if (!xyz) return { ok: false, error: 'xyz 需要 [x,y,z] 三个有限数字' };
      // 方块动作的目标是整数格；分数坐标不能静默当成相邻格。
      if (![xyz.x, xyz.y, xyz.z].every(Number.isInteger)) return { ok: false, error: 'xyz 是方块格坐标，x/y/z 都必须是整数' };
      const rel = parseRel(toRel(feetCell(adapter.state().pos), facing as Facing, xyz), { f: 2, u: [-1, 3], r: 2 });
      if (typeof rel === 'string') return { ok: false, error: `(${xyz.x},${xyz.y},${xyz.z}) 不在身边能挖到的范围：${rel}；先走近` };
      return { ok: true, args: { at: rel, facing: facing as Facing, xyz, ...(tool !== undefined ? { tool } : {}), ...(a.autoTool === true ? { autoTool: true } : {}), ...(a.own === true ? { own: true } : {}), ...(a.wet === true ? { wet: true } : {}), ...(a.lava === true ? { lava: true } : {}), ...(a.fall === true ? { fall: true } : {}), ...(a.allowUnknownAdjacent === true ? { allowUnknownAdjacent: true } : {}) } };
    }
    const at = parseRel(relValue(a), { f: 2, u: [-1, 3], r: 2 });
    if (typeof at === 'string') return { ok: false, error: at };
    return { ok: true, args: { at, facing: facing as Facing, ...(tool !== undefined ? { tool } : {}), ...(a.autoTool === true ? { autoTool: true } : {}), ...(a.own === true ? { own: true } : {}), ...(a.wet === true ? { wet: true } : {}), ...(a.lava === true ? { lava: true } : {}), ...(a.fall === true ? { fall: true } : {}), ...(a.allowUnknownAdjacent === true ? { allowUnknownAdjacent: true } : {}) } };
  },
  async run(ctx, args) {
    throwIfAborted(ctx.signal);
    const adapter = ctx.adapter;
    const at = stateReader(adapter);
    const origin = adapter.state();
    const raw = origin.pos;
    // 归因用动作开始时的维度：确认后再读 state().dim 可能已被传送改变，不能把旧格记到新维度。
    const dim = origin.dim;
    const feet = feetCell(raw);
    const support = supportCell(raw);
    const digsSupport = args.xyz !== undefined
      ? args.xyz.x === support.x && args.xyz.y === support.y && args.xyz.z === support.z
      : args.at[0] === 0 && args.at[2] === 0 && args.at[1] === -1;
    const pos = args.xyz !== undefined ? { ...args.xyz } : digsSupport ? support : toWorld(feet, args.facing, args.at);
    const loaded = adapter.blockAt(pos);
    const ownCell = pos.x === feet.x && pos.z === feet.z && (pos.y === feet.y || pos.y === feet.y + 1);
    if (loaded === null) return fail('NOT_FOUND', `[${args.at}] 那一格还没加载（区块没载入），看不见也没法挖`, { ...after(ctx, args.facing, pos), noop: true, obscured: true, unknown: true, ...problemOf('TARGET_STATE_UNKNOWN', 'precondition'), ...effectUnconfirmed('block_removed') });
    if (ownCell && AIR.has(loaded)) return ok(`[${args.at}] 是自己站的格子，本来就空着，别挖这里`, { ...after(ctx, args.facing, pos), noop: true, ...effectConfirmed('block_removed') });
    const key = `${pos.x},${pos.y},${pos.z}`;
    // 身边能挖到的格以当前已加载方块状态为准；视线只是补充观察，不再作为开挖前置条件。
    // 未直视/被遮挡不等于它是空气或未知：加载的方块状态就是当前身体的可用事实。
    const seenBefore = ownCell ? loaded : visibleCells(ctx, [pos]).get(key);
    const stateSource = seenBefore !== undefined ? 'vision' : 'live_loaded';
    const before = seenBefore ?? loaded;
    if (AIR.has(before)) {
      // 目标已空时也要说清身体有没有掉：只回“本来就是空的”会让 Agent 反复挖同一格找原因。
      const state = adapter.state();
      const supports = digsSupport ? supportCellsUnderBody(state.pos, at) : [];
      const supportText = supports.slice(0, 3).map((s) => `${s.name}(${s.pos.x},${s.pos.y},${s.pos.z})`).join('、');
      const bodyText = digsSupport
        ? `；身体在 y=${state.pos.y.toFixed(2)}，${state.onGround ? '已触地' : '未触地'}${supports.length ? `，脚下还有 ${supportText} 托着` : ''}`
        : '';
      return ok(`[${args.at}] 本来就是空的，不用挖${bodyText}`, {
        cell: [...args.at], was: 'air', ...effectConfirmed('block_removed'),
        ...(stateSource === 'live_loaded' ? { stateSource } : {}),
        ...(digsSupport ? { onGround: state.onGround, supports } : {}),
        ...after(ctx, args.facing, pos), noop: true,
      });
    }
    if (LIQUID_BLOCKS.has(before)) return fail('BAD_ARGS', `[${args.at}] 是 ${before}，挖不了`, { ...after(ctx, args.facing, pos), ...problemOf('TARGET_LIQUID', 'precondition'), ...effectUnconfirmed('block_removed') });
    const neighborPositions = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]]
      .map(([dx, dy, dz]) => ({ x: pos.x + dx, y: pos.y + dy, z: pos.z + dz }));
    const seenNeighbors = visibleCells(ctx, neighborPositions);
    // 身边邻格同样以当前已加载方块为准：视线没看到不等于未知；只有没加载的邻格
    // 才需要 allowUnknownAdjacent。身体自己的脚/头格也是触觉已知的邻格。
    for (const neighbor of [...neighborPositions, feet, { x: feet.x, y: feet.y + 1, z: feet.z }]) {
      const neighborKey = `${neighbor.x},${neighbor.y},${neighbor.z}`;
      if (seenNeighbors.has(neighborKey)) continue;
      const neighborName = adapter.blockAt(neighbor);
      if (neighborName !== null) seenNeighbors.set(neighborKey, neighborName);
    }
    // 未知邻格不当作空气或安全：默认阻止挖掘，避免侧后方液体流入；显式授权才继续。
    const unknownAdjacent = neighborPositions
      .filter((p) => !seenNeighbors.has(`${p.x},${p.y},${p.z}`))
      .map((p) => toRel(feet, args.facing, p));
    const wet = neighborPositions
      .map((p) => ({ pos: p, name: seenNeighbors.get(`${p.x},${p.y},${p.z}`) ?? '' }))
      .filter((n) => LIQUID_BLOCKS.has(n.name));
    const blocked = wet.filter((w) => /lava/.test(w.name) ? !args.lava : !args.wet);
    if (blocked.length) {
      return fail('BAD_ARGS', `[${args.at}] 挖开会有液体流进来：${wet.map((w) => `${w.name} 在 [${toRel(feet, args.facing, w.pos)}]`).join('、')}；写 wet:true 或 lava:true 明确接受后再挖`, {
        wet: wet[0]?.name, wetCells: wet.map((w) => toRel(feet, args.facing, w.pos)), ...(unknownAdjacent.length ? { unknownAdjacent } : {}), ...problemOf('LIQUID_RISK_UNAUTHORIZED', 'precondition'), ...effectUnconfirmed('block_removed'), ...after(ctx, args.facing, pos),
      });
    }
    if (unknownAdjacent.length && args.allowUnknownAdjacent !== true) {
      return fail('BAD_ARGS', `[${args.at}] 挖开时还有邻格没看清（无法排除液体流入）：${unknownAdjacent.map((r) => `[${r}]`).join('、')}；先看清这些格子再挖，或写 allowUnknownAdjacent:true 明确接受未知风险`, {
        unknownAdjacent, ...problemOf('UNKNOWN_ADJACENT_UNAUTHORIZED', 'precondition'), ...effectUnconfirmed('block_removed'), ...after(ctx, args.facing, pos),
      });
    }
    type FallFacts = {
      below: string | null; drop: number | null; fallRisk: string;
      requiresFall: boolean; requiresLiquid?: 'water' | 'lava';
    };
    let fallFacts: FallFacts | undefined;
    if (digsSupport) {
      // 只按本次实际观察评估脚下落差；未看清的格子不能借 adapter.blockAt 补全。
      const belowPositions = [1, 2, 3].map((d) => ({ x: pos.x, y: pos.y - d, z: pos.z }));
      const seenBelow = visibleStates(ctx, belowPositions);
      const scan = inspectSupportDigRisk((p) => seenBelow.get(`${p.x},${p.y},${p.z}`) ?? null, pos, 3);
      const landing = scan.landing;
      const landingName = landing?.state.name ?? null;
      const drop = landing?.drop ?? 0;
      const unknown = scan.unknown;
      const isLiquid = landing?.liquid === true;
      // 1 格落差与 move_step 的同一级单步一致；2–3 格必须显式 fall:true。
      const requiresFall = unknown || drop === 0 || drop > SAFE_UNCONSENTED_SUPPORT_DROP;
      const requiresLiquid = isLiquid ? (/lava/.test(landingName!) ? 'lava' as const : 'water' as const) : undefined;
      fallFacts = {
        below: unknown ? null : landingName,
        drop: unknown || drop === 0 ? null : drop,
        fallRisk: unknown ? '下方 3 格内未看清落点'
          : drop === 0 ? '下方 3 格内未见落点'
            : `下方 ${drop} 格是 ${landingName}`,
        requiresFall,
        ...(requiresLiquid ? { requiresLiquid } : {}),
      };
      const liquidDenied = requiresLiquid === 'lava' ? !args.lava : requiresLiquid === 'water' ? !args.wet : false;
      if ((requiresFall && !args.fall) || liquidDenied) {
        const needs = [
          ...(requiresFall && !args.fall ? ['fall:true'] : []),
          ...(liquidDenied ? [requiresLiquid === 'lava' ? 'lava:true' : 'wet:true'] : []),
        ];
        return fail('BAD_ARGS', `[${args.at}] 挖的是脚下支撑块：${fallFacts.fallRisk}，没有往下挖；确认接受风险写 ${needs.join(' 和 ')}`, {
          ...after(ctx, args.facing, pos), ...fallFacts, ...(unknownAdjacent.length ? { unknownAdjacent } : {}),
          ...problemOf(requiresFall && !args.fall ? 'FALL_RISK_UNAUTHORIZED' : 'LIQUID_RISK_UNAUTHORIZED', 'precondition'), ...effectUnconfirmed('block_removed'),
        });
      }
    }
    const mine = args.own ? null : ownBuildingAt(ctx.memory, adapter.state(), pos, before);
    if (mine) return fail('BAD_ARGS', `[${args.at}] 的 ${before} 是自己盖的「${mine.name}」的一部分；${OWN_BUILDING_HINT}`, { own: mine, ...problemOf('OWN_BUILDING', 'precondition'), ...effectUnconfirmed('block_removed'), ...after(ctx, args.facing, pos) });
    const structure = classifyBlock(ctx.memory, adapter.state(), pos, before);
    const stash = args.own ? null : storedChestAt(ctx.memory, adapter.state(), pos, before);
    if (stash) return fail('BAD_ARGS', stash, { ...problemOf('STORED_CHEST', 'precondition'), ...effectUnconfirmed('block_removed'), ...after(ctx, args.facing, pos) });
    const keepsake = KEEPSAKE.test(before) ? before : null;
    const countOf = (n: string) => countItems(adapter, [n]);
    const had = keepsake ? countOf(keepsake) : 0;
    // 只用调用者指定的工具；没指定就只用当前手持（空手就空手挖）；autoTool 才让身体自己挑，不造工具。
    // info 会让 breakCell 回填适配器实测的 noDrop/digMs；成功回执照实带回，不把空手掉落写成“拿到了”。
    const digInfo: { noDrop?: boolean; ms?: number } = {};
    let adapterError: string | undefined;
    try {
      await breakCell(ctx, pos, true, digInfo, { allowWater: args.wet, allowLava: args.lava, ...(args.tool !== undefined ? { tool: args.tool } : args.autoTool === true ? {} : { handOnly: true }) });
    } catch (e) {
      if (isAbort(e)) throw e;
      // 适配器异常不等于世界没变：先核对目标格，已空就按部分/已确认效果继续结算。
      const effect = reconcileBlockMutation(at, pos, (s) => AIR.has(s.name));
      if (!effect.matched) {
        const now = effect.state?.name ?? null;
        const code = String((e as Error).message).startsWith('TOOL_MISSING') ? 'TOOL_MISSING' : codeFromError(e);
        return fail(code, `挖 [${args.at}] 的 ${before} 没成：${why(e)}`, {
          ...after(ctx, args.facing, pos), adapterError: why(e), now,
          ...problemOf(effect.kind === 'unknown' ? 'EFFECT_UNKNOWN' : 'EFFECT_NOT_CONFIRMED', 'reconciliation'), ...effectUnconfirmed('block_removed', effect.kind !== 'unknown'),
        });
      }
      adapterError = why(e);
    }
    // 挖后复核：只有目标格确实是空气才算移除成功；被下落方块填回/未加载都只是事实，不记成已挖掉。
    const effect = reconcileBlockMutation(at, pos, (s) => AIR.has(s.name));
    if (!effect.matched) {
      const now = effect.state?.name ?? null;
      return fail('EFFECT_NOT_CONFIRMED', `挖 [${args.at}] 的 ${before} 后，目标格仍不是空气${now === null ? '（未加载，无法确认已挖空）' : `：现在是 ${now}（可能被掉落的方块回填）`}`, {
        cell: [...args.at], was: before, now, target: { ...pos }, ...after(ctx, args.facing, pos), ...fallFacts,
        ...(adapterError ? { adapterError } : {}),
        ...problemOf(effect.kind === 'unknown' ? 'EFFECT_UNKNOWN' : 'EFFECT_NOT_CONFIRMED', 'verification'), ...effectUnconfirmed('block_removed', effect.kind !== 'unknown'),
      });
    }
    // 挖后复核已确认目标格是空气：这时才把这一格记成自身动作修改，失败/未确认不写。
    // 适配器抛错期间世界也可能被别的动作/玩家改变；目标格已空只证明当前世界状态，
    // 不能证明一定是本次挖掘造成的，这时不写自身修改记录。
    const causedByThisAction = adapterError === undefined;
    if (causedByThisAction) {
      markSelfModified(ctx.spatial, dim, pos, ctx.taskId);
      noteEdit(ctx.taskId, 'dig', pos);
    }
    // 挖掉脚下支撑后身体可能仍在落，或被相邻方块边缘托住：等落地/读实际支撑，再回执。
    // 只对“挖的是脚下支撑格”补这段事实；挖别的格子不替 Agent 推断身体会不会掉。
    const fall = digsSupport ? await (async () => {
      const settleBy = Math.min(ctx.deadline, Date.now() + 2000);
      const terminal = () => {
        const s = adapter.state();
        return s.onGround || s.inWater || s.inLava;
      };
      while (!terminal() && Date.now() < settleBy) {
        throwIfAborted(ctx.signal);
        await sleep(50, ctx.signal);
      }
      const state = adapter.state();
      return {
        onGround: state.onGround, inWater: state.inWater, inLava: state.inLava,
        pendingFall: !state.onGround && !state.inWater && !state.inLava,
        fromY: origin.pos.y, toY: state.pos.y, drop: origin.pos.y - state.pos.y,
        supports: supportCellsUnderBody(state.pos, at),
      };
    })() : undefined;
    const supportText = fall && fall.supports.length
      ? fall.supports.slice(0, 3).map((s) => `${s.name}(${s.pos.x},${s.pos.y},${s.pos.z})`).join('、')
      : '';
    const fallText = !fall ? ''
      : fall.pendingFall
        ? `；目标格已空，但身体仍在空中（y=${fall.toY.toFixed(2)}，未触地），尚未确认落地`
        : fall.inWater || fall.inLava
          ? `；身体在${fall.inWater ? '水' : '岩浆'}中（y=${fall.toY.toFixed(2)}），尚未确认落脚`
          : fall.drop > 0.01
            ? `；身体落到 y=${fall.toY.toFixed(2)}（落差 ${fall.drop.toFixed(2)} 格）`
            : fall.supports.length
              ? `；身体仍在 y=${fall.toY.toFixed(2)}，脚下还有 ${supportText} 托着，没有掉落`
              : `；目标格已空，身体仍在 y=${fall.toY.toFixed(2)}`;
    let got = '';
    let inBag: boolean | undefined;
    if (keepsake) {
      for (let i = 0; i < 6 && countOf(keepsake) <= had; i++) await sleep(150, ctx.signal);
      inBag = countOf(keepsake) > had;
      got = inBag ? `；${keepsake} 已经进了背包` : `；${keepsake} 掉在地上，还没进背包——要拿回来写 pickup_items`;
    }
    const locomotion = !fall ? undefined
      : fall.pendingFall ? 'pending' as const
        : fall.inWater ? 'in_water' as const
          : fall.inLava ? 'in_lava' as const
            : 'settled' as const;
    return ok(`挖掉了 [${args.at}] 的 ${before}${adapterError ? `（适配器回执异常：${adapterError}；已核对目标格为空）` : ''}${got}${fallText}`, {
      cell: [...args.at], was: before,
      ...effectConfirmed('block_removed'),
      ...(stateSource === 'live_loaded' ? { stateSource } : {}),
      ...(adapterError ? { adapterError, reconciled: true, causedByThisAction: 'unknown' as const } : {}),
      ...(locomotion ? { locomotion } : {}),
      ...(digInfo.noDrop !== undefined ? { noDrop: digInfo.noDrop } : {}),
      ...(digInfo.ms !== undefined ? { digMs: digInfo.ms } : {}),
      ...(inBag !== undefined ? { inBag } : {}),
      ...(fall ? { onGround: fall.onGround, pendingFall: fall.pendingFall, supports: fall.supports, fall } : {}),
      ...after(ctx, args.facing, pos), ...fallFacts,
      ...(unknownAdjacent.length ? { unknownAdjacent } : {}),
    }, structure === 'man-made' ? MAN_MADE_NOTE : undefined);
  },
};

/** 放置确切材料。目标格已有不同材料时只报占用，不把“有方块”当成功。 */
const placeCellSkill: Skill<PlaceArgs> = {
  name: 'place_cell',
  description: '在身边指定格放一块确切材料（[前,上,右] 或 xyz）。目标格已有同名方块算完成；已有别的方块（含半砖、雪层、地毯、门、火把）如实报占用，不把错误材料当成功。只放这一格，不负责找站位、不补支撑、不原地垫高。',
  argsDoc: '{"at":[前,上,右], "item":"方块名", "facing"?:"N|E|S|W"} 或 {"xyz":[x,y,z], "item":"方块名"}（xyz 是整数方块格坐标；前后/左右 ±2，上下 -2..3）',
  timeoutMs: 15000,
  movement: false,
  // 计划录入只检查写法；目标是否在放置范围由执行前按最新位置确认。
  validatePlan(raw, adapter) {
    const a = obj(raw);
    const facing = facingArg(a.facing, adapter);
    if (typeof facing !== 'string') return { ok: false, error: String(facing) };
    const item = String(a.item ?? a.block ?? '').trim().replace(/^minecraft:/, '');
    if (!item) return { ok: false, error: 'place_cell 需要 item（方块名）' };
    if (!/^[a-z0-9_]{1,80}$/.test(item) || !adapter.isKnownItem(item)) return { ok: false, error: `未知方块：${item}` };
    if (/_(boat|raft)$/.test(item)) return { ok: false, error: `${item} 是实体，不是方块` };
    const rawXyz = a.xyz ?? a.abs ?? a.world;
    if (rawXyz !== undefined) {
      const xyz = absValue(rawXyz);
      if (!xyz) return { ok: false, error: 'xyz 需要 [x,y,z] 三个有限数字' };
      if (![xyz.x, xyz.y, xyz.z].every(Number.isInteger)) return { ok: false, error: 'xyz 是方块格坐标，x/y/z 都必须是整数' };
      return { ok: true, args: { at: [0, 0, 0] as Rel, facing: facing as Facing, xyz, item } };
    }
    const at = parseRel(relValue(a), { f: 2, u: [-2, 3], r: 2 });
    if (typeof at === 'string') return { ok: false, error: at };
    return { ok: true, args: { at, facing: facing as Facing, item } };
  },
  validate(raw, adapter) {
    const a = obj(raw);
    const facing = facingArg(a.facing, adapter);
    if (typeof facing !== 'string') return { ok: false, error: String(facing) };
    const item = String(a.item ?? a.block ?? '').trim().replace(/^minecraft:/, '');
    if (!item) return { ok: false, error: 'place_cell 需要 item（方块名）' };
    if (!/^[a-z0-9_]{1,80}$/.test(item) || !adapter.isKnownItem(item)) return { ok: false, error: `未知方块：${item}` };
    if (/_(boat|raft)$/.test(item)) return { ok: false, error: `${item} 是实体，不是方块` };
    const rawXyz = a.xyz ?? a.abs ?? a.world;
    if (rawXyz !== undefined) {
      const xyz = absValue(rawXyz);
      if (!xyz) return { ok: false, error: 'xyz 需要 [x,y,z] 三个有限数字' };
      if (![xyz.x, xyz.y, xyz.z].every(Number.isInteger)) return { ok: false, error: 'xyz 是方块格坐标，x/y/z 都必须是整数' };
      const rel = parseRel(toRel(feetCell(adapter.state().pos), facing as Facing, xyz), { f: 2, u: [-2, 3], r: 2 });
      if (typeof rel === 'string') return { ok: false, error: `(${xyz.x},${xyz.y},${xyz.z}) 不在身边能放置的范围：${rel}；先走近` };
      return { ok: true, args: { at: rel, facing: facing as Facing, xyz, item } };
    }
    const at = parseRel(relValue(a), { f: 2, u: [-2, 3], r: 2 });
    if (typeof at === 'string') return { ok: false, error: at };
    return { ok: true, args: { at, facing: facing as Facing, item } };
  },
  async run(ctx, args) {
    throwIfAborted(ctx.signal);
    const adapter = ctx.adapter;
    const at = stateReader(adapter);
    const origin = adapter.state();
    const feet = feetCell(origin.pos);
    // 归因用动作开始时的维度，避免确认前后跨维度时把旧格记到新维度。
    const dim = origin.dim;
    const pos = args.xyz !== undefined ? { ...args.xyz } : toWorld(feet, args.facing, args.at);
    const atText = args.xyz === undefined ? `[${args.at}]` : `(${pos.x},${pos.y},${pos.z})`;
    const key = `${pos.x},${pos.y},${pos.z}`;
    // stateAt 只判几何/占用；名称、材质说明只来自本次 visibleStates，未看清就如实写未看清。
    const raw = at(pos);
    const seen = visibleStates(ctx, [pos]).get(key) ?? null;
    if (raw === null) return fail('NOT_FOUND', `${atText} 目标格未加载，无法确认是否为空，没有放置`, { ...after(ctx, args.facing, pos), ...problemOf('TARGET_STATE_UNKNOWN', 'precondition'), ...effectUnconfirmed('block_placed') });
    if (!AIR.has(raw.name) && !isReplaceable(raw.name)) {
      if (seen && (seen.name === args.item || WALL_TORCH[args.item] === seen.name)) return ok(`${atText} 已经有 ${seen.name} 了`, { already: seen.name, noop: true, ...effectConfirmed('block_placed'), ...after(ctx, args.facing, pos) });
      if (seen) return fail('PATH_NOT_FOUND', `${atText} 已被 ${seen.name} 占据（${shapeOf(seen.name, seen.properties)}），不是要放的 ${args.item}；先 mine_cell 清掉或换一格`, { occupied: seen.name, ...problemOf('TARGET_OCCUPIED', 'precondition'), ...effectUnconfirmed('block_placed'), ...after(ctx, args.facing, pos) });
      return fail('PATH_NOT_FOUND', `${atText} 已被方块占据（本次未看清是什么），无法确认是否已经是 ${args.item}；没有放置，换角度看清楚或先 mine_cell`, { occupied: null, unknown: true, ...problemOf('TARGET_STATE_UNKNOWN', 'precondition'), ...effectUnconfirmed('block_placed'), ...after(ctx, args.facing, pos) });
    }
    if (countItems(adapter, [args.item]) <= 0) return fail('MISSING_MATERIALS', `背包里没有 ${args.item}`, { ...after(ctx, args.facing, pos), ...problemOf('MISSING_MATERIAL', 'precondition'), ...effectUnconfirmed('block_placed') });
    const beforeCount = countItems(adapter, [args.item]);
    let adapterReason: string | undefined;
    let adapterError: string | undefined;
    let attemptedFaces: PlacementFaceAttempt[] = [];
    try {
      const r = await adapter.placeBlockAt(pos, [args.item], ctx.signal);
      attemptedFaces = r.attemptedFaces ?? [];
      if (!r.ok) {
        adapterReason = r.reason ?? '放置失败';
        adapterError = r.detail;
      }
    } catch (e) {
      if (isAbort(e)) throw e;
      adapterError = (e as Error).message;
    }
    // 回执只是执行结果，世界状态才是效果证据：无论成功、失败还是抛错，都核对目标格。
    const replaced = reconcileBlockMutation(at, pos, (s) => s.name === args.item || WALL_TORCH[args.item] === s.name);
    const now = replaced.state;
    const matches = replaced.matched;
    if (now === null) {
      return fail('EFFECT_NOT_CONFIRMED', `${atText} 放置后目标格未加载，无法确认实际方块`, {
        requested: args.item, attemptedFaces, ...(adapterReason ? { adapterReason } : {}), ...(adapterError ? { adapterError } : {}),
        ...problemOf('EFFECT_UNKNOWN', 'reconciliation'), ...effectUnconfirmed('block_placed', true), ...after(ctx, args.facing, pos),
      });
    }
    if (!matches) {
      const observed = visibleStates(ctx, [pos]).get(key) ?? null;
      // 目标仍是原来的空气/可替换植物：这是“没放上”，不是放成了错误材料。
      if (AIR.has(now.name) || (now.name === raw.name && isReplaceable(now.name))) {
        if (adapterReason === undefined && adapterError === undefined) {
          return fail('EFFECT_NOT_CONFIRMED', `${atText} 适配器回执成功，但目标格仍是空气`, {
            requested: args.item, attemptedFaces, ...problemOf('EFFECT_NOT_CONFIRMED', 'verification'), ...effectUnconfirmed('block_placed'), ...after(ctx, args.facing, pos),
          });
        }
        const reason = adapterReason ?? adapterError ?? '适配器回执没有说明';
        const code = adapterReason === 'NO_ITEM' ? 'MISSING_MATERIALS'
          : /^NO_REFERENCE|^NO_PLACEMENT_FACE/.test(adapterReason ?? '') ? 'BAD_ARGS'
            : adapterError ? codeFromError(new Error(adapterError)) : 'PATH_NOT_FOUND';
        // 参照面事实必须进摘要：只放 data 时心智看到的只有 NO_REFERENCE，会继续猜同一格。
        const faces = attemptedFaces.slice(0, 2)
          .map((f) => `参照 (${f.ref.x},${f.ref.y},${f.ref.z}) 的 [${f.face.join(',')}] 面${f.reason ? `：${f.reason}` : ''}`)
          .join('；');
        const detail = [adapterError, faces].filter(Boolean).join('；');
        // 目标与脚格相邻且在下 1–2 格时，唯一能贴的面常是被自己踩着的支撑块侧面；
        // place_cell 不换站位，所以要点明 place_support 才能贴边放，而不是让心智反复猜“靠近”。
        const drop = feet.y - pos.y;
        const supportLike = Math.abs(pos.x - feet.x) + Math.abs(pos.z - feet.z) === 1 && (drop === 1 || drop === 2);
        const supportHint = supportLike && /^NO_REFERENCE/.test(adapterReason ?? '')
          ? '；这一格与脚格相邻且在下 1–2 格：要贴边放用 place_support（它会潜行到方块边缘），place_cell 不换站位'
          : '';
        return fail(code, `放不到 ${atText}：${reason}${detail ? `；${detail}` : ''}${supportHint}`, {
          attemptedFaces, ...(adapterReason ? { adapterReason } : {}), ...(adapterError ? { adapterError } : {}),
          ...problemOf(adapterError ? 'PLACEMENT_ADAPTER_ERROR' : 'PLACEMENT_REFUSED', 'execution'), ...effectUnconfirmed('block_placed'), ...after(ctx, args.facing, pos),
        });
      }
      // 目标格的实际方块是本次动作的效果证据（目标原本是空气/可替换），不是墙后地形；如实报告。
      return fail('EFFECT_NOT_CONFIRMED', `${atText} 实际出现的是 ${now.name}，不是请求的 ${args.item}`, {
        placed: now.name, requested: args.item, observed: observed !== null, attemptedFaces,
        ...(adapterReason ? { adapterReason } : {}), ...(adapterError ? { adapterError } : {}),
        ...problemOf('EFFECT_MISMATCH', 'verification'), ...effectUnconfirmed('block_placed', true), ...after(ctx, args.facing, pos),
      });
    }
    // 以放置后的权威方块状态确认材料；可见快照只作附加证据，不作为唯一判断。
    const observed = visibleStates(ctx, [pos]).get(key) ?? null;
    const consumption = consumptionReceipt(adapter, [args.item], beforeCount, { pendingWhenZero: true });
    const consumed = consumption.consumed;
    markSelfModified(ctx.spatial, dim, pos, ctx.taskId);
    noteEdit(ctx.taskId, 'place', pos);
    if (isStation(now.name)) rememberStation(ctx, now.name, pos);
    return ok(
      `在 ${atText} 放了 ${now.name}${adapterError ? `（适配器回执异常：${adapterError}；已核对世界状态）` : ''}；${consumptionText(consumption)}`,
      {
        placed: now.name, requested: args.item, observed: observed !== null,
        ...(adapterReason ? { adapterReason } : {}), ...(adapterError ? { adapterError, reconciled: true } : {}),
        consumed, inventory: {
          item: args.item, before: consumption.before, after: consumption.after, consumed,
          inventoryDelta: consumption.inventoryDelta, inventorySync: consumption.inventorySync,
          verified: consumption.consumptionVerified, ...(consumption.consumptionPending ? { pending: true } : {}),
        },
        ...effectConfirmed('block_placed'),
        ...after(ctx, args.facing, pos),
      },
    );
  },
};

/** 形成可站立支撑；已有可站面就成功，不要求同名材料。 */
const placeSupportSkill: Skill<SupportArgs> = {
  name: 'place_support',
  description: '在指定格形成可站立支撑（[前,上,右] 或 xyz）。必须用 item 指定方块名或显式 "any"，不会默认替你选材料。已有可站立顶面（整块、半砖、雪层等）就算满足，不要求与 item 同名，也不再消耗材料；只有空气/可替换植物才放 item。支持脚下一格和脚下两格；当前站位看不到参照面时会后退/侧移或潜行到支撑块边缘再放。脚下两格的边缘放置需要支撑块下方那一格是同层实心参照方块；没有就如实失败，改用 descend_to 或换到能看见参照面的站位。成功回执返回 consumed=放置前后目标材料总数之差；失败回执返回每次尝试的实际站位与参照面事实。只放这一格，不换材料、不换目标，不自动清障/垫高。',
  argsDoc: `{"at":[前,上,右], "item":"方块名|any", "facing"?:"N|E|S|W"} 或 {"xyz":[x,y,z], "item":"方块名|any"}（item 必填：已知方块名或字面 any，${ANY_FILL_NOTE}；xyz 是整数方块格坐标；前后/左右 ±2，上下 -2..3）`,
  timeoutMs: 20000,
  movement: true,
  // 计划录入只检查写法；目标是否在放置范围由执行前按最新位置确认。
  validatePlan(raw, adapter) {
    const a = obj(raw);
    const facing = facingArg(a.facing, adapter);
    if (typeof facing !== 'string') return { ok: false, error: String(facing) };
    const explicit = a.item ?? a.block;
    if (explicit === undefined || explicit === null || String(explicit).trim() === '') {
      return { ok: false, error: 'place_support 需要 item：已知方块名或字面 "any"（不会默认自选材料）' };
    }
    const item = String(explicit).trim().replace(/^minecraft:/, '');
    if (item !== 'any' && (!/^[a-z0-9_]{1,80}$/.test(item) || !adapter.isKnownItem(item))) return { ok: false, error: `item 需要已知方块名或 "any"` };
    if (/_(boat|raft)$/.test(item)) return { ok: false, error: `${item} 是实体，不是方块` };
    const rawXyz = a.xyz ?? a.abs ?? a.world;
    if (rawXyz !== undefined) {
      const xyz = absValue(rawXyz);
      if (!xyz) return { ok: false, error: 'xyz 需要 [x,y,z] 三个有限数字' };
      if (![xyz.x, xyz.y, xyz.z].every(Number.isInteger)) return { ok: false, error: 'xyz 是方块格坐标，x/y/z 都必须是整数' };
      return { ok: true, args: { at: [0, 0, 0] as Rel, facing: facing as Facing, xyz, item } };
    }
    const at = parseRel(relValue(a), { f: 2, u: [-2, 3], r: 2 });
    if (typeof at === 'string') return { ok: false, error: at };
    return { ok: true, args: { at, facing: facing as Facing, item } };
  },
  validate(raw, adapter) {
    const a = obj(raw);
    const facing = facingArg(a.facing, adapter);
    if (typeof facing !== 'string') return { ok: false, error: String(facing) };
    const explicit = a.item ?? a.block;
    if (explicit === undefined || explicit === null || String(explicit).trim() === '') {
      return { ok: false, error: 'place_support 需要 item：已知方块名或字面 "any"（不会默认自选材料）' };
    }
    const item = String(explicit).trim().replace(/^minecraft:/, '');
    if (item !== 'any' && (!/^[a-z0-9_]{1,80}$/.test(item) || !adapter.isKnownItem(item))) return { ok: false, error: `item 需要已知方块名或 "any"` };
    if (/_(boat|raft)$/.test(item)) return { ok: false, error: `${item} 是实体，不是方块` };
    const rawXyz = a.xyz ?? a.abs ?? a.world;
    if (rawXyz !== undefined) {
      const xyz = absValue(rawXyz);
      if (!xyz) return { ok: false, error: 'xyz 需要 [x,y,z] 三个有限数字' };
      if (![xyz.x, xyz.y, xyz.z].every(Number.isInteger)) return { ok: false, error: 'xyz 是方块格坐标，x/y/z 都必须是整数' };
      const rel = parseRel(toRel(feetCell(adapter.state().pos), facing as Facing, xyz), { f: 2, u: [-2, 3], r: 2 });
      if (typeof rel === 'string') return { ok: false, error: `(${xyz.x},${xyz.y},${xyz.z}) 不在身边能放置的范围：${rel}；先走近` };
      return { ok: true, args: { at: rel, facing: facing as Facing, xyz, item } };
    }
    const at = parseRel(relValue(a), { f: 2, u: [-2, 3], r: 2 });
    if (typeof at === 'string') return { ok: false, error: at };
    return { ok: true, args: { at, facing: facing as Facing, item } };
  },
  async run(ctx, args) {
    throwIfAborted(ctx.signal);
    const adapter = ctx.adapter;
    const at = stateReader(adapter);
    const origin = adapter.state();
    const feet = feetCell(origin.pos);
    // 归因用动作开始时的维度，避免确认前后跨维度时把旧格记到新维度。
    const dim = origin.dim;
    const pos = args.xyz !== undefined ? { ...args.xyz } : toWorld(feet, args.facing, args.at);
    const atText = args.xyz === undefined ? `[${args.at}]` : `(${pos.x},${pos.y},${pos.z})`;
    const key = `${pos.x},${pos.y},${pos.z}`;
    const movementStart = { ...origin.pos };
    // 支撑目标不等于要求玩家到达的脚位。这里只按确认的支撑顶面给出意图脚位和衔接状态：
    // ready = 身体已站上该支撑；needs_rebind = 支撑已形成但相对坐标原点已变，下一步要显式重绑定；
    // blocked = 支撑顶面上方身体空间不足，站不上去。
    const standFacts = (topWorld: number | null) => {
      const intended = topWorld === null ? null : { x: pos.x, y: topWorld, z: pos.z };
      const now = adapter.state();
      const body = intended === null ? null : inspectBody(at, intended.y, intended.x, intended.z);
      const blocker = body?.blockers[0];
      const onSupport = intended !== null && feetCell(now.pos).x === intended.x && feetCell(now.pos).z === intended.z
        && Math.abs(now.pos.y - intended.y) <= 0.01;
      return {
        supportTarget: { ...pos },
        supportConfirmed: topWorld !== null,
        positionBefore: { ...movementStart },
        positionAfter: { ...now.pos },
        stanceChanged: Math.hypot(now.pos.x - movementStart.x, now.pos.z - movementStart.z) > 0.01 || Math.abs(now.pos.y - movementStart.y) > 0.01,
        ...(intended ? { intendedStandTarget: intended } : {}),
        continuation: topWorld === null || blocker ? 'blocked' as const
          : onSupport ? 'ready' as const : 'needs_rebind' as const,
        ...(blocker ? { intendedStandBlocked: { cell: { ...blocker.cell } } } : {}),
      };
    };
    // stateAt 只判几何/支撑；名称与材质说明只来自本次 visibleStates，未看清就如实写未看清。
    const seenAt = () => visibleStates(ctx, [pos]).get(key) ?? null;
    const inspected = inspectSupport(at, pos);
    const raw = inspected.state;
    if (raw === null) return fail('NOT_FOUND', `${atText} 目标格未加载，无法确认是否需要支撑`, { ...after(ctx, args.facing, pos), ...problemOf('TARGET_STATE_UNKNOWN', 'precondition'), ...effectUnconfirmed('support_formed') });
    const top = inspected.top;
    if (top !== null) {
      const seen = seenAt();
      return ok(
        `${atText} 已经有可站立支撑${seen ? ` ${seen.name}（${shapeOf(seen.name, seen.properties)}）` : '（本次未看清名称和形状）'}，没有另放 ${args.item}`,
        { already: seen?.name ?? null, observed: seen !== null, supportTop: pos.y + top, standable: true, noop: true, consumed: 0, consumptionVerified: true, ...standFacts(pos.y + top), ...effectConfirmed('support_formed'), ...after(ctx, args.facing, pos) },
      );
    }
    if (!isReplaceable(raw.name)) {
      const seen = seenAt();
      return fail(
        'PATH_NOT_FOUND',
        seen
          ? `${atText} 已被 ${seen.name} 占据（${shapeOf(seen.name, seen.properties)}），不是可站立支撑；先 mine_cell 清掉或换一格`
          : `${atText} 已被方块占据（本次未看清是什么），不是可站立支撑；先 mine_cell 清掉或换一格`,
        { occupied: seen?.name ?? null, observed: seen !== null, ...problemOf('TARGET_OCCUPIED', 'precondition'), ...effectUnconfirmed('support_formed'), ...after(ctx, args.facing, pos) },
      );
    }
    const inv = adapter.state().inventory;
    const names = args.item === 'any' ? PLACEABLE.filter((n) => inv.some((i) => i.name === n && i.count > 0)) : [args.item];
    if (!names.length || countItems(adapter, names) <= 0) return fail('MISSING_MATERIALS', `背包里没有 ${args.item === 'any' ? anyShortfall(adapter, inv) : args.item}`, { ...after(ctx, args.facing, pos), ...problemOf('MISSING_MATERIAL', 'precondition'), ...effectUnconfirmed('support_formed') });
    const beforeCount = countItems(adapter, names);
    // 库存更新可能滞后：看到净减少才算确认消耗；成功但暂时 0 消耗标为 pending，不冒充真实零消耗。
    const consumptionFacts = (effectExpected: boolean) => consumptionReceipt(adapter, names, beforeCount, { pendingWhenZero: effectExpected });
    const attempts: PlaceAttempt[] = [];
    let movementAttempted = false;
    // position = 尝试放置时的站位（适配器能报边缘站位就用它）；endPosition = 调用返回后身体实际在哪。
    const attemptFacts = (stance: string, position: Vec3Like, extra: Partial<PlaceAttempt> = {}) => {
      const problem = extra.problem ?? (extra.reason ? { kind: placementProblem(extra.reason) } : undefined);
      attempts.push({ stance, position, endPosition: { ...adapter.state().pos }, ...extra, ...(problem ? { problem } : {}) });
    };
    // 站位调整是这个原语的副作用，必须作为一等结果返回，不能藏在 attempts 里。
    const movementFacts = () => {
      const end = adapter.state().pos;
      return {
        movement: {
          attempted: movementAttempted, start: { ...movementStart }, end: { ...end },
          changed: Math.hypot(end.x - movementStart.x, end.z - movementStart.z) > 0.01 || Math.abs(end.y - movementStart.y) > 0.01,
        },
      };
    };
    /** 世界状态核对：不管适配器回执如何都读一次目标格。 */
    const readTarget = () => {
      const effect = inspectSupport(at, pos);
      return {
        now: effect.state,
        confirmed: effect.top !== null,
        unknown: effect.state === null,
        changed: effect.state !== null && !isReplaceable(effect.state.name),
      };
    };
    /**
     * 异常/超时可能已经产生效果：短暂等待后再核对一次，但不无限重试。
     * 目标格一旦确认、发生变化或变得不可读就停止等待，立即按当前世界状态结算。
     */
    const waitForEffect = async (ms: number) => {
      const until = Math.min(ctx.deadline, Date.now() + ms);
      while (Date.now() < until) {
        const effect = readTarget();
        if (effect.confirmed || effect.changed || effect.unknown) return;
        throwIfAborted(ctx.signal);
        await sleep(50, ctx.signal);
      }
    };
    let formed = false;
    const reconcile = (stance: string, position: Vec3Like, facts: { reason?: string; detail?: string; attemptedFaces?: PlacementFaceAttempt[]; ambiguous?: boolean }) => {
      const effect = readTarget();
      const extra = {
        ...(facts.reason ? { reason: facts.reason } : {}),
        ...(facts.detail ? { detail: facts.detail } : {}),
        ...(facts.attemptedFaces?.length ? { attemptedFaces: facts.attemptedFaces } : {}),
        ...(facts.ambiguous ? { reconciled: true } : {}),
      };
      if (effect.confirmed) {
        formed = true;
        attemptFacts(stance, position, { ok: true, effect: 'support', ...extra });
        return 'formed' as const;
      }
      attemptFacts(stance, position, { ...extra, effect: effect.unknown ? 'unknown' : effect.changed ? 'changed_without_support' : 'unchanged' });
      return effect.unknown ? 'unknown' as const : effect.changed ? 'blocked' as const : 'unchanged' as const;
    };
    // 目标格已变但未成支撑、或无法读取：停止换站位，避免一次委托消耗多块或掩盖未知状态。
    const stoppedByEffect = (outcome: 'formed' | 'unknown' | 'blocked' | 'unchanged') => {
      if (outcome === 'formed' || outcome === 'unchanged') return null;
      if (outcome === 'unknown') {
        return fail('EFFECT_NOT_CONFIRMED', `${atText} 放置后目标格未加载，无法确认是否已形成支撑；停止重试`, {
          attempts, materials: [...names], ...consumptionFacts(true), targetCell: { ...pos },
          ...movementFacts(), ...problemOf('EFFECT_UNKNOWN', 'reconciliation'), ...effectUnconfirmed('support_formed', true), ...after(ctx, args.facing, pos),
        });
      }
      const seen = seenAt();
      return fail('EFFECT_NOT_CONFIRMED', `${atText} 目标格已经变成 ${seen?.name ?? '别的方块'}，但没有形成可站立支撑；停止重复放置`, {
        attempts, materials: [...names], ...consumptionFacts(true), targetCell: { ...pos },
        placementEffect: 'changed_without_support' as const,
        ...movementFacts(), ...problemOf('EFFECT_MISMATCH', 'verification'), ...effectUnconfirmed('support_formed', true), ...after(ctx, args.facing, pos),
      });
    };
    // 1) 当前站位直接放
    const currentStance = { ...adapter.state().pos };
    let receiptOk = false;
    let outcome: 'formed' | 'unknown' | 'blocked' | 'unchanged';
    try {
      const r = await adapter.placeBlockAt(pos, names, ctx.signal);
      receiptOk = r.ok;
      // 模糊失败（超时/无说明）可能已经产生放置；先给服务器更新一个有限窗口再核对。
      if (!r.ok && placementMayHaveExecuted(r.reason)) await waitForEffect(250);
      outcome = reconcile('current', currentStance, {
        ...(r.ok ? {} : { reason: r.reason ?? r.detail ?? 'not placed' }),
        ...(r.detail ? { detail: r.detail } : {}),
        ...(r.attemptedFaces?.length ? { attemptedFaces: r.attemptedFaces } : {}),
        ambiguous: !r.ok,
      });
    } catch (e) {
      if (isAbort(e)) throw e;
      await waitForEffect(250);
      outcome = reconcile('current', currentStance, { reason: `adapter_error:${(e as Error).message}`, ambiguous: true });
    }
    const currentStopped = stoppedByEffect(outcome);
    if (currentStopped) return currentStopped;
    // 回执成功但世界没有变化：两份证据冲突，不能再换站位碰运气。
    if (receiptOk && outcome !== 'formed') {
      return fail('EFFECT_NOT_CONFIRMED', `${atText} 适配器回执成功，但目标格仍没有形成可站立支撑；停止重试`, {
        attempts, materials: [...names], ...consumptionFacts(true), targetCell: { ...pos },
        ...movementFacts(), ...problemOf('EFFECT_NOT_CONFIRMED', 'verification'), ...effectUnconfirmed('support_formed'), ...after(ctx, args.facing, pos),
      });
    }
    const dx = pos.x - feet.x, dz = pos.z - feet.z;
    const drop = feet.y - pos.y;
    // 2) 目标与脚水平相邻、在脚下一格或两格：交给适配器的边缘潜行放置。
    //    两格下要求支撑块下方有同层实心参照方块；适配器做不了会如实返回 EDGE_*，不伪造成功。
    if (!formed && adapter.sneakPlaceAt && Math.abs(dx) + Math.abs(dz) === 1 && (Math.abs(drop - 1) <= 0.01 || Math.abs(drop - 2) <= 0.01)) {
      // 调用前的站位；适配器若报告实际潜行到的边缘站位，就用它作为尝试站位。
      const edgeEntry = { ...adapter.state().pos };
      movementAttempted = true;
      let edgeReceiptOk = false;
      try {
        const edge = await adapter.sneakPlaceAt(pos, names, ctx.signal);
        edgeReceiptOk = edge.ok;
        if (!edge.ok && placementMayHaveExecuted(edge.reason)) await waitForEffect(250);
        outcome = reconcile('edge', edge.stance ?? edgeEntry, {
          ...(edge.ok ? {} : { reason: edge.reason ?? 'not placed' }),
          ...(edge.attemptedFaces?.length ? { attemptedFaces: edge.attemptedFaces } : {}),
          ambiguous: !edge.ok,
        });
      } catch (e) {
        if (isAbort(e)) throw e;
        await waitForEffect(250);
        outcome = reconcile('edge', edgeEntry, { reason: `adapter_error:${(e as Error).message}`, ambiguous: true });
      }
      const edgeStopped = stoppedByEffect(outcome);
      if (edgeStopped) return edgeStopped;
      if (edgeReceiptOk && outcome !== 'formed') {
        return fail('EFFECT_NOT_CONFIRMED', `${atText} 边缘放置回执成功，但目标格仍没有形成可站立支撑；停止重试`, {
          attempts, materials: [...names], ...consumptionFacts(true), targetCell: { ...pos },
          ...movementFacts(), ...problemOf('EFFECT_NOT_CONFIRMED', 'verification'), ...effectUnconfirmed('support_formed'), ...after(ctx, args.facing, pos),
        });
      }
    }
    // 3) 换一个站位重试：后退一格、左右各一格。只换站位，不换目标/材料。
    const stances = [
      { name: 'back', pos: { x: feet.x - Math.sign(dx), y: feet.y, z: feet.z - Math.sign(dz) } },
      { name: 'left', pos: { x: feet.x - Math.sign(dz), y: feet.y, z: feet.z + Math.sign(dx) } },
      { name: 'right', pos: { x: feet.x + Math.sign(dz), y: feet.y, z: feet.z - Math.sign(dx) } },
    ].filter((s) => s.pos.x !== feet.x || s.pos.z !== feet.z);
    for (const stance of formed ? [] : stances) {
      const beforeMove = { ...adapter.state().pos };
      movementAttempted = true;
      try {
        // y 用连续实测脚高，不用离散脚格：半砖/雪层上换站位时不能被要求走到格底。
        await adapter.moveTo({ kind: 'near', pos: { x: stance.pos.x + 0.5, y: origin.pos.y, z: stance.pos.z + 0.5 }, range: 0.3 }, { signal: ctx.signal, timeoutMs: Math.min(2500, ctx.deadline - Date.now()), allowSwimming: false });
      } catch (e) {
        if (isAbort(e)) throw e;
        const afterMove = { ...adapter.state().pos };
        const moved = Math.hypot(afterMove.x - beforeMove.x, afterMove.z - beforeMove.z) > 0.05
          || Math.abs(afterMove.y - beforeMove.y) > 0.05;
        attemptFacts(stance.name, beforeMove, { reason: `move:${(e as Error).message}`, effect: 'not_attempted' });
        // 移动异常前可能已经走了半程：旧起点生成的候选站位不再成立，不能继续按旧计划换站位。
        if (moved) {
          return fail('EFFECT_NOT_CONFIRMED', `${atText} 换到 ${stance.name} 站位时移动出错，身体已经离开原位置（${beforeMove.x.toFixed(2)},${beforeMove.y.toFixed(2)},${beforeMove.z.toFixed(2)} → ${afterMove.x.toFixed(2)},${afterMove.y.toFixed(2)},${afterMove.z.toFixed(2)}）；不再按旧起点继续换站位`, {
            attempts, materials: [...names], targetCell: { ...pos }, stanceMove: { from: beforeMove, to: afterMove },
            ...movementFacts(), ...problemOf('STANCE_MOVE_PARTIAL', 'execution', true), ...effectUnconfirmed('support_formed', true), ...after(ctx, args.facing, pos),
          });
        }
        continue;
      }
      // moveTo 返回不等于站位可用：落地、脚格和脚高都要与候选站位一致，再执行放置。
      const stanceState = adapter.state();
      const stanceAt = { ...stanceState.pos };
      const atCell = feetCell(stanceAt);
      if (!stanceState.onGround || atCell.x !== stance.pos.x || atCell.z !== stance.pos.z || Math.abs(stanceAt.y - origin.pos.y) > 0.51) {
        attemptFacts(stance.name, stanceAt, { reason: 'stance-not-confirmed', effect: 'not_attempted' });
        continue;
      }
      let stanceReceiptOk = false;
      try {
        const r = await adapter.placeBlockAt(pos, names, ctx.signal);
        stanceReceiptOk = r.ok;
        if (!r.ok && placementMayHaveExecuted(r.reason)) await waitForEffect(250);
        outcome = reconcile(stance.name, stanceAt, {
          ...(r.ok ? {} : { reason: r.reason ?? r.detail ?? 'not placed' }),
          ...(r.detail ? { detail: r.detail } : {}),
          ...(r.attemptedFaces?.length ? { attemptedFaces: r.attemptedFaces } : {}),
          ambiguous: !r.ok,
        });
      } catch (e) {
        if (isAbort(e)) throw e;
        await waitForEffect(250);
        outcome = reconcile(stance.name, stanceAt, { reason: `adapter_error:${(e as Error).message}`, ambiguous: true });
      }
      if (outcome === 'formed') break;
      const stanceStopped = stoppedByEffect(outcome);
      if (stanceStopped) return stanceStopped;
      if (stanceReceiptOk) {
        return fail('EFFECT_NOT_CONFIRMED', `${atText} 在 ${stance.name} 站位放置回执成功，但目标格仍没有形成可站立支撑；停止重试`, {
          attempts, materials: [...names], ...consumptionFacts(true), targetCell: { ...pos },
          ...movementFacts(), ...problemOf('EFFECT_NOT_CONFIRMED', 'verification'), ...effectUnconfirmed('support_formed'), ...after(ctx, args.facing, pos),
        });
      }
    }
    if (!formed) {
      // 每次尝试只留“站位:原因”，完整 detail 留在 data；否则摘要会被心智的长文截断，
      // 真正有用的 edge/EDGE_NO_REFERENCE 正好落在被截掉的中间。
      const brief = (s: string) => s.length <= 120 ? s : `${s.slice(0, 119)}…`;
      const attemptText = attempts
        .map((a) => `${a.stance}:${brief(a.reason ?? '未放置')}`)
        .join('；');
      const firstDetail = attempts.find((a) => a.detail)?.detail;
      // 目标不在贴边放置的几何内时，把原因直接说清楚，别只列一堆 stance-not-confirmed。
      const geometryNote = Math.abs(dx) + Math.abs(dz) !== 1
        ? `；目标与脚格水平相距 ${Math.abs(dx) + Math.abs(dz)} 格，贴边放置只支持水平相邻格；先走到目标旁或换落点`
        : drop < 1 || drop > 2 ? `；目标在脚下 ${drop} 格，place_support 只补脚下一格或两格；先下到目标层或换落点` : '';
      // 直接调用 place_support 时参照面不成立是参数/站位问题（BAD_ARGS）；但 excavate_run 的 fill
      // 需要区分“仍缺支撑”和其他能力缺口，所以额外给出结构化的原因。
      const referenceGap = attempts.some((a) => a.problem !== undefined && REFERENCE_PROBLEMS.has(a.problem.kind));
      // 材料在预检后不可用：按材料缺口报告，不混成参数/站位问题。
      const missingMaterial = attempts.some((a) => a.problem?.kind === 'MISSING_MATERIAL');
      return fail(missingMaterial ? 'MISSING_MATERIALS' : 'BAD_ARGS',
        `${atText} 没能形成可站立支撑：${attemptText}${firstDetail ? `；${brief(firstDetail)}` : ''}${geometryNote}`, {
        attempts, materials: [...names], ...consumptionFacts(false), targetCell: { ...pos },
        ...(referenceGap ? { failureCause: 'reference' as const } : {}),
        remediation: {
          stance: '换到能看见目标格相邻实心面的站位再 place_support（例如目标格另一侧）',
          alternatives: ['descend_to 降到下一级后从下方补支撑', 'place_cell 在已有参照面的相邻格放置'],
          ...(firstDetail ? { reference: firstDetail } : {}),
        },
        ...movementFacts(), ...problemOf(missingMaterial ? 'MISSING_MATERIAL' : referenceGap ? 'NO_REFERENCE' : 'PLACEMENT_FAILED', 'precondition'), ...effectUnconfirmed('support_formed'), ...after(ctx, args.facing, pos),
      });
    }
    // 只有世界核对确认目标格已形成可站立顶面才算 formed；未成支撑不记修改。
    const consumption = consumptionFacts(true);
    markSelfModified(ctx.spatial, dim, pos, ctx.taskId);
    noteEdit(ctx.taskId, 'place', pos);
    const observed = seenAt();
    if (observed && isStation(observed.name)) rememberStation(ctx, observed.name, pos);
    const supportTopY = inspectSupport(at, pos).top;
    return ok(
      `${atText} 形成可站立支撑${observed ? ` ${observed.name}` : '（实际材料名称本次未看清）'}，${consumptionText(consumption)}`,
      {
        placed: observed?.name ?? null, observed: observed !== null, materials: [...names], ...consumption,
        attempts, targetCell: { ...pos }, supportTop: supportTopY === null ? null : pos.y + supportTopY,
        ...standFacts(supportTopY === null ? null : pos.y + supportTopY),
        ...effectConfirmed('support_formed'),
        ...movementFacts(), ...after(ctx, args.facing, pos),
      },
    );
  },
};

/** 原地垫高一格。不挖头顶，不决定要不要继续爬。 */
const pillarOneSkill: Skill<{ item?: string }> = {
  name: 'pillar_one',
  description: '原地垫高一格：跳起来往脚下放一块方块并确认真的站上去。必须用 item 指定方块名或显式 "any"，不会默认替你选材料。头顶/侧上方阻挡时返回具体格，由你决定先 mine_cell。只垫一格，不连续爬升，不挖头顶。',
  argsDoc: `{"item":"方块名|any"}（item 必填：已知方块名或字面 any，${ANY_FILL_NOTE}；不会默认自选材料）`,
  timeoutMs: 20000,
  movement: true,
  validate(raw, adapter) {
    const a = obj(raw);
    const explicit = a.item ?? a.block;
    if (explicit === undefined || explicit === null || String(explicit).trim() === '') {
      return { ok: false, error: 'pillar_one 需要 item：已知方块名或字面 "any"（不会默认自选材料）' };
    }
    const item = String(explicit).trim().replace(/^minecraft:/, '');
    if (item !== 'any' && (!/^[a-z0-9_]{1,80}$/.test(item) || !adapter.isKnownItem(item))) return { ok: false, error: 'item 需要已知方块名或 "any"' };
    if (/_(boat|raft)$/.test(item)) return { ok: false, error: `${item} 是实体，不是方块` };
    return { ok: true, args: { item } };
  },
  async run(ctx, args) {
    throwIfAborted(ctx.signal);
    const adapter = ctx.adapter;
    const at = stateReader(adapter);
    if (!args.item) return fail('BAD_ARGS', 'pillar_one 需要 item：已知方块名或字面 "any"', { ...problemOf('MISSING_ARGUMENT', 'validation'), ...effectUnconfirmed('movement') });
    if (!adapter.pillarUp) return fail('ERROR', '当前适配器没有原地垫高能力', { ...problemOf('CAPABILITY_MISSING', 'precondition'), ...effectUnconfirmed('movement') });
    const inv = adapter.state().inventory;
    const names = args.item === 'any' ? PLACEABLE.filter((n) => inv.some((i) => i.name === n && i.count > 0)) : [args.item];
    if (!names.length || countItems(adapter, names) <= 0) return fail('MISSING_MATERIALS', `背包里没有 ${args.item === 'any' ? anyShortfall(adapter, inv) : args.item}`, { ...problemOf('MISSING_MATERIAL', 'precondition'), ...effectUnconfirmed('movement') });
    const beforeCount = countItems(adapter, names);
    const startState = adapter.state();
    // 垫脚块放在脚踩的支撑方块上面一格；灵魂沙/半砖上 feetCell 是支撑方块本身，不能当放置格。
    const support0 = supportCell(startState.pos);
    const feet = { ...support0, y: support0.y + 1 };
    // 归因用动作开始时的维度，避免确认前后跨维度时把旧格记到新维度。
    const dim = startState.dim;
    // 回执按这次实际 yaw 解析朝向；eye 不可用时朝向未知，不伪造北向。
    const eye = adapter.eye();
    const facing = eye ? facingOfYaw(eye.yaw) : null;
    // 适配器异常不等于没有垫高：先读世界状态，再决定是成功、部分效果还是失败。
    let r: Awaited<ReturnType<NonNullable<SkillCtx['adapter']['pillarUp']>>> | undefined;
    let adapterError: string | undefined;
    try {
      r = await adapter.pillarUp(names, ctx.signal);
    } catch (e) {
      if (isAbort(e)) throw e;
      adapterError = (e as Error).message;
    }
    const consumption = consumptionReceipt(adapter, names, beforeCount, { pendingWhenZero: true });
    const consumed = consumption.consumed;
    const inventory = {
      items: [...names], before: consumption.before, after: consumption.after, consumed,
      inventoryDelta: consumption.inventoryDelta, inventorySync: consumption.inventorySync,
      verified: consumption.consumptionVerified, ...(consumption.consumptionPending ? { pending: true } : {}),
    };
    const end = feetCell(adapter.state().pos);
    const support = inspectSupport(at, feet);
    const supportName = support.top !== null ? support.state?.name ?? null : null;
    const rose = end.y - feet.y;
    const worldConfirmed = rose === 1 && supportName !== null;
    const adapterReason = r && !r.ok ? String(r.reason ?? '未知原因') : undefined;
    if (!worldConfirmed && (adapterError !== undefined || adapterReason !== undefined)) {
      const reason = adapterError ?? adapterReason!;
      const code = adapterError ? codeFromError(new Error(adapterError))
        : adapterReason === 'NO_ITEM' ? 'MISSING_MATERIALS'
          : adapterReason === 'NO_REFERENCE' ? 'PATH_NOT_FOUND'
            : adapterReason === 'OCCUPIED' || String(adapterReason).startsWith('BLOCKED:') ? 'PATH_NOT_FOUND'
              : 'EFFECT_NOT_CONFIRMED';
      const blocked = String(adapterReason ?? adapterError).startsWith('BLOCKED:') || adapterReason === 'NO_REFERENCE';
      // 脚下这格被无碰撞但不可替换的东西占着（树苗、花、火把、铁轨…）：游戏不让把方块放进去，说清缺口。
      const occupant = adapterReason?.startsWith('BLOCKED:') ? adapterReason.slice('BLOCKED:'.length) : undefined;
      const occupied = occupant === undefined ? ''
        : `；身体所在这格 (${feet.x},${feet.y},${feet.z}) 有 ${occupant} 占着，方块放不进去，要垫高得先把它挖掉（本动作没有授予挖掘）`;
      return fail(code, `原地垫高没成：${reason}${occupied}${r?.clearanceDetail ? `；${r.clearanceDetail}` : ''}`, {
        pillarFailure: adapterReason ?? 'ADAPTER_ERROR', facing, consumed, inventory,
        ...(adapterError ? { adapterError } : {}),
        ...(r?.clearance ? { failureCause: 'PILLAR_CLEARANCE', pillarClearance: r.clearance } : {}),
        climbed: rose,
        ...problemOf(blocked ? 'HEAD_BLOCKED' : adapterError ? 'ADAPTER_ERROR' : 'PILLAR_FAILED', adapterError ? 'reconciliation' : 'execution'),
        ...effectUnconfirmed('movement', rose !== 0),
        ...after(ctx, facing),
      });
    }
    if (!worldConfirmed) {
      const problems = [
        ...(rose === 1 ? [] : [`脚高 ${feet.y} → ${end.y}，不是正好 +1`]),
        ...(supportName !== null ? [] : [`脚下 (${feet.x},${feet.y},${feet.z}) 没有实测的可站立支撑${support.state ? `（${support.state.name}）` : '（未加载）'}`]),
      ];
      return fail('EFFECT_NOT_CONFIRMED', `没有确认垫高一格：${problems.join('；')}`, {
        climbed: rose, facing, consumed, inventory,
        ...(supportName !== null ? { support: { pos: { ...feet }, name: supportName } } : {}),
        ...problemOf(supportName === null ? 'SUPPORT_NOT_CONFIRMED' : 'PILLAR_HEIGHT_MISMATCH', 'verification'),
        ...effectUnconfirmed('movement', rose !== 0),
        ...after(ctx, facing),
      });
    }
    // 材料必须对应：原脚格的实际支撑要来自本次允许的 names，不能被别的方块冒充 +1。
    if (!names.includes(supportName!)) {
      return fail('EFFECT_NOT_CONFIRMED', `没有确认垫的是 ${names.join('/')}：原脚格 (${feet.x},${feet.y},${feet.z}) 的实测支撑是 ${supportName}，不在本次可用材料内`, {
        climbed: rose, facing, materials: [...names], support: { pos: { ...feet }, name: supportName! }, consumed, inventory,
        ...problemOf('EFFECT_MISMATCH', 'verification'), ...effectUnconfirmed('movement', true), ...after(ctx, facing),
      });
    }
    // 已确认脚高正好 +1 且脚下是实测可站立支撑：垫脚块就在原脚的格子。
    markSelfModified(ctx.spatial, dim, feet, ctx.taskId);
    return ok(`原地垫了一块，站高了一格（现在 y=${end.y}）${adapterError ? `（适配器回执异常：${adapterError}；已核对世界状态）` : ''}；${consumptionText(consumption)}`, {
      climbed: 1, facing, support: { pos: { ...feet }, name: supportName }, consumed, inventory,
      ...(adapterReason ? { adapterReason } : {}), ...(adapterError ? { adapterError, reconciled: true } : {}),
      ...effectConfirmed('movement'), ...after(ctx, facing),
    });
  },
};


/** any 没有可用材料时的缺口说明：any 的范围，以及背包里另有、但 any 不会动用的方块（要用由 Agent 写明）。 */
function anyShortfall(adapter: { resolveBlockNames(query: string): string[] }, inv: { name: string; count: number }[]) {
  const others = inv.filter((i) => i.count > 0 && !PLACEABLE.includes(i.name) && adapter.resolveBlockNames(i.name).includes(i.name));
  return `any 能用的方块（${PLACEABLE_DOC}）${others.length ? `；背包里另有 ${others.slice(0, 6).map((i) => `${i.name}×${i.count}`).join('、')} 可以放置，any 不会用它们，要用就写方块名` : ''}`;
}
export const moveStep = withExecutionLink(moveStepSkill);
export const mineCell = withExecutionLink(mineCellSkill);
export const placeCell = withExecutionLink(placeCellSkill);
export const placeSupport = withExecutionLink(placeSupportSkill);
export const pillarOne = withExecutionLink(pillarOneSkill);

export const l1Primitives = [moveStep, mineCell, placeCell, placeSupport, pillarOne];
