import { isSoftBlock, LIQUID_BLOCKS, surroundings } from '../perception/surroundings.ts';
import { feetCell, toWorld } from '../perception/local.ts';
import { clampInt, fail, isAbort, obj, ok, type Skill, type SkillCtx } from './types.ts';
import { hasPlaceable, PLACEABLE } from './survival.ts';
import { ensureToolFor } from './work.ts';
import { findStation, forgetStationAt } from './stations.ts';
import type { Vec3Like } from '../adapter/types.ts';
import { sleep, throwIfAborted } from '../util.ts';

/**
 * 身体的基本动作：拆掉一格（breakCell）和原地垫方块往上爬（climb_up）。
 * 程序执行指定动作；液体邻接默认停下，Agent 可分别允许进水或进岩浆。
 */

const floor = (p: { x: number; y: number; z: number }) => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });

/** 挖开这一格会不会让液体流进来（它的邻格有水/岩浆） */
const liquidNeighbours = (ctx: SkillCtx, c: Vec3Like) => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]]
  .map(([dx, dy, dz]) => ctx.adapter.blockAt({ x: c.x + dx, y: c.y + dy, z: c.z + dz }))
  .filter((name): name is string => name !== null && LIQUID_BLOCKS.has(name));

export async function breakCell(ctx: SkillCtx, c: Vec3Like, exact = false, info?: { noDrop?: boolean; ms?: number }, opts: { allowWater?: boolean; allowLava?: boolean; tool?: string; handOnly?: boolean } = {}): Promise<string | null> {
  const name = ctx.adapter.blockAt(c);
  if (!exact && isSoftBlock(name)) return null;
  if (name && LIQUID_BLOCKS.has(name)) throw new Error(`LIQUID:${name}`);
  if (name === 'bedrock') throw new Error('BEDROCK');
  const wet = liquidNeighbours(ctx, c).find((name) => /lava/.test(name) ? !opts.allowLava : !opts.allowWater);
  if (wet) throw new Error(`LIQUID_NEAR:${wet}`);
  // 只有 make:true 才能在身边工作台准备木镐；默认直接用现有工具或空手挖。指定了工具或只要当前手持就不替它造/换。
  if (!opts.tool && !opts.handOnly && ctx.make === true && !ctx.adapter.canHarvest(c) && findStation(ctx, ['crafting_table'], 4)) await ensureToolFor(ctx, c);
  if (exact && ctx.adapter.blockAt(c) !== name) throw new Error('TARGET_CHANGED：目标方块已经改变，停止拆除');
  const origin = ctx.adapter.state();
  const affected = [c], properties = ctx.adapter.blockStateAt?.(c)?.properties ?? {};
  const facing = ({ north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] } as Record<string, number[]>)[String(properties.facing)];
  if (name?.endsWith('_bed') && facing && ['foot', 'head'].includes(String(properties.part))) {
    const sign = properties.part === 'head' ? -1 : 1;
    affected.push({ x: c.x + facing[0] * sign, y: c.y, z: c.z + facing[1] * sign });
  } else if (name?.endsWith('_door') && ['lower', 'upper'].includes(String(properties.half))) affected.push({ ...c, y: c.y + (properties.half === 'lower' ? 1 : -1) });
  const digOpts = opts.tool ? { tool: opts.tool } : opts.handOnly ? { handOnly: true } : undefined;
  const r = await ctx.adapter.dig(c, ctx.signal, digOpts).finally(() => {
    if (!name || ctx.memory.worldId !== origin.worldId || ctx.adapter.state().dim !== origin.dim) return;
    const removed = affected.filter((pos) => { const after = ctx.adapter.blockAt(pos); return after !== null && after !== name; });
    if (removed.length) {
      forgetStationAt(ctx.memory, origin.dim, removed, name);
      removed.forEach((pos) => ctx.memory.markGone(name, origin.dim, pos, ctx.adapter.blockAt(pos)!));
    }
  });
  if (!r.ok) throw new Error(r.reason ?? 'DIG_FAILED');
  if (info) { info.noDrop = !!r.noDrop; info.ms = r.digMs; }
  return name;
}

export const why = (e: unknown) => {
  const m = String((e as Error)?.message ?? e);
  if (m.startsWith('LIQUID_NEAR:')) return `再挖 ${m.slice(12)} 就会流进来，停下了`;
  if (m.startsWith('LIQUID:')) return `那边是 ${m.slice(7)}`;
  if (m === 'BEDROCK') return '碰到基岩，挖不动';
  if (m.startsWith('NEED_TOOL:')) return m.slice(10);
  if (m.startsWith('TOOL_MISSING:')) return m.slice('TOOL_MISSING:'.length).trim();
  if (m === 'TOOL_MISSING') return '适配器报告当前工具条件不足；检查具体方块、工具和动作时间预算';
  return m;
};

