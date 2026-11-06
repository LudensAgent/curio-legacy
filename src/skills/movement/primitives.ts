import type { Vec3Like } from '../../adapter/types.ts';
import { feetCell, supportCell, toWorld, type Facing } from '../../perception/local.ts';
import { blockCollidesBody, bodyBoxAt, bodyCells, estimatedFallDamage, footSurfaceY, isReplaceable, supportTop } from '../../perception/geometry.ts';
import { dropBelow, isSoftBlock, LIQUID_BLOCKS } from '../../perception/surroundings.ts';
import { sleep, throwIfAborted } from '../../util.ts';
import { breakCell, why } from '../body.ts';
import { classifyBlock, MAN_MADE_NOTE, OWN_BUILDING_HINT, ownBuildingAt, storedChestAt } from '../build.ts';
import { noteEdit } from '../../mind/edits.ts';
import { PLACEABLE } from '../survival.ts';
import { isStation, rememberStation } from '../stations.ts';
import { codeFromError, fail, isAbort, obj, ok, type Skill, type SkillCtx } from '../types.ts';
import { absValue, after, facingArg, parseRel, relValue, toRel, visibleCells, visibleStates, type Rel } from './coordinates.ts';

const AIR = new Set(['air', 'cave_air', 'void_air']);
const KEEPSAKE = /_bed$|^(crafting_table|furnace|smoker|blast_furnace|chest|barrel|anvil|jukebox|ender_chest|enchanting_table|brewing_stand|cartography_table|smithing_table|loom|stonecutter|grindstone)$|_door$|shulker_box$/;

interface CellArgs { at: Rel; facing: Facing; xyz?: Vec3Like }
interface StepArgs extends CellArgs {}
interface MineArgs extends CellArgs { own?: boolean; wet?: boolean; lava?: boolean; fall?: boolean; tool?: string }
interface PlaceArgs extends CellArgs { item: string }
interface SupportArgs extends CellArgs { item: string }

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

