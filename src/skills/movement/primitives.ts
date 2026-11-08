import type { PlacementFaceAttempt, Vec3Like } from '../../adapter/types.ts';
import { facingOfYaw, feetCell, supportCell, toWorld, type Facing } from '../../perception/local.ts';
import { blockCollidesBody, bodyBoxAt, bodyCells, estimatedFallDamage, footSurfaceY, isReplaceable, supportCellsUnderBody, supportTop } from '../../perception/geometry.ts';
import { isSoftBlock, LIQUID_BLOCKS } from '../../perception/surroundings.ts';
import { sleep, throwIfAborted } from '../../util.ts';
import { breakCell, why } from '../body.ts';
import { classifyBlock, MAN_MADE_NOTE, OWN_BUILDING_HINT, ownBuildingAt, storedChestAt } from '../build.ts';
import { noteEdit } from '../../mind/edits.ts';
import { markSelfModified } from '../../spatial/shared-session.ts';
import { PLACEABLE } from '../survival.ts';
import { isStation, rememberStation } from '../stations.ts';
import { codeFromError, fail, isAbort, obj, ok, type Skill, type SkillCtx } from '../types.ts';
import { absValue, after, facingArg, parseRel, relValue, toRel, visibleCells, visibleStates, type Rel } from './coordinates.ts';

const AIR = new Set(['air', 'cave_air', 'void_air']);
const KEEPSAKE = /_bed$|^(crafting_table|furnace|smoker|blast_furnace|chest|barrel|anvil|jukebox|ender_chest|enchanting_table|brewing_stand|cartography_table|smithing_table|loom|stonecutter|grindstone)$|_door$|shulker_box$/;
/** 会落成悬空顶面的火把变体（place_cell 核对实际方块名时用）。 */
const WALL_TORCH: Record<string, string> = { torch: 'wall_torch', soul_torch: 'soul_wall_torch', redstone_torch: 'redstone_wall_torch' };
/**
 * 挖掉脚下支撑块时，未经 fall:true 允许的最大落差。
 * 1 格是 move_step 明确接受的同一级落差；2 格以上必须由调用者显式接受风险。
 */
const SAFE_UNCONSENTED_SUPPORT_DROP = 1;

interface CellArgs { at: Rel; facing: Facing; xyz?: Vec3Like }
interface OriginSnapshot { pos: Vec3Like; feet: Vec3Like; worldId: string; sessionId: string; dim: string }
interface MoveArgs extends CellArgs { origin?: OriginSnapshot }
interface MineArgs extends CellArgs { own?: boolean; wet?: boolean; lava?: boolean; fall?: boolean; tool?: string }
interface PlaceArgs extends CellArgs { item: string }
interface SupportArgs extends CellArgs { item: string }
type PlaceAttempt = {
  stance: string; position: Vec3Like; endPosition?: Vec3Like; ok?: true; reason?: string; detail?: string;
  attemptedFaces?: PlacementFaceAttempt[]; reconciled?: boolean;
  problem?: { kind: string };
  effect?: 'support' | 'unchanged' | 'changed_without_support' | 'unknown' | 'not_attempted';
};
type ProblemPhase = 'validation' | 'precondition' | 'execution' | 'verification' | 'reconciliation';
type EffectKind = 'movement' | 'block_removed' | 'block_placed' | 'support_formed';

/** 结构化失败原因；failureCode 仍保留给旧调用方，problem.kind 供 Agent 区分下一步。 */
function problemOf(kind: string, phase: ProblemPhase, retryable = false) {
  return { problem: { kind, phase, retryable } };
}

/** 横向统一的效果字段：动作是否确认、属于哪类身体/世界变化。 */
const effectConfirmed = (kind: EffectKind) => ({ effect: { confirmed: true, kind } });
const effectUnconfirmed = (kind: EffectKind, partial = false) => ({ effect: { confirmed: false, kind, ...(partial ? { partial: true } : {}) } });

/** 适配器 reason 是字符串；这里只映射成稳定类别，供回执和重试决策使用。 */
function placementProblem(reason?: string): string {
  const r = String(reason ?? '');
  if (/NO_ITEM/.test(r)) return 'MISSING_MATERIAL';
  if (/FACE_NOT_CLICKABLE|OUT_OF_REACH|NO_LINE_OF_SIGHT/.test(r)) return 'REFERENCE_UNREACHABLE';
  if (/NO_REFERENCE|NO_PLACEMENT_FACE|NO_WALL|NO_FLOOR_OR_WALL/.test(r)) return 'NO_REFERENCE';
  if (/^EDGE_NO_REFERENCE|^EDGE_LOST_SUPPORT/.test(r)) return 'EDGE_NO_REFERENCE';
  if (/^EDGE_NOT_REACHED/.test(r)) return 'EDGE_NOT_REACHED';
  if (/^EDGE_HEIGHT/.test(r)) return 'EDGE_HEIGHT';
  if (/^EDGE_/.test(r)) return 'EDGE_ERROR';
  if (/adapter_error|TIMEOUT/i.test(r)) return 'EXECUTION_TIMEOUT';
  if (/NOT_PLACED|PLACE_FAILED|TARGET_CHANGED/.test(r)) return 'NOT_PLACED';
  return 'PLACEMENT_FAILED';
}

/** 参照面/站位类失败：最终回执用它区分“缺参照/站位”和其他能力缺口。 */
const REFERENCE_PROBLEMS = new Set(['NO_REFERENCE', 'REFERENCE_UNREACHABLE', 'EDGE_NO_REFERENCE', 'EDGE_NOT_REACHED', 'EDGE_HEIGHT', 'EDGE_ERROR']);

/** 当前已加载方块的几何状态；只用于碰撞/支撑判断，不用于给方块起名。 */
function stateAt(adapter: SkillCtx['adapter'], p: Vec3Like) {
  const name = adapter.blockAt(p);
  return name === null ? null : { name, properties: adapter.blockStateAt?.(p)?.properties ?? {} };
}

function bodyProblem(adapter: SkillCtx['adapter'], footY: number, cx: number, cz: number) {
  const body = bodyBoxAt(footY, cx, cz);
  for (const cell of bodyCells(footY, cx, cz)) {
    const o = stateAt(adapter, cell);
    if (o && blockCollidesBody(o.name, o.properties, cell, body)) return { cell, name: o.name };
  }
  return null;
}

/**
 * 这一列在目标脚格之外，最近的可站立面；只作为失败事实返回，不自动改落点。
 * target 必须是方块格；fromFoot 是调用者请求的脚高（可为小数），落差按它计算，
 * 不能拿目标格的整数 y 冒充绝对 xyz 的分脚脚高。
 */
function landingBelow(adapter: SkillCtx['adapter'], target: Vec3Like, fromFoot: number, maxDepth = 16) {
  for (let d = 1; d <= maxDepth; d++) {
    const cell = { x: target.x, y: target.y - d, z: target.z };
    const foot = footSurfaceY(cell, (p) => stateAt(adapter, p));
    if (foot !== null) return { cell, foot, drop: fromFoot - foot };
  }
  return null;
}