// ------------------------------------------------------------------ climb_up
export const climbUp: Skill<{ height: number; untilSky: boolean; untilExit?: boolean; deadlineMs?: number }> = {
  name: 'climb_up',
  description: '原地往上爬（头顶挡着会先挖开）：脚下是梯子就沿梯子爬，否则跳起来往脚下垫方块（需要背包里有泥土/圆石等方块）；until_sky 爬到看得见天空，until_exit 爬到四周有路可走（出坑）',
  argsDoc: '{"height"?: 1-24, "until_sky"?: boolean, "until_exit"?: boolean, "deadlineMs"?: 可选绝对 epoch 毫秒（只能缩短本次执行期限）}；兼容 untilSky/untilExit；两个停止条件同时开启时须同时满足',
  timeoutMs: 90000,
  movement: true,
  validate(raw) {
    const a = obj(raw);
    const untilExit = a.until_exit ?? a.untilExit ?? false;
    const untilSky = a.until_sky ?? a.untilSky ?? (a.height === undefined && !untilExit);
    if (typeof untilExit !== 'boolean' || typeof untilSky !== 'boolean') return { ok: false, error: 'until_sky/until_exit 须为布尔值' };
    const deadlineMs = a.deadlineMs;
    if (deadlineMs !== undefined && (typeof deadlineMs !== 'number' || !Number.isFinite(deadlineMs) || deadlineMs <= 0)) return { ok: false, error: 'deadlineMs 必须是正的绝对 epoch 毫秒' };
    return { ok: true, args: { height: clampInt(a.height, 1, 24, untilSky || untilExit ? 16 : 3), untilSky, ...(untilExit ? { untilExit } : {}), ...(deadlineMs !== undefined ? { deadlineMs } : {}) } };
  },
  async run(ctx, args) {
    const { adapter, signal } = ctx;
    // 自动续跑沿用原动作期限；args.deadlineMs 只能缩短，不能延长父任务预算。
    const deadline = Math.min(ctx.deadline, args.deadlineMs ?? Number.POSITIVE_INFINITY);
    throwIfAborted(signal);
    // 显式垫高/沿梯移动/落地等待都必须受剩余绝对期限约束；只传信号，不替新的动作所有者 stopAll。
    const operationSignal = () => Number.isFinite(deadline)
      ? AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))])
      : signal;
    const onLadder = () => adapter.blockAt(floor(adapter.state().pos)) === 'ladder';
    const start = adapter.state().pos.y;
    // 同一逻辑动作的共享额度账本：跨顶层/重试/恢复共享，确认爬升才入账，取消/失败也保留。
    const budget = ctx.climb;
    // 首次派发时记录逻辑起点；父委托目标 = 从逻辑起点净升高 height。
    if (budget && !Number.isFinite(budget.startY)) budget.startY = Math.floor(start);
    const remainingSpend = budget ? Math.max(0, budget.height - budget.spent) : args.height;
    const effectiveHeight = Math.min(args.height, remainingSpend);
    // 父动作续跑（经仲裁器派发、无恢复上下文）按父目标验收；恢复子动作按自身 args.height 验收。
    const isParentContinuation = !!budget && ctx.recovery === undefined;
    const netFromStart = () => Math.max(0, Math.floor(adapter.state().pos.y + 0.05) - Math.floor((budget ? budget.startY : start) + 0.05));
    // 身体是否在有效支撑上：站立（onGround）或贴着梯子（梯子上的有效攀爬可以 onGround=false）。
    const landed = () => {
      const state = adapter.state();
      const feet = Math.floor(state.pos.y + 0.05);
      return state.onGround || adapter.blockAt({ x: Math.floor(state.pos.x), y: feet, z: Math.floor(state.pos.z) }) === 'ladder';
    };
    // 确认一次单级转换真正完成：身体在有效支撑上且净高度确实升高，不把空中的瞬时高度当落点。
    const confirmedAscent = (fromY: number) => landed() && Math.floor(adapter.state().pos.y + 0.05) > Math.floor(fromY) && adapter.state().pos.y > fromY + 0.05;
    // moveTo 可能在上跳过程中返回（甚至报 no path）；此时身体还在空中，不能立即判失败。
    // 有界等待真实落地，再按“是否站高”结算；超时仍未落地则如实失败。
    const waitForLanding = async (fromY: number, timeoutMs = 1500, waitSignal: AbortSignal = signal) => {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        throwIfAborted(waitSignal);
        if (confirmedAscent(fromY)) return true;
        if (adapter.state().onGround) return false;
        await sleep(50, waitSignal);
      }
      return confirmedAscent(fromY);
    };
    // 只能用 Agent 背包里真实存在、且本身体允许垫脚的方块名；不临时制造/替换材料。
    const placeableNames = () => adapter.state().inventory
      .filter((item) => item.count > 0 && PLACEABLE.includes(item.name)).map((item) => item.name);
    let climbedThisRun = 0;
    const total = () => (budget ? budget.spent : climbedThisRun);
    const reached = (around: ReturnType<typeof surroundings>) => (!args.untilSky || around.sky) && (!args.untilExit || around.exits.length > 0);
    // 结构化效果回执：区分本次/净进展（climbed）、累计消耗（spent）与目标是否达成（goalReached），成功/失败/取消共用。
    const currentFacts = (failureCause?: 'PILLAR_CLEARANCE', detail?: { clearanceDetail?: string; pillarClearance?: unknown }) => {
      const state = adapter.state(), around = surroundings(adapter);
      // 父动作续跑时按净高度报进展；但取消/超时可能停在半空，未站稳时不能把瞬时高度
      // 算成已确认爬升——以累计确认额度为上界，避免伪造未发生的效果。
      const climbed = !isParentContinuation ? climbedThisRun
        : landed() ? netFromStart() : Math.min(netFromStart(), budget!.spent);
      const goalReached = args.untilSky || args.untilExit ? reached(around) : isParentContinuation ? landed() && netFromStart() >= budget!.height : climbedThisRun >= args.height;
      return { climbed, spent: total(), height: budget?.height ?? args.height, sky: around.sky, exits: around.exits, goalReached, position: { ...state.pos }, ...(failureCause ? { failureCause } : {}),
        ...(detail?.clearanceDetail ? { clearanceDetail: detail.clearanceDetail } : {}),
        ...(detail?.pillarClearance ? { pillarClearance: detail.pillarClearance } : {}),
        effectEvidence: { verified: true, changed: climbedThisRun > 0, reasons: [`实际高度 ${start} → ${state.pos.y}`] } };
    };
    const finish = (stopped?: string, failureCause?: 'PILLAR_CLEARANCE', detail?: { clearanceDetail?: string; pillarClearance?: unknown }) => {
      const facts = currentFacts(failureCause, detail);
      if (facts.goalReached) return ok(`往上爬了 ${facts.climbed} 格${args.untilExit ? '，四周有路了' : args.untilSky ? '，看得见天空了' : ''}`, facts);
      if (!facts.climbed) return fail('STUCK', `未实际爬升${stopped ? `：${stopped}` : '，没有完成垫高'}`, facts);
      return fail('STUCK', `往上爬了 ${facts.climbed} 格后停下：${stopped ?? '已到本次高度或时间上限，仍未满足停止条件'}`, facts);
    };
    const initial = surroundings(adapter);
    if ((args.untilSky || args.untilExit) && reached(initial)) {
      // 已经满足停止条件：没有垫高是对的，但要说清楚，免得以为“爬不上去”
      return ok(`${args.untilExit ? '四周已经有路可走' : '已经看得见天空'}，所以没有垫高；如果是想站上坑沿，用 {"height":2} 这样直接指定格数`,
        { climbed: 0, alreadySatisfied: true, sky: initial.sky, exits: initial.exits });
    }
    // 父委托额度已用完：无需材料，直接按目标验收（达成则完成，未达成则交回）。
    if (effectiveHeight <= 0) return finish('本次授权的高度额度已用完');
    // 只有确实要继续爬时才需要材料。
    if (!onLadder() && !hasPlaceable(adapter.state().inventory)) return fail('MISSING_MATERIALS', '脚下没有梯子，背包里也没有能垫脚的方块（泥土/圆石/石头/木板）');
    let lastBeforeY: number | undefined;
    // 单级转换的成功、失败、取消及清障重试共用一次结算：身体已在有效支撑上站高才算入账。
    // 实际效果始终结算（无论有无预算）；只有累计预算的更新依赖预算对象存在。
    const settlePending = () => {
      if (lastBeforeY !== undefined && confirmedAscent(lastBeforeY)) {
        climbedThisRun++;
        if (budget) budget.spent++;
        lastBeforeY = undefined;
      }
    };
    try {
      for (let i = 0; i < effectiveHeight && Date.now() < deadline - 1000; i++) {
        throwIfAborted(signal);
        const here = surroundings(adapter);
        if ((args.untilSky || args.untilExit) && reached(here)) break;
        const before = adapter.state().pos, me = floor(before), climbedBefore = climbedThisRun;
        lastBeforeY = before.y;
        // 头顶的方块先挖开（不挖液体旁边的）
        try {
          await breakCell(ctx, { x: me.x, y: me.y + 2, z: me.z });
        } catch (e) {
          if (isAbort(e)) throw e;
          return finish(why(e));
        }
        // 清障可能已经吃掉期限：到期后不再发起新的梯子移动/垫高。
        if (Date.now() >= deadline) {
          settlePending();
          return finish('本次时间预算已用完');
        }
        const opSignal = operationSignal();
        if (onLadder()) {
          // 脚下是梯子：只沿已复验的梯子格列升一格，不挖、不放、不绕行。
          try {
            await adapter.moveTo({ kind: 'ladder', x: me.x, y: me.y + 1, z: me.z },
              { signal: opSignal, timeoutMs: Math.max(1, Math.min(8000, deadline - Date.now())) });
          } catch (e) {
            if (isAbort(e)) throw e;
            await waitForLanding(before.y, 1500, opSignal);
            settlePending();
            return finish(why(e));
          }
        } else {
          // 没有梯子：显式原地垫一块。适配器报告真实的净空、放置与站立事实，不把“动作返回”当成已经爬上去。
          if (typeof adapter.pillarUp !== 'function') return finish('当前适配器没有原地垫高能力');
          let names = placeableNames();
          if (names.length === 0) return finish('背包里没有可垫脚方块');
          let pillar = await adapter.pillarUp(names, opSignal);
          throwIfAborted(signal);
          // 跳跃净空被挡：用 climb_up 明确授权的清障挖开报告的那一格，再垫一次；仍挡住就如实带回完整净空事实。
          const fallingBack = pillar.ok ? undefined : pillar.clearance;
          const facing = fallingBack?.facing, rel = fallingBack?.at;
          if (rel && (facing === 'N' || facing === 'E' || facing === 'S' || facing === 'W')) {
            const blocked = toWorld(feetCell(adapter.state().pos), facing, rel);
            if (adapter.blockAt(blocked) !== null) {
              // 期限已到：不再挖新格、不再发起第二次垫高。
              if (Date.now() >= deadline || opSignal.aborted) {
                settlePending();
                const detail = pillar.clearanceDetail ? `；${pillar.clearanceDetail}` : '';
                return finish(`${pillar.reason ?? '原地垫高未成功'}${detail}`, pillar.clearance ? 'PILLAR_CLEARANCE' : undefined,
                  { clearanceDetail: pillar.clearanceDetail, pillarClearance: pillar.clearance });
              }
              try {
                await breakCell(ctx, blocked);
              } catch (e) {
                if (isAbort(e)) throw e;
                return finish(why(e), 'PILLAR_CLEARANCE', { clearanceDetail: pillar.clearanceDetail, pillarClearance: pillar.clearance });
              }
              names = placeableNames();
              if (names.length > 0) {
                throwIfAborted(signal);
                if (Date.now() < deadline) {
                  pillar = await adapter.pillarUp(names, operationSignal());
                  throwIfAborted(signal);
                }
              }
            }
          }
          if (!pillar.ok) {
            settlePending();
            const detail = pillar.clearanceDetail ? `；${pillar.clearanceDetail}` : '';
            return finish(`${pillar.reason ?? '原地垫高未成功'}${detail}`, pillar.clearance ? 'PILLAR_CLEARANCE' : undefined,
              { clearanceDetail: pillar.clearanceDetail, pillarClearance: pillar.clearance });
          }
        }
        // 适配器可能在期限后才返回；到期时不再等待落地或发起下一步，但已确认的爬升仍入账。
        if (Date.now() >= deadline) {
          settlePending();
          return finish('本次时间预算已用完');
        }
        throwIfAborted(operationSignal());
        // 只有实测站在有效支撑上且高度确实上升，才算完成这一级。
        await waitForLanding(before.y, 1500, operationSignal());
        settlePending();
        if (climbedThisRun === climbedBefore) return finish('移动已结束，但脚下没有实际站高');
        ctx.senses.refresh();
        if (!onLadder() && !hasPlaceable(adapter.state().inventory)) break;
      }
      throwIfAborted(signal);
      return finish();
    } catch (e) {
      settlePending();
      if (isAbort(e)) (e as Error & { partial?: Record<string, unknown> }).partial = currentFacts();
      throw e;
    }
  },
};