/** 这一列在目标脚高之外，最近的可站立面；只作为失败事实返回，不自动改落点。 */
function landingBelow(adapter: SkillCtx['adapter'], target: Vec3Like, maxDepth = 16) {
  for (let d = 1; d <= maxDepth; d++) {
    const cell = { x: target.x, y: target.y - d, z: target.z };
    const foot = footSurfaceY(cell, (p) => stateAt(adapter, p));
    if (foot !== null) return { cell, foot, drop: target.y - foot };
  }
  return null;
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
export const moveStep: Skill<StepArgs> = {
  name: 'move_step',
  description: '站到身边相邻的一格（[前,上,右] 或 xyz）。同层要求目标格脚高与当前脚高一致；上一级最多高 1 格（会跳）；下一级要求目标脚高正好低 1 格；脚下是梯子时 [0,1,0] 沿梯子爬一格。落点按实际碰撞顶面计算（半砖、雪层、地毯可为分数脚高）。目标脚高不符、下方是空腔或落差超过 1 格时如实返回支撑格和落差，不自动改落点；补支撑用 place_support，更大落差用 descend_to。',
  argsDoc: '{"to":[前,上,右], "facing"?:"N|E|S|W"} 或 {"xyz":[x,y,z]"}（前后/左右 ±1，上下 -1..1；[1,0,0] 同层，[1,1,0] 上一级，[1,-1,0] 下一级；同列 [0,1,0] 只在梯子上可爬）',
  timeoutMs: 8000,
  movement: true,
  validate(raw, adapter) {
    const a = obj(raw);
    const xyz = a.xyz ?? a.abs ?? a.world;
    const facing = facingArg(a.facing, adapter);
    if (typeof facing !== 'string' || !['N', 'E', 'S', 'W'].includes(facing)) return { ok: false, error: String(facing) };
    if (xyz !== undefined) {
      if (typeof facing !== 'string') return { ok: false, error: String(facing) };
      const p = absValue(xyz);
      if (!p) return { ok: false, error: 'xyz 需要 [x,y,z] 三个有限数字' };
      const feet = feetCell(adapter.state().pos);
      const dx = p.x - feet.x, dz = p.z - feet.z, dy = p.y - feet.y;
      const horizontal = Math.abs(dx) + Math.abs(dz);
      if (horizontal > 1) return { ok: false, error: `(${p.x},${p.y},${p.z}) 不在身边能迈到的范围：前后/左右只能 ±1` };
      if (horizontal === 0 && dy > 0 && adapter.blockAt(feet) !== 'ladder') {
        return { ok: false, error: '原地向上不是 move_step：脚下没有梯子；原地垫高用 pillar_one' };
      }
      if (horizontal === 0 && dy <= 0) return { ok: false, error: '原地上下不是 move_step：要下挖用 mine_cell，要垫高用 pillar_one' };
      if (dy < -1.01 || dy > 1.01) return { ok: false, error: `(${p.x},${p.y},${p.z}) 的脚高与当前相差 ${dy.toFixed(2)} 格，move_step 只处理 ±1 格` };
      return { ok: true, args: { at: [dx, dy, dz] as Rel, facing: facing as Facing, xyz: p } };
    }
    const to = parseRel(relValue(a), { f: 1, u: [-1, 1], r: 1 });
    if (typeof to === 'string') return { ok: false, error: to };
    if (to[0] === 0 && to[2] === 0) {
      const feet = feetCell(adapter.state().pos);
      if (!(to[1] === 1 && adapter.blockAt(feet) === 'ladder')) {
        return { ok: false, error: '原地上下不是 move_step：往上只有脚下有梯子才能爬；要原地垫高用 pillar_one，要迈上台阶用 [1,1,0]' };
      }
    }
    return { ok: true, args: { at: to, facing: facing as Facing } };
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
    const start = adapter.state().pos;
    const feet = feetCell(start);
    let target: Vec3Like;
    let rel: Rel;
    if (args.xyz !== undefined) {
      target = { x: args.xyz.x, y: args.xyz.y, z: args.xyz.z };
      rel = toRel(feet, args.facing, target);
    } else {
      rel = args.at;
      target = toWorld(feet, args.facing, rel);
    }
    const partial = (extra?: Record<string, unknown>) => {
      const s = adapter.state();
      return { at: rel, facing: args.facing, ...(args.xyz !== undefined ? { xyz: args.xyz } : {}), target: { ...target }, position: { ...s.pos }, moved: s.pos.x !== start.x || s.pos.y !== start.y || s.pos.z !== start.z, ...(extra ?? {}) };
    };
    // 梯子上爬一格
    const sameColumn = Math.abs(target.x - feet.x) < 0.01 && Math.abs(target.z - feet.z) < 0.01;
    if (sameColumn && target.y > feet.y + 0.01 && adapter.blockAt(feet) === 'ladder') {
      const blocker = bodyProblem(adapter, target.y, target.x, target.z);
      if (blocker) {
        const digRel = toRel(feet, args.facing, blocker.cell);
        return fail('PATH_NOT_FOUND', `梯子往上爬不动：头顶上方是 ${blocker.name}（先 mine_cell [${digRel}]）`, { ...partial(), remediation: { dig: digRel, reason: 'ladder-head' }, ...after(ctx, args.facing, target) });
      }
      try {
        await adapter.moveTo({ kind: 'xyz', x: target.x, y: target.y, z: target.z }, { signal: ctx.signal, timeoutMs: Math.max(1000, Math.min(6000, ctx.deadline - Date.now())), allowTerrainChanges: false });
      } catch (e) {
        if (isAbort(e)) {
          (e as Error & { partial?: Record<string, unknown> }).partial = partial({ targetFoot: target.y });
          throw e;
        }
        return fail(codeFromError(e), `没有爬到指定格：${(e as Error).message}`, { ...partial(), ...after(ctx, args.facing, target) });
      }
      const end = feetCell(adapter.state().pos);
      if (end.x !== target.x || end.y !== target.y || end.z !== target.z) {
        return fail('EFFECT_NOT_CONFIRMED', `没有爬到指定格，实际在 (${end.x},${end.y},${end.z})`, { ...partial(), ...after(ctx, args.facing, target) });
      }
      return ok(`沿梯子爬上了一格（现在 y=${end.y}）`, { moved: [0, 1, 0], ...after(ctx, args.facing, target) });
    }
    if (adapter.state().inWater) {
      return fail('BAD_ARGS', '在水里不用 move_step 爬岸；用 swim_path 指定干岸或水中点', after(ctx, args.facing, target));
    }
    const direct = footSurfaceY(target, (p) => stateAt(adapter, p));
    const absolute = args.xyz !== undefined;
    const baseFoot = start.y;
    const wanted = absolute ? target.y : baseFoot + rel[1];
    if (direct === null) {
      const below = landingBelow(adapter, target);
      const facts = below
        ? { landing: { x: target.x, y: below.foot, z: target.z, drop: below.drop }, support: { ...target, y: target.y - 1 } }
        : { support: { ...target, y: target.y - 1 } };
      return fail('PATH_NOT_FOUND', `没有执行迈步：目标格 (${target.x},${target.y},${target.z}) 在当前脚高 ${wanted.toFixed(2)} 没有可站立面；${below ? `同列下方 ${below.drop.toFixed(2)} 格才是可站立脚面 y=${below.foot.toFixed(2)}，要下去用 descend_to` : '同列下方没有找到可站立面'}。要补支撑用 place_support 目标脚下方那一格`, { ...facts, movementNotAttempted: true, ...after(ctx, args.facing, target) });
    }
    // 绝对 xyz 的 y 是调用者指定的脚高：支撑面必须与它一致，不能悄悄改成实际支撑面。
    if (absolute && Math.abs(direct - target.y) > 0.01) {
      return fail('PATH_NOT_FOUND', `没有执行迈步：目标格 (${target.x},${target.y},${target.z}) 的支撑面在 y=${direct.toFixed(2)}，与绝对脚高 ${target.y.toFixed(2)} 不符；未执行迈步`, { targetCell: target, expectedFoot: target.y, actualSupport: direct, movementNotAttempted: true, ...after(ctx, args.facing, target) });
    }
    if (!absolute) {
      if (rel[1] === 0 && Math.abs(direct - baseFoot) > 0.01) {
        return fail('PATH_NOT_FOUND', `没有执行迈步：目标格的实际脚高是 y=${direct.toFixed(2)}，不是同层 y=${baseFoot.toFixed(2)}；半格/一格的下落请用 [1,-1,0]，更大落差用 descend_to`, { actualFoot: direct, expectedFoot: baseFoot, movementNotAttempted: true, ...after(ctx, args.facing, target) });
      }
      if (rel[1] === -1 && (direct > baseFoot - 0.5 + 0.01 || direct < baseFoot - 1 - 0.01)) {
        return fail('PATH_NOT_FOUND', `没有执行迈步：下一级目标格的实际脚高是 y=${direct.toFixed(2)}，不在当前脚高下方 0.5–1 格内；落点不符，先用 place_support 或 assess_landings/descend_to 确认`, { actualFoot: direct, expectedFoot: wanted, movementNotAttempted: true, ...after(ctx, args.facing, target) });
      }
      if (rel[1] === 1 && (direct < baseFoot + 0.5 - 0.01 || direct > baseFoot + 1 + 0.01)) {
        return fail('PATH_NOT_FOUND', `没有执行迈步：目标格没有高半格以上、且不超过 1 格的可站立面（实际脚高 y=${direct.toFixed(2)}，当前 y=${baseFoot.toFixed(2)}）；要平走把上分量改成 0`, { actualFoot: direct, expectedFoot: wanted, movementNotAttempted: true, ...after(ctx, args.facing, target) });
      }
    }
    const targetY = absolute ? target.y : direct;
    if (targetY > baseFoot + 0.5) {
      const jump = bodyProblem(adapter, targetY, feet.x, feet.z);
      if (jump) {
        const digRel = toRel(feet, args.facing, jump.cell);
        return fail('PATH_NOT_FOUND', `没有执行迈步：往上迈时自己头顶/起跳路径上是 ${jump.name}（先 mine_cell [${digRel}]）`, {
          targetCell: target, movementNotAttempted: true, remediation: { dig: digRel, reason: 'jump-head' }, ...after(ctx, args.facing, target),
        });
      }
    }
    const blocker = bodyProblem(adapter, targetY, target.x, target.z);
    if (blocker) {
      const digRel = toRel(feet, args.facing, blocker.cell);
      const atTarget = blocker.cell.y === target.y;
      return fail('PATH_NOT_FOUND', `没有执行迈步：${atTarget ? '目标格' : '目标格上方'}是 ${blocker.name}（先 mine_cell [${digRel}]）`, {
        problems: [`${atTarget ? '目标格' : '目标格上方'}是 ${blocker.name}`], targetCell: target,
        movementNotAttempted: true, remediation: { dig: digRel, reason: atTarget ? 'feet' : 'head' }, ...after(ctx, args.facing, target),
      });
    }
    try {
      await adapter.moveTo({ kind: 'xyz', x: target.x, y: targetY, z: target.z }, { signal: ctx.signal, timeoutMs: Math.max(1000, Math.min(6000, ctx.deadline - Date.now())), allowTerrainChanges: false });
    } catch (e) {
      if (isAbort(e)) {
        (e as Error & { partial?: Record<string, unknown> }).partial = partial({ targetFoot: targetY });
        throw e;
      }
      return fail(codeFromError(e), `没有站到指定格：${(e as Error).message}`, { ...partial(), targetFoot: targetY, ...after(ctx, args.facing, target) });
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
      return fail('EFFECT_NOT_CONFIRMED', `没有站到指定格：${why}`, { ...partial(), ...after(ctx, args.facing, target) });
    }
    const drop = baseFoot - targetY;
    const damage = drop > 0 ? estimatedFallDamage(drop) : 0;
    return ok(`站到了 [${rel}]（脚高 y=${targetY.toFixed(2)}）${drop > 0 ? `，下落 ${drop.toFixed(2)} 格` : ''}${damage ? `（预计约 ${damage} 点摔伤）` : ''}`, {
      moved: [...rel], ...(drop > 0 ? { drop, fall: { drop, damage } } : {}), ...after(ctx, args.facing, target),
    });
  },
};

/** 挖掉确切的一格。用户明确指定目标、可接受的风险和工具；代码只执行并核对。 */
export const mineCell: Skill<MineArgs> = {
  name: 'mine_cell',
  description: '挖掉身边指定的一格（[前,上,右] 或 xyz）。目标不在视野时先转头看向它，仍看不见则返回未知，不挖其他位置。手上有能挖、也不比空手慢的工具就用；不能挖或更慢才换背包里更合适的；不自动造工具。tool 明确指定这一格用哪件工具，指定后只装备这一把，挖不动/不在背包返回 TOOL_MISSING。液体邻格默认不挖；wet/lava 分别显式接受进水/进岩浆。挖脚下支撑块若下方有落差/液体会拦住，fall:true 才接受风险。只挖不走，不挖基岩。',
  argsDoc: '{"at":[前,上,右], "facing"?:"N|E|S|W", "tool"?:"物品注册名", "wet"?true, "lava"?true, "fall"?true} 或 {"xyz":[x,y,z]}（前后/左右 ±2，上下 -1..3）',
  timeoutMs: 30000,
  movement: false,
  validate(raw, adapter) {
    const a = obj(raw);
    const facing = facingArg(a.facing, adapter);
    if (typeof facing !== 'string') return { ok: false, error: String(facing) };
    const xyz = a.xyz ?? a.abs ?? a.world;
    if (xyz !== undefined) {
      return { ok: true, args: { at: [0, 0, 0] as Rel, facing: facing as Facing, xyz: xyz as Vec3Like, ...(a.own === true ? { own: true } : {}), ...(a.wet === true ? { wet: true } : {}), ...(a.lava === true ? { lava: true } : {}), ...(a.fall === true ? { fall: true } : {}), ...(typeof a.tool === 'string' ? { tool: a.tool } : {}) } };
    }
    const at = parseRel(relValue(a), { f: 2, u: [-1, 3], r: 2 });
    if (typeof at === 'string') return { ok: false, error: at };
    const tool = a.tool;
    if (tool !== undefined && (typeof tool !== 'string' || !/^[a-z0-9_]{1,80}$/.test(tool))) return { ok: false, error: 'tool 为可选物品注册名（小写字母、数字、下划线）' };
    return { ok: true, args: { at, facing: facing as Facing, ...(tool !== undefined ? { tool } : {}), ...(a.own === true ? { own: true } : {}), ...(a.wet === true ? { wet: true } : {}), ...(a.lava === true ? { lava: true } : {}), ...(a.fall === true ? { fall: true } : {}) } };
  },
  async run(ctx, args) {
    throwIfAborted(ctx.signal);
    const adapter = ctx.adapter;
    const raw = adapter.state().pos;
    const feet = feetCell(raw);
    const support = supportCell(raw);
    const digsSupport = args.xyz !== undefined
      ? args.xyz.x === support.x && args.xyz.y === support.y && args.xyz.z === support.z
      : args.at[0] === 0 && args.at[2] === 0 && args.at[1] === -1;
    const pos = args.xyz !== undefined ? { ...args.xyz } : digsSupport ? support : toWorld(feet, args.facing, args.at);
    const loaded = adapter.blockAt(pos);
    const ownCell = pos.x === feet.x && pos.z === feet.z && (pos.y === feet.y || pos.y === feet.y + 1);
    if (loaded === null) return fail('NOT_FOUND', `[${args.at}] 那一格还没加载（区块没载入），看不见也没法挖`, { ...after(ctx, args.facing, pos), noop: true, obscured: true });
    if (ownCell && AIR.has(loaded)) return ok(`[${args.at}] 是自己站的格子，本来就空着，别挖这里`, { ...after(ctx, args.facing, pos), noop: true });
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
      return fail('NOT_FOUND', `[${args.at}] 没有发生挖掘：目标格 (${pos.x},${pos.y},${pos.z}) 状态未确认（视野外/被遮挡/未加载），不把未看见当作空气；换个站位或先挖掉挡着的那一格`, { ...after(ctx, args.facing, pos), targetCell: { ...pos }, target: { ...pos }, noop: true, obscured: true, unknown: true });
    }
    const before = seenBefore;
    if (AIR.has(before)) return ok(`[${args.at}] 本来就是空的，不用挖`, { cell: [...args.at], was: 'air', ...after(ctx, args.facing, pos), noop: true });
    if (LIQUID_BLOCKS.has(before)) return fail('BAD_ARGS', `[${args.at}] 是 ${before}，挖不了`, after(ctx, args.facing, pos));
    const wet = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]]
      .map(([dx, dy, dz]) => ({ pos: { x: pos.x + dx, y: pos.y + dy, z: pos.z + dz }, name: adapter.blockAt({ x: pos.x + dx, y: pos.y + dy, z: pos.z + dz }) ?? '' }))
      .filter((n) => LIQUID_BLOCKS.has(n.name));
    const blocked = wet.filter((w) => /lava/.test(w.name) ? !args.lava : !args.wet);
    if (blocked.length) {
      return fail('BAD_ARGS', `[${args.at}] 挖开会有液体流进来：${wet.map((w) => `${w.name} 在 [${toRel(feet, args.facing, w.pos)}]`).join('、')}；写 wet:true 或 lava:true 明确接受后再挖`, { wet: wet[0]?.name, wetCells: wet.map((w) => toRel(feet, args.facing, w.pos)), ...after(ctx, args.facing, pos) });
    }
    let fallFacts: { below: string | null; drop: number | null; fallRisk: string } | undefined;
    if (digsSupport) {
      const { drop, landing } = dropBelow(adapter, pos);
      if (drop === 0 || LIQUID_BLOCKS.has(landing ?? '')) {
        fallFacts = { below: landing, drop, fallRisk: drop === 0 ? '下方没有已确认的落点' : `下方 ${drop} 格是 ${landing}` };
        if (!args.fall) return fail('BAD_ARGS', `[${args.at}] 挖的是脚下支撑块：${fallFacts.fallRisk}，没有往下挖；确认接受风险写 fall:true`, { ...after(ctx, args.facing, pos), ...fallFacts });
      }
    }
    const mine = args.own ? null : ownBuildingAt(ctx.memory, adapter.state(), pos, before);
    if (mine) return fail('BAD_ARGS', `[${args.at}] 的 ${before} 是自己盖的「${mine.name}」的一部分；${OWN_BUILDING_HINT}`, { own: mine, ...after(ctx, args.facing, pos) });
    const structure = classifyBlock(ctx.memory, adapter.state(), pos, before);
    const stash = args.own ? null : storedChestAt(ctx.memory, adapter.state(), pos, before);
    if (stash) return fail('BAD_ARGS', stash, after(ctx, args.facing, pos));
    const keepsake = KEEPSAKE.test(before) ? before : null;
    const countOf = (n: string) => adapter.state().inventory.filter((i) => i.name === n).reduce((a, i) => a + i.count, 0);
    const had = keepsake ? countOf(keepsake) : 0;
    try {
      await breakCell(ctx, pos, true, undefined, { allowWater: args.wet, allowLava: args.lava, ...(args.tool ? { tool: args.tool } : {}) });
    } catch (e) {
      if (isAbort(e)) throw e;
      const code = String((e as Error).message).startsWith('TOOL_MISSING') ? 'TOOL_MISSING' : codeFromError(e);
      return fail(code, `挖 [${args.at}] 的 ${before} 没成：${why(e)}`, after(ctx, args.facing, pos));
    }
    const now = adapter.blockAt(pos);
    if (now && !AIR.has(now) && !isSoftBlock(now)) return ok(`挖掉了 [${args.at}] 的 ${before}，但上面掉下来的 ${now} 又填上了`, { cell: [...args.at], was: before, now, ...after(ctx, args.facing, pos), ...fallFacts });
    noteEdit(ctx.taskId, 'dig', pos);
    let got = '';
    let inBag: boolean | undefined;
    if (keepsake) {
      for (let i = 0; i < 6 && countOf(keepsake) <= had; i++) await sleep(150, ctx.signal);
      inBag = countOf(keepsake) > had;
      got = inBag ? `；${keepsake} 已经进了背包` : `；${keepsake} 掉在地上，还没进背包——要拿回来写 pickup_items`;
    }
    return ok(`挖掉了 [${args.at}] 的 ${before}${got}`, { cell: [...args.at], was: before, ...(inBag !== undefined ? { inBag } : {}), ...after(ctx, args.facing, pos), ...fallFacts }, structure === 'man-made' ? MAN_MADE_NOTE : undefined);
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
    const xyz = a.xyz ?? a.abs ?? a.world;
    if (xyz !== undefined) return { ok: true, args: { at: [0, 0, 0] as Rel, facing: facing as Facing, xyz: xyz as Vec3Like, item } };
    const at = parseRel(relValue(a), { f: 2, u: [-2, 3], r: 2 });
    if (typeof at === 'string') return { ok: false, error: at };
    return { ok: true, args: { at, facing: facing as Facing, item } };
  },
  async run(ctx, args) {
    throwIfAborted(ctx.signal);
    const adapter = ctx.adapter;
    const feet = feetCell(adapter.state().pos);
    const pos = args.xyz !== undefined ? { ...args.xyz } : toWorld(feet, args.facing, args.at);
    const raw = stateAt(adapter, pos);
    const seen = visibleStates(ctx, [pos]).get(`${pos.x},${pos.y},${pos.z}`) ?? null;
    if (raw === null) return fail('NOT_FOUND', `[${args.at}] 目标格未加载，无法确认是否为空，没有放置`, after(ctx, args.facing, pos));
    if (!AIR.has(raw.name) && !isReplaceable(raw.name)) {
      if (raw.name === args.item) return ok(`[${args.at}] 已经有 ${args.item} 了`, { already: raw.name, noop: true, ...after(ctx, args.facing, pos) });
      return fail('PATH_NOT_FOUND', `[${args.at}] 已被 ${seen?.name ?? '未看清的方块'} 占据（${shapeOf(raw.name, raw.properties)}），不是要放的 ${args.item}；先 mine_cell 清掉或换一格`, { occupied: seen?.name ?? null, ...after(ctx, args.facing, pos) });
    }
    if (!adapter.state().inventory.some((i) => i.name === args.item && i.count > 0)) return fail('MISSING_MATERIALS', `背包里没有 ${args.item}`, after(ctx, args.facing, pos));
    try {
      const r = await adapter.placeBlockAt(pos, [args.item], ctx.signal);
      if (!r.ok) return fail(r.reason === 'NO_ITEM' ? 'MISSING_MATERIALS' : 'PATH_NOT_FOUND', `放不到 [${args.at}]：${r.reason ?? r.detail ?? '放置失败'}`, after(ctx, args.facing, pos));
    } catch (e) {
      if (isAbort(e)) throw e;
      return fail(codeFromError(e), `放 [${args.at}] 没成：${(e as Error).message}`, after(ctx, args.facing, pos));
    }
    const now = adapter.blockStateAt?.(pos)?.name ?? adapter.blockAt(pos);
    if (!now || AIR.has(now)) return fail('EFFECT_NOT_CONFIRMED', `[${args.at}] 还是空的`, after(ctx, args.facing, pos));
    if (now !== args.item && !(args.item === 'torch' && now === 'wall_torch')) return fail('EFFECT_NOT_CONFIRMED', `[${args.at}] 实际出现的是 ${now}，不是请求的 ${args.item}`, { placed: now, requested: args.item, ...after(ctx, args.facing, pos) });
    noteEdit(ctx.taskId, 'place', pos);
    if (isStation(now)) rememberStation(ctx, now, pos);
    return ok(`在 [${args.at}] 放了 ${now}`, { placed: now, ...after(ctx, args.facing, pos) });
  },
};