/** 目标相对当前脚位的方向；用于把 2+ 格高差交给 excavate_run，不替 Agent 决定挖不挖。 */
function stairHandoff(feet: Vec3Like, target: Vec3Like, delta: number): { mode: 'stairs' | 'stairs_up'; direction: 'north' | 'east' | 'south' | 'west'; steps: number } {
  const dx = target.x - feet.x, dz = target.z - feet.z;
  const direction = Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : (dz > 0 ? 'south' : 'north');
  return { mode: delta > 0 ? 'stairs_up' : 'stairs', direction, steps: Math.max(1, Math.min(8, Math.ceil(Math.abs(delta)))) };
}

function stairHint(stair: ReturnType<typeof stairHandoff>): string {
  return `这是 ${stair.steps} 格高差，move_step 不处理；可朝 ${stair.direction} 用 excavate_run {"mode":"${stair.mode}","direction":"${stair.direction}","steps":${stair.steps}} 开挖阶梯，或 ${stair.mode === 'stairs_up' ? 'place_support/pillar_one 补一级' : 'assess_landings 选相邻落点后用 descend_to'}（由你决定）`;
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
 * 只执行调用者明确指定的落点：不向下扫描并把“更低的落点”当成落点，不自动补支撑。
 */
export const moveStep: Skill<MoveArgs> = {
  name: 'move_step',
  description: '站到身边相邻的一格（[前,上,右] 或 xyz）。同层要求目标格脚高与当前脚高一致；上一级可高 0.5–1 格（含半砖，向上半格用 [1,1,0]，会跳）；下一级按目标格支撑顶面可低 0.5–1 格；脚下是梯子时 [0,1,0] 沿梯子爬一格。落点按实际碰撞顶面计算（半砖、雪层、地毯可为分数脚高）。目标脚高不符、下方是空腔或落差超过 1 格时如实返回支撑格和落差，不自动改落点；补支撑用 place_support，更大落差用 descend_to。在岩浆/水里或乘骑时不做普通迈步。',
  argsDoc: '{"to":[前,上,右], "facing"?:"N|E|S|W"} 或 {"xyz":[x,y,z]"}（xyz 的 x/z 是整数方块列，只有 y 是目标脚高、可为分数，例如半砖 {"xyz":[1,63.5,0]}；前后/左右 ±1，上下 -1..1；[1,0,0] 同层（脚高须一致），[1,1,0] 上一级高 0.5–1 格（含半砖），[1,-1,0] 下一级支撑顶面低 0.5–1 格；同列 [0,1,0] 只在梯子上可爬）',
  timeoutMs: 8000,
  movement: true,
  validate(raw, adapter) {
    const a = obj(raw);
    const xyz = a.xyz ?? a.abs ?? a.world;
    const facing = facingArg(a.facing, adapter);
    if (typeof facing !== 'string' || !['N', 'E', 'S', 'W'].includes(facing)) return { ok: false, error: String(facing) };
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
      return { ok: true, args: { at: [dx, p.y - feet.y, dz] as Rel, facing: facing as Facing, xyz: p, origin } };
    }
    const to = parseRel(relValue(a), { f: 1, u: [-1, 1], r: 1 });
    if (typeof to === 'string') return { ok: false, error: to };
    if (to[0] === 0 && to[2] === 0) {
      if (!(to[1] === 1 && adapter.blockAt(feet) === 'ladder')) {
        return { ok: false, error: '原地上下不是 move_step：往上只有脚下有梯子才能爬；要原地垫高用 pillar_one，要迈上台阶用 [1,1,0]' };
      }
    }
    return { ok: true, args: { at: to, facing: facing as Facing, origin } };
  },
  async run(ctx, args) {
    throwIfAborted(ctx.signal);
    const adapter = ctx.adapter;
    const s0 = adapter.state();
    if (!s0.onGround && !s0.inWater && !s0.inLava && !s0.riding && adapter.blockAt(feetCell(s0.pos)) !== 'ladder') {
      const settleBy = Math.min(ctx.deadline, Date.now() + 800);
      while (!adapter.state().onGround && Date.now() < settleBy) {
        throwIfAborted(ctx.signal);
        await sleep(50, ctx.signal);
      }
    }
    // 一次快照解析起点：连续位置、脚格、会话都从这里取，run 内不再各自推导。
    const startState = adapter.state();
    const startPos = { ...startState.pos };
    const feet = { ...feetCell(startPos) };
    const startChanged = args.origin !== undefined && (
      args.origin.feet.x !== feet.x || args.origin.feet.y !== feet.y || args.origin.feet.z !== feet.z
      || args.origin.worldId !== startState.worldId || args.origin.sessionId !== startState.sessionId || args.origin.dim !== startState.dim
    );
    if (startChanged) {
      return fail('BAD_ARGS', '没有执行迈步：计划检查后起点已经变化（脚下格、维度或会话不同），旧计划不再成立', {
        origin: { ...args.origin!.pos }, originFeet: { ...args.origin!.feet }, currentFeet: { ...feet },
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
      const blocker = bodyProblem(adapter, ladderFoot, target.x, target.z);
      if (blocker) {
        const digRel = toRel(feet, args.facing, blocker.cell);
        return fail('PATH_NOT_FOUND', `梯子往上爬不动：头顶上方是 ${blocker.name}（先 mine_cell [${digRel}]）`, { ...partial(), remediation: { dig: digRel, reason: 'ladder-head' }, ...problemOf('HEAD_BLOCKED', 'precondition'), ...effectUnconfirmed('movement'), ...after(ctx, args.facing, target) });
      }
      try {
        await adapter.moveTo({ kind: 'xyz', x: target.x, y: ladderFoot, z: target.z }, { signal: ctx.signal, timeoutMs: Math.max(1000, Math.min(6000, ctx.deadline - Date.now())), allowTerrainChanges: false });
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
    const direct = footSurfaceY(target, (p) => stateAt(adapter, p));
    const absolute = args.xyz !== undefined;
    const baseFoot = startPos.y;
    const wanted = absolute ? targetFoot! : baseFoot + rel[1];
    /** 实际支撑与当前脚高的单格关系；null 表示超出 ±1，move_step 不处理。 */
    const verticalStep = (delta: number): -1 | 0 | 1 | null =>
      Math.abs(delta) <= 0.01 ? 0
        : delta >= 0.49 && delta <= 1.01 ? 1
          : delta >= -1.01 && delta <= -0.49 ? -1 : null;
    if (direct === null) {
      const below = landingBelow(adapter, target, wanted);
      const facts = below
        ? { landing: { x: target.x, y: below.foot, z: target.z, drop: below.drop }, support: { ...target, y: target.y - 1 } }
        : { support: { ...target, y: target.y - 1 } };
      // 目标脚格没有支撑时，用“最近的同列可站立面相对当前脚高”判断它属于同层还是 ±1；
      // u 是目标格相对脚格的竖直偏移，不能直接按“下方第几格”硬套（半砖会让脚高与格偏移不一致）。
      const correctedU = below === null ? null : verticalStep(below.foot - baseFoot);
      const stair = below !== null && Math.abs(below.foot - baseFoot) > 1.01
        ? stairHandoff(feet, target, below.foot - baseFoot) : null;
      const dropRemediation = correctedU === null && below !== null && below.drop > 1.01
        ? { assess: true as const, landing: { x: target.x, y: below.foot, z: target.z }, drop: below.drop,
            descend: { target: { x: target.x, y: below.foot, z: target.z } } }
        : null;
      const remediation = correctedU !== null
        ? absolute
          ? { xyz: { x: target.x, y: below!.foot, z: target.z } }
          : { at: [rel[0], correctedU, rel[2]] as Rel }
        : dropRemediation
          ? { ...dropRemediation, ...(stair ? { stairs: stair } : {}) }
          : stair ? { stairs: stair } : null;
      const correction = (correctedU === null
        ? below
          ? `同列下方 ${below.drop.toFixed(2)} 格才有可站立脚面 y=${below.foot.toFixed(2)}，与当前脚高相差 ${Math.abs(below.foot - baseFoot).toFixed(2)} 格，不符合 move_step 的同层/±1 规则；要下去先用 assess_landings 确认落点，再 descend_to（move_step 不处理 >1 落差），或补支撑后按同层走`
          : '同列下方没有找到可站立面；要补支撑用 place_support 目标脚下方那一格'
        : absolute
          ? `同一列可站立脚高是 y=${below!.foot.toFixed(2)}；把 y 写成 ${below!.foot.toFixed(2)}`
          : `同一相邻格的正确写法是 [${rel[0]},${correctedU},${rel[2]}]（仍锁定这一格，不自动改目标）`) + (stair ? `；${stairHint(stair)}` : '');
      const problemKind = below === null ? 'NO_SUPPORT'
        : correctedU !== null ? 'FOOT_HEIGHT_MISMATCH'
          : Math.abs(below.foot - baseFoot) > 1.01 ? 'UNSUPPORTED_STEP_HEIGHT' : 'FOOT_HEIGHT_MISMATCH';
      return fail(correctedU === null ? 'PATH_NOT_FOUND' : 'BAD_ARGS', `没有执行迈步：目标格 (${target.x},${target.y},${target.z}) 在当前脚高 ${wanted.toFixed(2)} 没有可站立面；${correction}`, { ...facts, movementNotAttempted: true, ...(remediation ? { remediation } : {}), ...problemOf(problemKind, 'precondition'), ...after(ctx, args.facing, target) });
    }
    // 绝对 xyz 的 y 是调用者指定的脚高：支撑面必须与它一致，不能悄悄改成实际支撑面。
    if (absolute && Math.abs(direct - targetFoot!) > 0.01) {
      const stair = Math.abs(direct - baseFoot) > 1.01 ? stairHandoff(feet, target, direct - baseFoot) : null;
      return fail('BAD_ARGS', `没有执行迈步：目标格 (${target.x},${target.y},${target.z}) 的支撑面在 y=${direct.toFixed(2)}，与绝对脚高 ${targetFoot!.toFixed(2)} 不符；若要到这一格，把 y 写成 ${direct.toFixed(2)}。未执行迈步${stair ? `；${stairHint(stair)}` : ''}`, { targetCell: target, expectedFoot: targetFoot, actualSupport: direct, movementNotAttempted: true, remediation: { xyz: { x: target.x, y: direct, z: target.z }, ...(stair ? { stairs: stair } : {}) }, ...problemOf('FOOT_HEIGHT_MISMATCH', 'precondition'), ...after(ctx, args.facing, target) });
    }
    if (!absolute) {
      const delta = direct - baseFoot;
      const corrected = verticalStep(delta);
      const correctedAt = corrected === null ? null : [rel[0], corrected, rel[2]] as Rel;
      // >1 格的落差不是 move_step 能处理的；给出“先 assess_landings 再 descend_to”的结构化交接。
      const stair = Math.abs(delta) > 1.01 ? stairHandoff(feet, target, delta) : null;
      const dropBelow = correctedAt === null ? landingBelow(adapter, target, wanted) : null;
      const dropRemediation = dropBelow && dropBelow.drop > 1.01
        ? { assess: true as const, landing: { x: target.x, y: dropBelow.foot, z: target.z }, drop: dropBelow.drop,
            descend: { target: { x: target.x, y: dropBelow.foot, z: target.z } } }
        : null;
      const fix = correctedAt ? { at: correctedAt }
        : dropRemediation ? { ...dropRemediation, ...(stair ? { stairs: stair } : {}) }
          : stair ? { stairs: stair } : null;
      // 预检失败也要给出同一相邻格的准确写法；不自动重放，由心智决定是否改用这个落点。
      const correction = (correctedAt === null
        ? Math.abs(delta) < 0.49
          ? `实际高差 ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} 格，不足半格，不能算同层或上下级`
          : `实际落差 ${Math.abs(delta).toFixed(2)} 格，超出 move_step 的 ±1 范围${dropRemediation ? '；要下去先用 assess_landings 确认落点，再 descend_to' : ''}`
        : `同一相邻格的正确写法是 [${correctedAt.join(',')}]（仍锁定这一格，不自动改目标）`) + (stair ? `；${stairHint(stair)}` : '');
      if (rel[1] === 0 && Math.abs(delta) > 0.01) {
        return fail('BAD_ARGS', `没有执行迈步：目标格的实际脚高是 y=${direct.toFixed(2)}，不是同层 y=${baseFoot.toFixed(2)}；${correction}`, { actualFoot: direct, expectedFoot: baseFoot, movementNotAttempted: true, ...(fix ? { remediation: fix } : {}), ...problemOf('FOOT_HEIGHT_MISMATCH', 'precondition'), ...after(ctx, args.facing, target) });
      }
      if (rel[1] === -1 && (direct > baseFoot - 0.5 + 0.01 || direct < baseFoot - 1 - 0.01)) {
        const hint = correctedAt === null
          ? `落点不符；${dropRemediation ? '先 assess_landings 确认落点，再 descend_to' : '先用 place_support 补支撑或换落点'}${stair ? `；${stairHint(stair)}` : ''}`
          : correction;
        return fail('BAD_ARGS', `没有执行迈步：下一级目标格的实际脚高是 y=${direct.toFixed(2)}，不在当前脚高下方 0.5–1 格内；${hint}`, { actualFoot: direct, expectedFoot: wanted, movementNotAttempted: true, ...(fix ? { remediation: fix } : {}), ...problemOf(Math.abs(delta) > 1.01 ? 'UNSUPPORTED_STEP_HEIGHT' : 'FOOT_HEIGHT_MISMATCH', 'precondition'), ...after(ctx, args.facing, target) });
      }
      if (rel[1] === 1 && (direct < baseFoot + 0.5 - 0.01 || direct > baseFoot + 1 + 0.01)) {
        return fail('BAD_ARGS', `没有执行迈步：目标格没有高半格以上、且不超过 1 格的可站立面（实际脚高 y=${direct.toFixed(2)}，当前 y=${baseFoot.toFixed(2)}）；${correction}`, { actualFoot: direct, expectedFoot: wanted, movementNotAttempted: true, ...(fix ? { remediation: fix } : {}), ...problemOf(Math.abs(delta) > 1.01 ? 'UNSUPPORTED_STEP_HEIGHT' : 'FOOT_HEIGHT_MISMATCH', 'precondition'), ...after(ctx, args.facing, target) });
      }
    }
    const targetY = absolute ? targetFoot! : direct;
    if (targetY > baseFoot + 0.5) {
      const jump = bodyProblem(adapter, targetY, feet.x, feet.z);
      if (jump) {
        const digRel = toRel(feet, args.facing, jump.cell);
        return fail('PATH_NOT_FOUND', `没有执行迈步：往上迈时自己头顶/起跳路径上是 ${jump.name}（先 mine_cell [${digRel}]）`, {
          targetCell: target, movementNotAttempted: true, remediation: { dig: digRel, reason: 'jump-head' }, ...problemOf('HEAD_BLOCKED', 'precondition'), ...effectUnconfirmed('movement'), ...after(ctx, args.facing, target),
        });
      }
    }
    const blocker = bodyProblem(adapter, targetY, target.x, target.z);
    if (blocker) {
      const digRel = toRel(feet, args.facing, blocker.cell);
      const atTarget = blocker.cell.y === target.y;
      return fail('PATH_NOT_FOUND', `没有执行迈步：${atTarget ? '目标格' : '目标格上方'}是 ${blocker.name}（先 mine_cell [${digRel}]）`, {
        problems: [`${atTarget ? '目标格' : '目标格上方'}是 ${blocker.name}`], targetCell: target,
        movementNotAttempted: true, remediation: { dig: digRel, reason: atTarget ? 'feet' : 'head' }, ...problemOf(atTarget ? 'TARGET_BLOCKED' : 'HEAD_BLOCKED', 'precondition'), ...effectUnconfirmed('movement'), ...after(ctx, args.facing, target),
      });
    }
    try {
      await adapter.moveTo({ kind: 'xyz', x: target.x, y: targetY, z: target.z }, { signal: ctx.signal, timeoutMs: Math.max(1000, Math.min(6000, ctx.deadline - Date.now())), allowTerrainChanges: false, adjacentStep: true });
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
    return ok(`站到了 [${rel}]（脚高 y=${targetY.toFixed(2)}）${drop > 0 ? `，下落 ${drop.toFixed(2)} 格` : ''}${damage ? `（预计约 ${damage} 点摔伤）` : ''}`, {
      moved: [...rel], targetFoot: targetY, ...effectConfirmed('movement'),
      ...(drop > 0 ? { drop, fall: { drop, damage } } : {}), ...after(ctx, args.facing, target),
    });
  },
};

/** 挖掉确切的一格。用户明确指定目标、可接受的风险和工具；代码只执行并核对。 */
export const mineCell: Skill<MineArgs> = {
  name: 'mine_cell',
  description: '挖掉身边指定的一格（[前,上,右] 或 xyz）。相对坐标 [0,-1,0] 指脚部支撑格（站半砖/床/雪层时就是脚所在那一格，脚高可为分数），不是脚的整数格下方一格。目标不在视野先转头看，仍看不见返回未知，不挖别处。只用 tool 指定的工具；没写 tool 时只用当前手持（空手就空手挖），不自动换更合适的、也不自动造工具。指定 tool 不在背包返回 TOOL_MISSING；不掉落也照挖并回报 noDrop，换工具先 hold_item。没指定时按适配器真实规则返回 noDrop、超时等事实。液体邻格默认不挖；wet/lava 显式接受进水/进岩浆。挖脚下支撑块时，下方 1 格是实心落点可直接挖；2–3 格落差或落点未知要 fall:true，落点是水/岩浆还要 wet:true/lava:true。挖掉脚下支撑后会等落地（有界）并回报 onGround、AABB 下剩余支撑格和实际落差；仍在空中时标 pendingFall，不会把目标格已空当作已落地。只挖不走，不挖基岩。',
  argsDoc: '{"at":[前,上,右], "facing"?:"N|E|S|W", "tool"?:"物品注册名（只用这一把；不掉落也挖并报 noDrop）", "wet"?true, "lava"?true, "fall"?true} 或 {"xyz":[x,y,z], "facing"?:"N|E|S|W", "tool"?:"物品注册名", "wet"?true, "lava"?true, "fall"?true}（前后/左右 ±2，上下 -1..3；[0,-1,0] 是脚部支撑格）',
  timeoutMs: 30000,
  movement: false,
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
      const rel = parseRel(toRel(feetCell(adapter.state().pos), facing as Facing, xyz), { f: 2, u: [-1, 3], r: 2 });
      if (typeof rel === 'string') return { ok: false, error: `(${xyz.x},${xyz.y},${xyz.z}) 不在身边能挖到的范围：${rel}；先走近` };
      return { ok: true, args: { at: rel, facing: facing as Facing, xyz, ...(tool !== undefined ? { tool } : {}), ...(a.own === true ? { own: true } : {}), ...(a.wet === true ? { wet: true } : {}), ...(a.lava === true ? { lava: true } : {}), ...(a.fall === true ? { fall: true } : {}) } };
    }
    const at = parseRel(relValue(a), { f: 2, u: [-1, 3], r: 2 });
    if (typeof at === 'string') return { ok: false, error: at };
    return { ok: true, args: { at, facing: facing as Facing, ...(tool !== undefined ? { tool } : {}), ...(a.own === true ? { own: true } : {}), ...(a.wet === true ? { wet: true } : {}), ...(a.lava === true ? { lava: true } : {}), ...(a.fall === true ? { fall: true } : {}) } };
  },
  async run(ctx, args) {
    throwIfAborted(ctx.signal);
    const adapter = ctx.adapter;
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
    if (loaded === null) return fail('NOT_FOUND', `[${args.at}] 那一格还没加载（区块没载入），看不见也没法挖`, { ...after(ctx, args.facing, pos), noop: true, obscured: true, ...problemOf('TARGET_STATE_UNKNOWN', 'precondition'), ...effectUnconfirmed('block_removed') });
    if (ownCell && AIR.has(loaded)) return ok(`[${args.at}] 是自己站的格子，本来就空着，别挖这里`, { ...after(ctx, args.facing, pos), noop: true, ...effectConfirmed('block_removed') });
    const key = `${pos.x},${pos.y},${pos.z}`;
    let seenBefore: string | undefined = ownCell ? loaded : visibleCells(ctx, [pos]).get(key);
    if (!seenBefore && !ownCell && ctx.senses.observeBlocks) {
      ctx.senses.refresh();
      const eye = adapter.eye();
      if (eye) {
        const dx = pos.x + 0.5 - eye.x, dy = pos.y + 0.5 - eye.y, dz = pos.z + 0.5 - eye.z;
        try { await adapter.look(Math.atan2(-dx, -dz), Math.atan2(dy, Math.max(0.3, Math.hypot(dx, dz))), ctx.signal); } catch (e) { if (isAbort(e)) throw e; }
        await sleep(160, ctx.signal);
        seenBefore = visibleCells(ctx, [pos]).get(key);
      }
    }
    if (!seenBefore) {
      return fail('NOT_FOUND', `[${args.at}] 没有发生挖掘：目标格 (${pos.x},${pos.y},${pos.z}) 状态未确认（视野外/被遮挡/未加载），不把未看见当作空气；换个站位或先挖掉挡着的那一格`, { ...after(ctx, args.facing, pos), targetCell: { ...pos }, target: { ...pos }, noop: true, obscured: true, unknown: true, ...problemOf('TARGET_NOT_OBSERVED', 'precondition'), ...effectUnconfirmed('block_removed') });
    }
    const before = seenBefore;
    if (AIR.has(before)) {
      // 目标已空时也要说清身体有没有掉：只回“本来就是空的”会让 Agent 反复挖同一格找原因。
      const state = adapter.state();
      const supports = digsSupport ? supportCellsUnderBody(state.pos, (p) => stateAt(adapter, p)) : [];
      const supportText = supports.slice(0, 3).map((s) => `${s.name}(${s.pos.x},${s.pos.y},${s.pos.z})`).join('、');
      const bodyText = digsSupport
        ? `；身体在 y=${state.pos.y.toFixed(2)}，${state.onGround ? '已触地' : '未触地'}${supports.length ? `，脚下还有 ${supportText} 托着` : ''}`
        : '';
      return ok(`[${args.at}] 本来就是空的，不用挖${bodyText}`, {
        cell: [...args.at], was: 'air', ...effectConfirmed('block_removed'),
        ...(digsSupport ? { onGround: state.onGround, supports } : {}),
        ...after(ctx, args.facing, pos), noop: true,
      });
    }
    if (LIQUID_BLOCKS.has(before)) return fail('BAD_ARGS', `[${args.at}] 是 ${before}，挖不了`, { ...after(ctx, args.facing, pos), ...problemOf('TARGET_LIQUID', 'precondition'), ...effectUnconfirmed('block_removed') });
    const neighborPositions = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]]
      .map(([dx, dy, dz]) => ({ x: pos.x + dx, y: pos.y + dy, z: pos.z + dz }));
    const seenNeighbors = visibleCells(ctx, neighborPositions);
    // 未知邻格不当作空气或安全：单独列出，让 Agent 自己决定要不要再看一眼。
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
    type FallFacts = {
      below: string | null; drop: number | null; fallRisk: string;
      requiresFall: boolean; requiresLiquid?: 'water' | 'lava';
    };
    let fallFacts: FallFacts | undefined;
    if (digsSupport) {
      // 只按本次实际观察评估脚下落差；未看清的格子不能借 adapter.blockAt 补全。
      const belowPositions = [1, 2, 3].map((d) => ({ x: pos.x, y: pos.y - d, z: pos.z }));
      const seenBelow = visibleCells(ctx, belowPositions);
      let drop = 0, landing: string | null = null, unknown = false;
      for (const [i, p] of belowPositions.entries()) {
        const name = seenBelow.get(`${p.x},${p.y},${p.z}`);
        if (name === undefined) { unknown = true; break; }
        if (LIQUID_BLOCKS.has(name)) { landing = name; drop = i + 1; break; }
        if (!AIR.has(name) && !isSoftBlock(name)) { landing = name; drop = i + 1; break; }
      }
      const isLiquid = landing !== null && LIQUID_BLOCKS.has(landing);
      // 1 格落差与 move_step 的同一级单步一致；2–3 格必须显式 fall:true。
      const requiresFall = unknown || drop === 0 || drop > SAFE_UNCONSENTED_SUPPORT_DROP;
      const requiresLiquid = isLiquid ? (/lava/.test(landing!) ? 'lava' as const : 'water' as const) : undefined;
      fallFacts = {
        below: unknown ? null : landing,
        drop: unknown || drop === 0 ? null : drop,
        fallRisk: unknown ? '下方 3 格内未看清落点'
          : drop === 0 ? '下方 3 格内未见落点'
            : `下方 ${drop} 格是 ${landing}`,
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
    const countOf = (n: string) => adapter.state().inventory.filter((i) => i.name === n).reduce((a, i) => a + i.count, 0);
    const had = keepsake ? countOf(keepsake) : 0;
    // 只用调用者指定的工具；没指定就只用当前手持（空手就空手挖），不换更合适的、也不造工具。
    // info 会让 breakCell 回填适配器实测的 noDrop/digMs；成功回执照实带回，不把空手掉落写成“拿到了”。
    const digInfo: { noDrop?: boolean; ms?: number } = {};
    let adapterError: string | undefined;
    try {
      await breakCell(ctx, pos, true, digInfo, { allowWater: args.wet, allowLava: args.lava, ...(args.tool !== undefined ? { tool: args.tool } : { handOnly: true }) });
    } catch (e) {
      if (isAbort(e)) throw e;
      // 适配器异常不等于世界没变：先核对目标格，已空就按部分/已确认效果继续结算。
      const now = adapter.blockAt(pos);
      if (now === null || !AIR.has(now)) {
        const code = String((e as Error).message).startsWith('TOOL_MISSING') ? 'TOOL_MISSING' : codeFromError(e);
        return fail(code, `挖 [${args.at}] 的 ${before} 没成：${why(e)}`, {
          ...after(ctx, args.facing, pos), adapterError: why(e), now,
          ...problemOf(now === null ? 'EFFECT_UNKNOWN' : 'EFFECT_NOT_CONFIRMED', 'reconciliation'), ...effectUnconfirmed('block_removed', now === null),
        });
      }
      adapterError = why(e);
    }
    // 挖后复核：只有目标格确实是空气才算移除成功；被下落方块填回/未加载都只是事实，不记成已挖掉。
    const now = adapter.blockAt(pos);
    if (now === null || !AIR.has(now)) {
      return fail('EFFECT_NOT_CONFIRMED', `挖 [${args.at}] 的 ${before} 后，目标格仍不是空气${now === null ? '（未加载，无法确认已挖空）' : `：现在是 ${now}（可能被掉落的方块回填）`}`, {
        cell: [...args.at], was: before, now, target: { ...pos }, ...after(ctx, args.facing, pos), ...fallFacts,
        ...(adapterError ? { adapterError } : {}),
        ...problemOf(now === null ? 'EFFECT_UNKNOWN' : 'EFFECT_NOT_CONFIRMED', 'verification'), ...effectUnconfirmed('block_removed', now !== null),
      });
    }
    // 挖后复核已确认目标格是空气：这时才把这一格记成自身动作修改，失败/未确认不写。
    markSelfModified(ctx.spatial, dim, pos, ctx.taskId);
    noteEdit(ctx.taskId, 'dig', pos);
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
        supports: supportCellsUnderBody(state.pos, (p) => stateAt(adapter, p)),
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
      ...(adapterError ? { adapterError, reconciled: true } : {}),
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
export const placeCell: Skill<PlaceArgs> = {
  name: 'place_cell',
  description: '在身边指定格放一块确切材料（[前,上,右] 或 xyz）。目标格已有同名方块算完成；已有别的方块（含半砖、雪层、地毯、门、火把）如实报占用，不把错误材料当成功。只放这一格，不负责找站位、不补支撑、不原地垫高。',
  argsDoc: '{"at":[前,上,右], "item":"方块名", "facing"?:"N|E|S|W"} 或 {"xyz":[x,y,z], "item":"方块名"}（前后/左右 ±2，上下 -2..3）',
  timeoutMs: 15000,
  movement: false,
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
    const origin = adapter.state();
    const feet = feetCell(origin.pos);
    // 归因用动作开始时的维度，避免确认前后跨维度时把旧格记到新维度。
    const dim = origin.dim;
    const pos = args.xyz !== undefined ? { ...args.xyz } : toWorld(feet, args.facing, args.at);
    const key = `${pos.x},${pos.y},${pos.z}`;
    // stateAt 只判几何/占用；名称、材质说明只来自本次 visibleStates，未看清就如实写未看清。
    const raw = stateAt(adapter, pos);
    const seen = visibleStates(ctx, [pos]).get(key) ?? null;
    if (raw === null) return fail('NOT_FOUND', `[${args.at}] 目标格未加载，无法确认是否为空，没有放置`, { ...after(ctx, args.facing, pos), ...problemOf('TARGET_STATE_UNKNOWN', 'precondition'), ...effectUnconfirmed('block_placed') });
    if (!AIR.has(raw.name) && !isReplaceable(raw.name)) {
      if (seen && (seen.name === args.item || WALL_TORCH[args.item] === seen.name)) return ok(`[${args.at}] 已经有 ${seen.name} 了`, { already: seen.name, noop: true, ...effectConfirmed('block_placed'), ...after(ctx, args.facing, pos) });
      if (seen) return fail('PATH_NOT_FOUND', `[${args.at}] 已被 ${seen.name} 占据（${shapeOf(seen.name, seen.properties)}），不是要放的 ${args.item}；先 mine_cell 清掉或换一格`, { occupied: seen.name, ...problemOf('TARGET_OCCUPIED', 'precondition'), ...effectUnconfirmed('block_placed'), ...after(ctx, args.facing, pos) });
      return fail('PATH_NOT_FOUND', `[${args.at}] 已被方块占据（本次未看清是什么），无法确认是否已经是 ${args.item}；没有放置，换角度看清楚或先 mine_cell`, { occupied: null, unknown: true, ...problemOf('TARGET_STATE_UNKNOWN', 'precondition'), ...effectUnconfirmed('block_placed'), ...after(ctx, args.facing, pos) });
    }
    if (!adapter.state().inventory.some((i) => i.name === args.item && i.count > 0)) return fail('MISSING_MATERIALS', `背包里没有 ${args.item}`, { ...after(ctx, args.facing, pos), ...problemOf('MISSING_MATERIAL', 'precondition'), ...effectUnconfirmed('block_placed') });
    const countOf = () => adapter.state().inventory.filter((i) => i.name === args.item).reduce((a, i) => a + i.count, 0);
    const beforeCount = countOf();
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
    const now = stateAt(adapter, pos);
    const actual = now?.name ?? null;
    const matches = actual !== null && (actual === args.item || WALL_TORCH[args.item] === actual);
    if (now === null) {
      return fail('EFFECT_NOT_CONFIRMED', `[${args.at}] 放置后目标格未加载，无法确认实际方块`, {
        requested: args.item, attemptedFaces, ...(adapterReason ? { adapterReason } : {}), ...(adapterError ? { adapterError } : {}),
        ...problemOf('EFFECT_UNKNOWN', 'reconciliation'), ...effectUnconfirmed('block_placed', true), ...after(ctx, args.facing, pos),
      });
    }
    if (!matches) {
      const observed = visibleStates(ctx, [pos]).get(key) ?? null;
      // 目标仍是原来的空气/可替换植物：这是“没放上”，不是放成了错误材料。
      if (AIR.has(now.name) || (now.name === raw.name && isReplaceable(now.name))) {
        if (adapterReason === undefined && adapterError === undefined) {
          return fail('EFFECT_NOT_CONFIRMED', `[${args.at}] 适配器回执成功，但目标格仍是空气`, {
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
        return fail(code, `放不到 [${args.at}]：${reason}${detail ? `；${detail}` : ''}`, {
          attemptedFaces, ...(adapterReason ? { adapterReason } : {}), ...(adapterError ? { adapterError } : {}),
          ...problemOf(adapterError ? 'PLACEMENT_ADAPTER_ERROR' : 'PLACEMENT_REFUSED', 'execution'), ...effectUnconfirmed('block_placed'), ...after(ctx, args.facing, pos),
        });
      }
      return fail('EFFECT_NOT_CONFIRMED', `[${args.at}] 实际出现的是 ${now.name}，不是请求的 ${args.item}`, {
        placed: now.name, requested: args.item, observed: observed !== null, attemptedFaces,
        ...(adapterReason ? { adapterReason } : {}), ...(adapterError ? { adapterError } : {}),
        ...problemOf('EFFECT_MISMATCH', 'verification'), ...effectUnconfirmed('block_placed', true), ...after(ctx, args.facing, pos),
      });
    }
    // 以放置后的权威方块状态确认材料；可见快照只作附加证据，不作为唯一判断。
    const observed = visibleStates(ctx, [pos]).get(key) ?? null;
    const afterCount = countOf();
    const consumedRaw = beforeCount - afterCount;
    const consumed = Math.max(0, consumedRaw);
    markSelfModified(ctx.spatial, dim, pos, ctx.taskId);
    noteEdit(ctx.taskId, 'place', pos);
    if (isStation(now.name)) rememberStation(ctx, now.name, pos);
    return ok(
      `在 [${args.at}] 放了 ${now.name}${adapterError ? `（适配器回执异常：${adapterError}；已核对世界状态）` : ''}`,
      {
        placed: now.name, requested: args.item, observed: observed !== null,
        ...(adapterReason ? { adapterReason } : {}), ...(adapterError ? { adapterError, reconciled: true } : {}),
        consumed, inventory: {
          item: args.item, before: beforeCount, after: afterCount, consumed,
          verified: consumedRaw > 0, ...(consumedRaw === 0 ? { pending: true } : {}),
        },
        ...effectConfirmed('block_placed'),
        ...after(ctx, args.facing, pos),
      },
    );
  },
};

/** 形成可站立支撑；已有可站面就成功，不要求同名材料。 */
export const placeSupport: Skill<SupportArgs> = {
  name: 'place_support',
  description: '在指定格形成可站立支撑（[前,上,右] 或 xyz）。必须用 item 指定方块名或显式 "any"，不会默认替你选材料。已有可站立顶面（整块、半砖、雪层等）就算满足，不要求与 item 同名，也不再消耗材料；只有空气/可替换植物才放 item。支持脚下一格和脚下两格；当前站位看不到参照面时会后退/侧移或潜行到支撑块边缘再放。脚下两格的边缘放置需要支撑块下方那一格是同层实心参照方块；没有就如实失败，改用 descend_to 或换到能看见参照面的站位。成功回执返回 consumed=放置前后目标材料总数之差；失败回执返回每次尝试的实际站位与参照面事实。只放这一格，不换材料、不换目标，不自动清障/垫高。',
  argsDoc: '{"at":[前,上,右], "item":"方块名|any", "facing"?:"N|E|S|W"} 或 {"xyz":[x,y,z], "item":"方块名|any"}（item 必填：已知方块名或字面 any；前后/左右 ±2，上下 -2..3）',
  timeoutMs: 20000,
  movement: true,
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
    const origin = adapter.state();
    const feet = feetCell(origin.pos);
    // 归因用动作开始时的维度，避免确认前后跨维度时把旧格记到新维度。
    const dim = origin.dim;
    const pos = args.xyz !== undefined ? { ...args.xyz } : toWorld(feet, args.facing, args.at);
    const key = `${pos.x},${pos.y},${pos.z}`;
    // stateAt 只判几何/支撑；名称与材质说明只来自本次 visibleStates，未看清就如实写未看清。
    const seenAt = () => visibleStates(ctx, [pos]).get(key) ?? null;
    const raw = stateAt(adapter, pos);
    if (raw === null) return fail('NOT_FOUND', `[${args.at}] 目标格未加载，无法确认是否需要支撑`, { ...after(ctx, args.facing, pos), ...problemOf('TARGET_STATE_UNKNOWN', 'precondition'), ...effectUnconfirmed('support_formed') });
    const top = supportTop(raw.name, raw.properties);
    if (top !== null) {
      const seen = seenAt();
      return ok(
        `[${args.at}] 已经有可站立支撑${seen ? ` ${seen.name}（${shapeOf(seen.name, seen.properties)}）` : '（本次未看清名称和形状）'}，没有另放 ${args.item}`,
        { already: seen?.name ?? null, observed: seen !== null, supportTop: pos.y + top, standable: true, noop: true, consumed: 0, consumptionVerified: true, ...effectConfirmed('support_formed'), ...after(ctx, args.facing, pos) },
      );
    }
    if (!isReplaceable(raw.name)) {
      const seen = seenAt();
      return fail(
        'PATH_NOT_FOUND',
        seen
          ? `[${args.at}] 已被 ${seen.name} 占据（${shapeOf(seen.name, seen.properties)}），不是可站立支撑；先 mine_cell 清掉或换一格`
          : `[${args.at}] 已被方块占据（本次未看清是什么），不是可站立支撑；先 mine_cell 清掉或换一格`,
        { occupied: seen?.name ?? null, observed: seen !== null, ...problemOf('TARGET_OCCUPIED', 'precondition'), ...effectUnconfirmed('support_formed'), ...after(ctx, args.facing, pos) },
      );
    }
    const inv = adapter.state().inventory;
    const names = args.item === 'any' ? PLACEABLE.filter((n) => inv.some((i) => i.name === n && i.count > 0)) : [args.item];
    if (!names.length || !inv.some((i) => names.includes(i.name) && i.count > 0)) return fail('MISSING_MATERIALS', `背包里没有 ${args.item === 'any' ? '能垫的方块' : args.item}`, { ...after(ctx, args.facing, pos), ...problemOf('MISSING_MATERIAL', 'precondition'), ...effectUnconfirmed('support_formed') });
    const countOf = () => names.reduce((n, name) => n + adapter.state().inventory.filter((i) => i.name === name).reduce((sum, i) => sum + i.count, 0), 0);
    const beforeCount = countOf();
    // 库存更新可能滞后：看到净减少才算确认消耗；成功但暂时 0 消耗标为 pending，不冒充真实零消耗。
    const consumptionFacts = (effectExpected: boolean) => {
      const raw = beforeCount - countOf();
      return {
        consumed: Math.max(0, raw), consumptionVerified: raw > 0,
        ...(effectExpected && raw === 0 ? { consumptionPending: true } : {}),
      };
    };
    const attempts: PlaceAttempt[] = [];
    const movementStart = { ...origin.pos };
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
      const now = stateAt(adapter, pos);
      return {
        now,
        confirmed: now !== null && supportTop(now.name, now.properties) !== null,
        unknown: now === null,
        changed: now !== null && !isReplaceable(now.name),
      };
    };
    /** 异常/超时可能已经产生效果：短暂等待后再核对一次，但不无限重试。 */
    const waitForEffect = async (ms: number) => {
      const until = Math.min(ctx.deadline, Date.now() + ms);
      while (!readTarget().confirmed && Date.now() < until) {
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
        return fail('EFFECT_NOT_CONFIRMED', `[${args.at}] 放置后目标格未加载，无法确认是否已形成支撑；停止重试`, {
          attempts, materials: [...names], ...consumptionFacts(true), targetCell: { ...pos },
          ...movementFacts(), ...problemOf('EFFECT_UNKNOWN', 'reconciliation'), ...effectUnconfirmed('support_formed', true), ...after(ctx, args.facing, pos),
        });
      }
      const seen = seenAt();
      return fail('EFFECT_NOT_CONFIRMED', `[${args.at}] 目标格已经变成 ${seen?.name ?? '别的方块'}，但没有形成可站立支撑；停止重复放置`, {
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
      return fail('EFFECT_NOT_CONFIRMED', `[${args.at}] 适配器回执成功，但目标格仍没有形成可站立支撑；停止重试`, {
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
        return fail('EFFECT_NOT_CONFIRMED', `[${args.at}] 边缘放置回执成功，但目标格仍没有形成可站立支撑；停止重试`, {
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
        await adapter.moveTo({ kind: 'near', pos: { x: stance.pos.x + 0.5, y: origin.pos.y, z: stance.pos.z + 0.5 }, range: 0.3 }, { signal: ctx.signal, timeoutMs: Math.min(2500, ctx.deadline - Date.now()), constructionSafe: true, allowSwimming: false });
      } catch (e) {
        if (isAbort(e)) throw e;
        attemptFacts(stance.name, beforeMove, { reason: `move:${(e as Error).message}`, effect: 'not_attempted' });
        continue;
      }
      const at = { ...adapter.state().pos };
      let stanceReceiptOk = false;
      try {
        const r = await adapter.placeBlockAt(pos, names, ctx.signal);
        stanceReceiptOk = r.ok;
        outcome = reconcile(stance.name, at, {
          ...(r.ok ? {} : { reason: r.reason ?? r.detail ?? 'not placed' }),
          ...(r.detail ? { detail: r.detail } : {}),
          ...(r.attemptedFaces?.length ? { attemptedFaces: r.attemptedFaces } : {}),
          ambiguous: !r.ok,
        });
      } catch (e) {
        if (isAbort(e)) throw e;
        await waitForEffect(250);
        outcome = reconcile(stance.name, at, { reason: `adapter_error:${(e as Error).message}`, ambiguous: true });
      }
      if (outcome === 'formed') break;
      const stanceStopped = stoppedByEffect(outcome);
      if (stanceStopped) return stanceStopped;
      if (stanceReceiptOk) {
        return fail('EFFECT_NOT_CONFIRMED', `[${args.at}] 在 ${stance.name} 站位放置回执成功，但目标格仍没有形成可站立支撑；停止重试`, {
          attempts, materials: [...names], ...consumptionFacts(true), targetCell: { ...pos },
          ...movementFacts(), ...problemOf('EFFECT_NOT_CONFIRMED', 'verification'), ...effectUnconfirmed('support_formed'), ...after(ctx, args.facing, pos),
        });
      }
    }
    if (!formed) {
      // 摘要里带上适配器已经给出的参照面/站位细节；只放进 data 时心智看不到，会反复猜同一格。
      const brief = (s: string) => s.length <= 120 ? s : `${s.slice(0, 119)}…`;
      const attemptText = attempts
        .map((a) => brief(`${a.stance}:${a.reason ?? '未放置'}${a.detail ? `（${a.detail}）` : ''}`))
        .join('；');
      const firstDetail = attempts.find((a) => a.detail)?.detail;
      // 直接调用 place_support 时参照面不成立是参数/站位问题（BAD_ARGS）；但 excavate_run 的 fill
      // 需要区分“仍缺支撑”和其他能力缺口，所以额外给出结构化的原因。
      const referenceGap = attempts.some((a) => REFERENCE_PROBLEMS.has(a.problem?.kind ?? ''));
      return fail('BAD_ARGS', `[${args.at}] 没能形成可站立支撑：${attemptText}`, {
        attempts, materials: [...names], ...consumptionFacts(false), targetCell: { ...pos },
        ...(referenceGap ? { failureCause: 'reference' as const } : {}),
        remediation: {
          stance: '换到能看见目标格相邻实心面的站位再 place_support（例如目标格另一侧）',
          alternatives: ['descend_to 降到下一级后从下方补支撑', 'place_cell 在已有参照面的相邻格放置'],
          ...(firstDetail ? { reference: firstDetail } : {}),
        },
        ...movementFacts(), ...problemOf(referenceGap ? 'NO_REFERENCE' : 'PLACEMENT_FAILED', 'precondition'), ...effectUnconfirmed('support_formed'), ...after(ctx, args.facing, pos),
      });
    }
    // 只有世界核对确认目标格已形成可站立顶面才算 formed；未成支撑不记修改。
    const consumption = consumptionFacts(true);
    markSelfModified(ctx.spatial, dim, pos, ctx.taskId);
    noteEdit(ctx.taskId, 'place', pos);
    const observed = seenAt();
    if (observed && isStation(observed.name)) rememberStation(ctx, observed.name, pos);
    const supported = stateAt(adapter, pos);
    const supportTopY = supported === null ? null : supportTop(supported.name, supported.properties);
    return ok(
      `[${args.at}] 形成可站立支撑${observed ? ` ${observed.name}` : '（实际材料名称本次未看清）'}，消耗 ${consumption.consumed} 块${consumption.consumptionPending ? '（库存尚未反映，待确认）' : ''}`,
      {
        placed: observed?.name ?? null, observed: observed !== null, materials: [...names], ...consumption,
        attempts, targetCell: { ...pos }, supportTop: supportTopY === null ? null : pos.y + supportTopY,
        ...effectConfirmed('support_formed'),
        ...movementFacts(), ...after(ctx, args.facing, pos),
      },
    );
  },
};

/** 原地垫高一格。不挖头顶，不决定要不要继续爬。 */
export const pillarOne: Skill<{ item?: string }> = {
  name: 'pillar_one',
  description: '原地垫高一格：跳起来往脚下放一块方块并确认真的站上去。必须用 item 指定方块名或显式 "any"，不会默认替你选材料。头顶/侧上方阻挡时返回具体格，由你决定先 mine_cell。只垫一格，不连续爬升，不挖头顶。',
  argsDoc: '{"item":"方块名|any"}（item 必填：已知方块名或字面 any；不会默认自选材料）',
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
    if (!args.item) return fail('BAD_ARGS', 'pillar_one 需要 item：已知方块名或字面 "any"', { ...problemOf('MISSING_ARGUMENT', 'validation'), ...effectUnconfirmed('movement') });
    if (!adapter.pillarUp) return fail('ERROR', '当前适配器没有原地垫高能力', { ...problemOf('CAPABILITY_MISSING', 'precondition'), ...effectUnconfirmed('movement') });
    const inv = adapter.state().inventory;
    const names = args.item === 'any' ? PLACEABLE.filter((n) => inv.some((i) => i.name === n && i.count > 0)) : [args.item];
    if (!names.length || !inv.some((i) => names.includes(i.name) && i.count > 0)) return fail('MISSING_MATERIALS', `背包里没有 ${args.item === 'any' ? '能垫的方块（泥土/圆石/木板…）' : args.item}`, { ...problemOf('MISSING_MATERIAL', 'precondition'), ...effectUnconfirmed('movement') });
    const countOf = () => names.reduce((n, name) => n + adapter.state().inventory.filter((i) => i.name === name).reduce((sum, i) => sum + i.count, 0), 0);
    const beforeCount = countOf();
    const startState = adapter.state();
    const feet = feetCell(startState.pos);
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
    const afterCount = countOf();
    const consumedRaw = beforeCount - afterCount;
    const consumed = Math.max(0, consumedRaw);
    const inventory = {
      items: [...names], before: beforeCount, after: afterCount, consumed,
      verified: consumedRaw > 0, ...(consumedRaw === 0 ? { pending: true } : {}),
    };
    const end = feetCell(adapter.state().pos);
    const support = stateAt(adapter, feet);
    const supportName = support && supportTop(support.name, support.properties) !== null ? support.name : null;
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
      return fail(code, `原地垫高没成：${reason}${r?.clearanceDetail ? `；${r.clearanceDetail}` : ''}`, {
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
        ...(supportName !== null ? [] : [`脚下 (${feet.x},${feet.y},${feet.z}) 没有实测的可站立支撑${support ? `（${support.name}）` : '（未加载）'}`]),
      ];
      return fail('EFFECT_NOT_CONFIRMED', `没有确认垫高一格：${problems.join('；')}`, {
        climbed: rose, facing, consumed, inventory,
        ...(supportName !== null ? { support: { pos: { ...feet }, name: supportName } } : {}),
        ...problemOf(supportName === null ? 'SUPPORT_NOT_CONFIRMED' : 'PILLAR_HEIGHT_MISMATCH', 'verification'),
        ...effectUnconfirmed('movement', rose !== 0),
        ...after(ctx, facing),
      });
    }
    // 已确认脚高正好 +1 且脚下是实测可站立支撑：垫脚块就在原脚的格子。
    markSelfModified(ctx.spatial, dim, feet, ctx.taskId);
    return ok(`原地垫了一块，站高了一格（现在 y=${end.y}）${adapterError ? `（适配器回执异常：${adapterError}；已核对世界状态）` : ''}`, {
      climbed: 1, facing, support: { pos: { ...feet }, name: supportName }, consumed, inventory,
      ...(adapterReason ? { adapterReason } : {}), ...(adapterError ? { adapterError, reconciled: true } : {}),
      ...effectConfirmed('movement'), ...after(ctx, facing),
    });
  },
};

export const l1Primitives = [moveStep, mineCell, placeCell, placeSupport, pillarOne];