/** 形成可站立支撑；已有可站面就成功，不要求同名材料。 */
export const placeSupport: Skill<SupportArgs> = {
  name: 'place_support',
  description: '在指定格形成可站立支撑（[前,上,右] 或 xyz）。已有可站立顶面（整块、半砖、雪层等）就算满足，不要求与 item 同名，也不再消耗材料；只有空气/可替换植物才放 item。支持脚下一格和脚下两格；当前站位看不到唯一参照面时会尝试后退/侧移或潜行到脚下方块边缘再放。只放这一格，不换材料、不换目标。',
  argsDoc: '{"at":[前,上,右], "item"?:"方块名|any", "facing"?:"N|E|S|W"} 或 {"xyz":[x,y,z], "item"?:"方块名|any"}（前后/左右 ±2，上下 -2..3）',
  timeoutMs: 20000,
  movement: true,
  validate(raw, adapter) {
    const a = obj(raw);
    const facing = facingArg(a.facing, adapter);
    if (typeof facing !== 'string') return { ok: false, error: String(facing) };
    const item = String(a.item ?? a.block ?? 'any').trim().replace(/^minecraft:/, '');
    if (item !== 'any' && (!/^[a-z0-9_]{1,80}$/.test(item) || !adapter.isKnownItem(item))) return { ok: false, error: `item 需要已知方块名或 "any"` };
    if (/_(boat|raft)$/.test(item)) return { ok: false, error: `${item} 是实体，不是方块` };
    const xyz = a.xyz ?? a.abs ?? a.world;
    if (xyz !== undefined) return { ok: true, args: { at: [0, 0, 0] as Rel, facing: facing as Facing, xyz: xyz as Vec3Like, item } };
    const at = parseRel(relValue(a), { f: 2, u: [-2, 3], r: 2 });
    if (typeof at === 'string') return { ok: false, error: at };
    return { ok: true, args: { at, facing: facing as Facing, item } };
  },
  async run(ctx, args) {
    throwIfAborted(ctx.signal);
    const adapter = ctx.adapter;
    const feet = feetCell(adapter.state().pos);
    const pos = args.xyz !== undefined ? { ...args.xyz } : toWorld(feet, args.facing, args.at);
    const raw = stateAt(adapter, pos);
    if (raw === null) return fail('NOT_FOUND', `[${args.at}] 目标格未加载，无法确认是否需要支撑`, after(ctx, args.facing, pos));
    const top = supportTop(raw.name, raw.properties);
    if (top !== null) {
      const seen = visibleStates(ctx, [pos]).get(`${pos.x},${pos.y},${pos.z}`);
      return ok(`[${args.at}] 已经有可站立支撑 ${seen?.name ?? '（未看清名称）'}（${shapeOf(raw.name, raw.properties)}），没有另放 ${args.item}`, { already: seen?.name ?? null, supportTop: pos.y + top, standable: true, noop: true, ...after(ctx, args.facing, pos) });
    }
    if (!isReplaceable(raw.name)) return fail('PATH_NOT_FOUND', `[${args.at}] 已被 ${raw.name} 占据（${shapeOf(raw.name, raw.properties)}），不是可站立支撑；先 mine_cell 清掉或换一格`, { occupied: raw.name, ...after(ctx, args.facing, pos) });
    const inv = adapter.state().inventory;
    const names = args.item === 'any' ? PLACEABLE.filter((n) => inv.some((i) => i.name === n && i.count > 0)) : [args.item];
    if (!names.length || !inv.some((i) => names.includes(i.name) && i.count > 0)) return fail('MISSING_MATERIALS', `背包里没有 ${args.item === 'any' ? '能垫的方块' : args.item}`, after(ctx, args.facing, pos));
    const attempts: Record<string, unknown>[] = [];
    const countOf = () => names.reduce((n, name) => n + adapter.state().inventory.filter((i) => i.name === name).reduce((sum, i) => sum + i.count, 0), 0);
    const beforeCount = countOf();
    const verify = () => {
      const now = stateAt(adapter, pos);
      return now !== null && supportTop(now.name, now.properties) !== null ? now : null;
    };
    // 已消耗材料但目标格仍不可站：不再换站位/换材料重试，避免一次委托消耗多块。
    const consumedWithoutSupport = (reason: string) => {
      const used = beforeCount - countOf();
      return used > 0
        ? fail('EFFECT_NOT_CONFIRMED', `[${args.at}] 放了 ${used} 块方块，但目标格仍没有形成可站立支撑（${reason}）`, { consumed: used, targetCell: { ...pos }, ...after(ctx, args.facing, pos) })
        : null;
    };
    // 1) 当前站位直接放
    let placed: string | null = null;
    try {
      const r = await adapter.placeBlockAt(pos, names, ctx.signal);
      if (r.ok && verify()) placed = verify()!.name;
      else {
        attempts.push({ stance: 'current', reason: r.reason ?? r.detail ?? 'not placed' });
        if (r.ok) {
          const exhausted = consumedWithoutSupport('放置回执成功但目标格不可站');
          if (exhausted) return exhausted;
        }
      }
    } catch (e) {
      if (isAbort(e)) throw e;
      attempts.push({ stance: 'current', reason: (e as Error).message });
    }
    const dx = pos.x - feet.x, dz = pos.z - feet.z;
    // 2) 目标与脚水平相邻、在脚下一格：交给适配器的边缘潜行放置
    if (!placed && adapter.sneakPlaceAt && Math.abs(dx) + Math.abs(dz) === 1 && Math.abs(pos.y - (feet.y - 1)) <= 0.01) {
      try {
        const edge = await adapter.sneakPlaceAt(pos, names, ctx.signal);
        if (edge.ok && verify()) placed = verify()!.name;
        else {
          attempts.push({ stance: 'edge', reason: edge.reason ?? 'not placed' });
          if (edge.ok) {
            const exhausted = consumedWithoutSupport('边缘放置回执成功但目标格不可站');
            if (exhausted) return exhausted;
          }
        }
      } catch (e) {
        if (isAbort(e)) throw e;
        attempts.push({ stance: 'edge', reason: (e as Error).message });
      }
    }
    // 3) 换一个站位重试：后退一格、左右各一格。只换站位，不换目标/材料。
    const stances = [
      { name: 'back', pos: { x: feet.x - Math.sign(dx), y: feet.y, z: feet.z - Math.sign(dz) } },
      { name: 'left', pos: { x: feet.x - Math.sign(dz), y: feet.y, z: feet.z + Math.sign(dx) } },
      { name: 'right', pos: { x: feet.x + Math.sign(dz), y: feet.y, z: feet.z - Math.sign(dx) } },
    ].filter((s) => s.pos.x !== feet.x || s.pos.z !== feet.z);
    for (const stance of placed ? [] : stances) {
      try {
        await adapter.moveTo({ kind: 'near', pos: { x: stance.pos.x + 0.5, y: feet.y, z: stance.pos.z + 0.5 }, range: 0.3 }, { signal: ctx.signal, timeoutMs: Math.min(2500, ctx.deadline - Date.now()), constructionSafe: true, allowSwimming: false });
        const r = await adapter.placeBlockAt(pos, names, ctx.signal);
        if (r.ok && verify()) { placed = verify()!.name; attempts.push({ stance: stance.name, ok: true }); break; }
        attempts.push({ stance: stance.name, reason: r.reason ?? r.detail ?? 'not placed' });
        if (r.ok) {
          const exhausted = consumedWithoutSupport(`在 ${stance.name} 站位放置回执成功但目标格不可站`);
          if (exhausted) return exhausted;
        }
      } catch (e) {
        if (isAbort(e)) throw e;
        attempts.push({ stance: stance.name, reason: (e as Error).message });
      }
    }
    if (!placed) return fail('PATH_NOT_FOUND', `[${args.at}] 没能形成可站立支撑：${attempts.map((a) => `${a.stance}:${a.reason}`).join('；')}`, { attempts, targetCell: { ...pos }, ...after(ctx, args.facing, pos) });
    noteEdit(ctx.taskId, 'place', pos);
    if (isStation(placed)) rememberStation(ctx, placed, pos);
    return ok(`[${args.at}] 形成可站立支撑 ${placed}`, { placed, attempts, targetCell: { ...pos }, ...after(ctx, args.facing, pos) });
  },
};

/** 原地垫高一格。不挖头顶，不决定要不要继续爬。 */
export const pillarOne: Skill<{ item?: string }> = {
  name: 'pillar_one',
  description: '原地垫高一格：跳起来往脚下放一块方块并确认真的站上去。需要背包里有可垫方块；头顶/侧上方阻挡时返回具体格，由你决定先 mine_cell。只垫一格，不连续爬升，不挖头顶。',
  argsDoc: '{"item"?:"方块名|any"}（默认 any，从背包里任选能垫的）',
  timeoutMs: 20000,
  movement: true,
  validate(raw) {
    const a = obj(raw);
    if (a.item !== undefined && (typeof a.item !== 'string' || !/^[a-z0-9_]{1,80}$/.test(String(a.item)))) return { ok: false, error: 'item 为可选方块名或 any' };
    return { ok: true, args: a.item !== undefined ? { item: String(a.item) } : {} };
  },
  async run(ctx, args) {
    throwIfAborted(ctx.signal);
    const adapter = ctx.adapter;
    if (!adapter.pillarUp) return fail('ERROR', '当前适配器没有原地垫高能力');
    const inv = adapter.state().inventory;
    const names = args.item && args.item !== 'any' ? [args.item] : PLACEABLE.filter((n) => inv.some((i) => i.name === n && i.count > 0));
    if (!names.length || !inv.some((i) => names.includes(i.name) && i.count > 0)) return fail('MISSING_MATERIALS', `背包里没有 ${args.item && args.item !== 'any' ? args.item : '能垫的方块（泥土/圆石/木板…）'}`);
    const before = adapter.state().pos;
    const feet = feetCell(before);
    const r = await adapter.pillarUp(names, ctx.signal);
    if (!r.ok) {
      const code = r.reason === 'NO_ITEM' ? 'MISSING_MATERIALS' : r.reason === 'NO_REFERENCE' ? 'PATH_NOT_FOUND' : r.reason === 'OCCUPIED' || String(r.reason).startsWith('BLOCKED:') ? 'PATH_NOT_FOUND' : 'EFFECT_NOT_CONFIRMED';
      return fail(code, `原地垫高没成：${String(r.reason ?? '未知原因')}${r.clearanceDetail ? `；${r.clearanceDetail}` : ''}`, { pillarFailure: r.reason, ...(r.clearance ? { pillarClearance: r.clearance } : {}), ...after(ctx, 'N') });
    }
    const state = adapter.state();
    const end = feetCell(state.pos);
    const under = adapter.blockAt(feet);
    if (end.y <= feet.y || !under || AIR.has(under) || isSoftBlock(under)) return fail('EFFECT_NOT_CONFIRMED', '没有站高一格：方块没留在脚下', after(ctx, 'N'));
    return ok(`原地垫了一块，站高了一格（现在 y=${end.y}）`, { climbed: 1, ...after(ctx, 'N') });
  },
};

export const l1Primitives = [moveStep, mineCell, placeCell, placeSupport, pillarOne];
