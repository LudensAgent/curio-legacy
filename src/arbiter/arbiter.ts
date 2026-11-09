import { EventEmitter } from 'node:events';
import type { AgentState, GameAdapter, Vec3Like } from '../adapter/types.ts';
import type { EventBus } from '../events.ts';
import type { WorldMemory } from '../memory/store.ts';
import type { SharedSpatialSession } from '../spatial/shared-session.ts';
import { SKILLS } from '../skills/index.ts';
import { isSkillDisabled } from '../skills/disabled.ts';
import { runSkill, validateSkill, type FailureCode, type Senses, type SkillResult } from '../skills/types.ts';
import { AbortedError, shortId } from '../util.ts';
import { availableInventoryFor, craftReservationConflict, reservationsFor } from '../projects/reservations.ts';
import { config } from '../config.ts';
import { fuelBurn } from '../methods/fuel.ts';

export type TaskSource = 'llm' | 'rule' | 'filler' | 'reflex' | 'user';
/** 谁产生了这一步：Agent 的选择、执行辅助的自动插步，还是独立调度（反射/填充）。 */
export type TaskOrigin = 'agent' | 'execution_helper' | 'scheduler';
/** 自动插步的授权链：它是在执行哪个原步骤授予的能力/目标。 */
export interface StepAuthorization {
  skill: string;
  stepId?: string;
  args?: unknown;
}

export interface Step {
  skill: string;
  args?: unknown;
  /** 逻辑动作实例；同参数的不同动作也能区分，跨重试稳定。 */
  id?: string;
  origin?: TaskOrigin;
  authorizedBy?: StepAuthorization;
}

export interface TaskInfo {
  id: string;
  planVersion: number;
  skill: string;
  args: unknown;
  /** 进入校验前的原始参数；`args` 是校验后的规范化参数。 */
  requestedArgs?: unknown;
  source: TaskSource;
  origin?: TaskOrigin;
  stepId?: string;
  authorizedBy?: StepAuthorization;
  startedAt: number;
  deadline: number;
  progress: number;
  note: string;
  movement: boolean;
  stationaryWait?: boolean;
  planId?: string;
}

export interface TaskOutcome {
  task: TaskInfo;
  result: SkillResult;
  durationMs: number;
  preemptedBy?: TaskSource;
  /** 被“顺手”的短动作（如插火把）打断：恢复时不计入重试次数 */
  gentle?: boolean;
}

/** 派发/结算时实测到的作用域与位置；读取失败时整段为 null，不用默认值补齐。 */
export interface TaskScopeMeasurement {
  worldId: string;
  dim: string;
  sessionId: string;
  /** 这次测量发生的真实时间（不是任务开始/结束时间本身）。 */
  at: number;
  pos: Vec3Like;
}

/**
 * 一次已结算任务的实测事实，仅交给显式注入的生产者接缝（默认不存在）。
 * `startScope` 是派发时读到的真实状态；`endScope` 只有结束回调仍拥有该
 * planVersion 时才有测量，迟到回调为 null，绝不拿新任务的现场补旧任务。
 */
export interface TaskCompletionFact {
  task: TaskInfo;
  result: SkillResult;
  endedAt: number;
  durationMs: number;
  startScope: TaskScopeMeasurement | null;
  endScope: TaskScopeMeasurement | null;
  lateCompletion: boolean;
  preemptedBy?: TaskSource;
}

/** Emitted synchronously after control transfers, before either skill can finish. */
export interface TaskPreemption {
  task: TaskInfo;
  replacement: TaskInfo;
  gentle?: boolean;
}

interface Running extends TaskInfo {
  controller: AbortController;
  cancelCode?: FailureCode;
  cancelReason?: string;
  preemptedBy?: TaskSource;
  gentle?: boolean;
}

/** 会修改游戏世界或角色状态的方法：任务被取消后，旧任务再调用这些方法会被拦截。 */
/** 会“透视”的原始查询：技能必须改用 ctx.senses（看见/听见/记得的东西）。 */
// lightAt 不在其中：身边的明暗是看得出来的。
// blockOptics 也不在其中：它只补充碰撞形状（半砖/雪层/箱子/堆肥桶等），是执行
// 已记录路线所需的几何；agent 自己写的代码技能在 sandbox 里只能拿到 api，拿不到
// 原始 adapter，不能借它透视。把它一起禁掉会让 follow_passage 在路线预检时直接
// 抛出 NO_XRAY，整条已记录路线都用不了。
const XRAY_METHODS = new Set(['findBlocks', 'nearbyEntities']);
const ACTION_METHODS = new Set(['moveTo', 'dig', 'placeBlockAt', 'placeBlockStateAt', 'equipItem', 'tossItem', 'arrangeHotbar', 'useGui', 'tradeWith', 'useBlockAt', 'useItem', 'rangedAttack', 'enterPortalAt', 'collectNearbyDrops', 'craft', 'sleepInBed', 'smelt', 'useChest', 'till', 'plant', 'eat', 'equipWeapon', 'attack', 'look', 'jump', 'swimTo', 'diveTo', 'pillarUp', 'drive', 'raiseShield', 'startDraw', 'releaseDraw', 'signText', 'editBook', 'chat', 'stopAll', 'fish', 'useItemOn', 'useBucketAt', 'interactEntity', 'ride', 'dismount', 'emptyFurnace', 'walkBody', 'walkTick']);

/**
 * 动作仲裁器：任意时刻只有一个任务拥有角色控制权。
 * - 每个任务有递增的 planVersion 和自己的 AbortSignal
 * - 取消/抢占时立即释放所有控制（stopAll）
 * - 旧任务的适配器被“守卫代理”包裹：取消后再发动作直接抛 AbortedError，并计入 blockedActions
 */
export class Arbiter extends EventEmitter {
  current: Running | null = null;
  private version = 0;
  blockedActions = 0;
  private pausedFlag = false;
  private disposeLifecycle: (() => void) | null = null;

  get paused() { return this.pausedFlag; }

  setPaused(paused: boolean) {
    this.pausedFlag = paused;
    try {
      // 暂停/恢复边界即使在零观测间隔也必须进入共享空间记忆；不依赖 Mind 事件或轮询。
      this.spatial?.setPaused(paused);
    } finally {
      // 即使共享服务在取消回调里抛错，也必须完成原来的取消与 stopAll；错误原样上抛。
      if (paused) {
        this.cancel('paused');
        this.adapter.stopAll();
      }
    }
  }

  /**
   * 正常关停专用：停止接受新任务并取消当前任务/释放控制，但不把共享会话标记为
   * 暂停。`setPaused` 会作废已接收的 handoff；关停必须让
   * `SharedSpatialSession.shutdown()` 自己应用/报告 pending 并真实 close。
   */
  beginShutdown(): void {
    this.pausedFlag = true;
    this.cancel('退出');
    this.adapter.stopAll();
  }

  constructor(
    private adapter: GameAdapter,
    private memory: WorldMemory,
    private bus: EventBus,
    private senses: Senses,
    private spatial?: SharedSpatialSession,
    /** 可选的生产者接缝；不注入时不读作用域外状态、不写 journal、不创建任何异步资源。 */
    private taskFactProducer?: (fact: TaskCompletionFact) => void,
  ) {
    super();
    if (this.spatial) {
      // 真实会话身份变化只通知共享服务中断；此时绝不回调 adapter.state()（换维会再次触发 newSession）。
      const onSessionReset = () => { this.spatial!.interrupt(); };
      this.adapter.on('session_reset', onSessionReset);
      this.disposeLifecycle = () => { this.adapter.off?.('session_reset', onSessionReset); };
    }
  }

  /** Host/test teardown: remove only the lifecycle listener; never close the shared session here. */
  dispose(): void {
    this.disposeLifecycle?.();
    this.disposeLifecycle = null;
  }

  get planVersion() {
    return this.version;
  }

  info(): TaskInfo | null {
    if (!this.current) return null;
    const { controller, cancelCode, cancelReason, preemptedBy, gentle, ...info } = this.current;
    return info;
  }

  validate(step: Step): { ok: true; args: unknown } | { ok: false; error: string } {
    const skill = SKILLS[step.skill];
    if (!skill) return { ok: false, error: `未知技能：${step.skill}` };
    if (isSkillDisabled(skill.name)) return { ok: false, error: `技能 ${step.skill} 已在控制台禁用；请启用或改用其他技能` };
    // 步骤参数通常来自 validatePlanSkill 的规范化输出；这里会再校验一次，所以 skill.validate 必须
    // 能接受自己返回的 args（幂等）。否则第一次通过、执行前必失败。
    return validateSkill(skill, step.args ?? {}, this.adapter);
  }

  private guard(signal: AbortSignal): GameAdapter {
    const target = this.adapter as any;
    const origin = this.adapter.state();
    return new Proxy(target, {
      get: (t, prop, recv) => {
        const v = Reflect.get(t, prop, recv);
        if (typeof v !== 'function') return v;
        if (XRAY_METHODS.has(String(prop))) {
          return () => {
            throw new Error(`NO_XRAY: 技能不能调用 ${String(prop)}，请使用 ctx.senses`);
          };
        }
        if (ACTION_METHODS.has(String(prop))) {
          return (...args: unknown[]) => {
            const state = this.adapter.state();
            // 收盾（raiseShield(false)）是纯复位动作：guard 技能在 finally 里收盾，任务被取消/抢占后也必须放行，
            // 否则盾卡在举起状态再也放不下（日志「已取消任务试图调用 raiseShield，已拦截」）。只豁免「任务已不再当前」这一层，暂停/换世界等照旧拦截。
            const isShieldLower = String(prop) === 'raiseShield' && args[0] === false;
            const taskGone = signal.aborted || this.current?.controller.signal !== signal;
            if ((taskGone && !isShieldLower) || this.pausedFlag || !state.observationReady || state.worldId !== origin.worldId || state.dim !== origin.dim || state.sessionId !== origin.sessionId) {
              this.blockedActions++;
              this.bus.publish('blocked_action', 'P1', `已取消任务试图调用 ${String(prop)}，已拦截`);
              throw new AbortedError('task cancelled');
            }
            if (this.current?.source !== 'reflex' && reservationsFor(this.memory).list(state.worldId).length) {
              const available = new Map(availableInventoryFor(this.memory, state).map((i) => [i.name, i.count]));
              const requireAvailable = (name: string, count: number) => {
                if (count > (available.get(name) ?? 0)) throw new Error(`RESERVED_MATERIALS:${name}：该动作会消耗其他项目的预留`);
              };
              if (prop === 'craft') {
                const conflict = craftReservationConflict(this.memory, state, String(args[0]), Number(args[1]), config.mc.version);
                if (conflict) throw new Error(`RESERVED_MATERIALS:${conflict.item}：${conflict.reason}`);
              } else if (prop === 'placeBlockAt') {
                const allowed = (args[1] as string[]).filter((name) => (available.get(name) ?? 0) > 0);
                if (!allowed.length) throw new Error('RESERVED_MATERIALS:没有可用于放置的未预留方块');
                args[1] = allowed;
              } else if (prop === 'placeBlockStateAt' || prop === 'plant') requireAvailable(String(args[1]), 1);
              else if (prop === 'useBucketAt') requireAvailable(String(args[1]), 1);
              else if (prop === 'useChest') for (const item of args[1] as { name: string; count: number }[]) requireAvailable(item.name, item.count);
              else if (prop === 'smelt') {
                const input = String(args[0]), amount = Number(args[1]), fuel = String(args[2]);
                requireAvailable(input, amount);
                const per = fuelBurn(fuel) || 1;
                const fuelHeld = state.inventory.find((i) => i.name === fuel)?.count ?? 0;
                requireAvailable(fuel, Math.min(fuelHeld, Math.ceil(amount / per)));
                const furnaceKnown = this.senses.knownBlocks(['furnace', 'blast_furnace', 'smoker'], 5).length > 0;
                if (!furnaceKnown) {
                  if (state.inventory.some((i) => i.name === 'furnace' && i.count > 0)) requireAvailable('furnace', 1);
                  else {
                    const conflict = craftReservationConflict(this.memory, state, 'furnace', 1, config.mc.version);
                    if (conflict) throw new Error(`RESERVED_MATERIALS:${conflict.item}：自动准备熔炉会消耗预留`);
                  }
                }
              } else if (prop === 'sleepInBed') {
                const beds = state.inventory.filter((i) => i.name.endsWith('_bed') && i.count > 0);
                const known = this.senses.knownBlocks(beds.map((i) => i.name), 5);
                if (!known.length && beds.length) requireAvailable(beds[0].name, 1);
              }
              else if (prop === 'useItem' && ['ender_pearl', 'ender_eye'].includes(String(args[0]))) requireAvailable(String(args[0]), 1);
            }
            // These older primitives did not expose a signal. Bind task ownership
            // here so their internal post-await checks also observe cancellation.
            const signalIndex: Record<string, number> = { dig: 1, placeBlockAt: 2, placeBlockStateAt: 3, equipItem: 2, tossItem: 2, arrangeHotbar: 2, useGui: 2, tradeWith: 3, useBlockAt: 2, useItem: 1, rangedAttack: 1, enterPortalAt: 1, collectNearbyDrops: 0, craft: 2, sleepInBed: 0, smelt: 3, useChest: 3, till: 1, plant: 2, eat: 0, equipWeapon: 0, attack: 1, look: 2, jump: 1, swimTo: 1, diveTo: 1, pillarUp: 1, drive: 2, raiseShield: 1, startDraw: 1, releaseDraw: 0, signText: 1, editBook: 2, fish: 0, useItemOn: 2, useBucketAt: 2, interactEntity: 2, ride: 1, dismount: 0, emptyFurnace: 1 };
            if (prop === 'moveTo') {
              const opts = args[1] as { signal?: AbortSignal } | undefined;
              const caller = opts?.signal;
              // 调用方（路段/父委托）信号与任务信号合并，而不是覆盖任一方：
              // 任一取消都以其 reason 中止这次移动。落定后移除监听，长任务不累积。
              const merged = caller && caller !== signal ? mergeAbortSignals(caller, signal) : null;
              args[1] = { ...(opts as object), signal: merged?.signal ?? signal };
              const pending = v.apply(t, args) as Promise<void>;
              return merged ? pending.finally(merged.dispose) : pending;
            }
            if (String(prop) in signalIndex) args[signalIndex[String(prop)]] = signal;
            return v.apply(t, args);
          };
        }
        return v.bind(t);
      },
    }) as GameAdapter;
  }

  /**
   * 启动一个任务。若已有任务在运行，会先抢占（取消）它。
   * 返回 null 表示参数校验失败。
   */
  start(step: Step, source: TaskSource, meta: {
    planId?: string;
    stepId?: string;
    origin?: TaskOrigin;
    authorizedBy?: StepAuthorization;
    gentle?: boolean;
    /** 同一逻辑步骤的自动重试/续跑共享的绝对期限（epoch ms）；只提前，不延后。 */
    deadlineMs?: number;
    climb?: { height: number; spent: number; startY: number };
  } = {}): TaskInfo | { error: string } {
    if (this.pausedFlag) return { error: 'Agent 已暂停' };
    // 关闭中的共享服务不再接受新任务；不自动重试或退回独立地图。
    if (this.spatial?.closing) return { error: '共享空间会话正在关闭，拒绝启动新任务' };
    const v = this.validate(step);
    if (!v.ok) {
      this.bus.publish('task_rejected', 'P1', `${step.skill} 参数无效：${v.error}`, { step, source });
      return { error: v.error };
    }
    const interrupted = this.info();
    if (this.current) this.cancel(`被 ${source} 抢占`, undefined, source, meta.gentle);

    const skill = SKILLS[step.skill];
    const controller = new AbortController();
    const now = Date.now();
    // 父委托给的绝对期限只能缩短本任务，不能延长；未传时保持 skill 自己的 timeoutMs。
    const deadline = meta.deadlineMs === undefined
      ? now + skill.timeoutMs
      : Math.min(now + skill.timeoutMs, meta.deadlineMs);
    // 开始作用域/位置与背包在派发这一刻实测；结束事实只在没有更新任务时才能归给本任务。
    const startState = readState(this.adapter);
    const startedScope = scopeOf(startState, now);
    const invBefore = countsOf(startState?.inventory ?? []);
    const origin = meta.origin ?? (source === 'llm' || source === 'rule' || source === 'user' ? 'agent' : 'scheduler');
    const task: Running = {
      id: shortId('t_'),
      planVersion: ++this.version,
      skill: skill.name,
      args: v.args,
      requestedArgs: step.args ?? {},
      source,
      origin,
      ...(meta.stepId ? { stepId: meta.stepId } : {}),
      ...(meta.authorizedBy ? { authorizedBy: meta.authorizedBy } : {}),
      startedAt: now,
      deadline,
      progress: 0,
      note: '',
      movement: skill.movement,
      planId: meta.planId,
      controller,
    };
    this.current = task;
    if (interrupted) this.emit('preempt', { task: interrupted, replacement: this.info()!, gentle: meta.gentle } satisfies TaskPreemption);
    this.bus.publish('task_start', source === 'filler' ? 'P3' : 'P2', `[${source}] ${skill.name} ${JSON.stringify(v.args)}`, {
      taskId: task.id,
      planVersion: task.planVersion,
      skill: task.skill,
      args: task.args,
      requestedArgs: task.requestedArgs,
      source,
      origin,
      planId: task.planId ?? null,
      stepId: task.stepId ?? null,
      authorizedBy: task.authorizedBy ?? null,
    });

    // 父委托期限是绝对预算，不再向后放宽；只有技能自身 timeoutMs 才保留
    // 2000ms 收尾宽限。期限已过则不新起计时，立即中止。
    const timeoutGraceEnd = meta.deadlineMs === undefined ? task.deadline + 2000 : task.deadline;
    const timeout = timeoutGraceEnd <= Date.now()
      ? (controller.abort('TIMEOUT'), null)
      : setTimeout(() => controller.abort('TIMEOUT'), timeoutGraceEnd - Date.now());
    const ctx = {
      adapter: this.guard(controller.signal),
      senses: this.senses,
      memory: this.memory,
      bus: this.bus,
      signal: controller.signal,
      deadline: task.deadline,
      taskId: task.id,
      progress: (p: number, note?: string) => {
        if (this.current?.id !== task.id) return;
        task.progress = Math.max(0, Math.min(1, p));
        if (note) task.note = note;
      },
      setStationaryWait: (waiting: boolean) => { task.stationaryWait = waiting; },
      ...(meta.climb ? { climb: meta.climb } : {}),
      ...(this.spatial ? { spatial: this.spatial } : {}),
    };

    runSkill(ctx, skill, v.args as { make?: boolean })
      .catch((e: any): SkillResult => {
        if (e?.name === 'AbortedError') {
          const partial = e?.partial && typeof e.partial === 'object' ? e.partial : undefined;
          // 技能可在取消时附一句已发生的实测事实（progressNote），让心智不用翻 data 就知道被打断时走到了哪。
          const note = typeof partial?.progressNote === 'string' ? `；${partial.progressNote}` : '';
          return { status: 'cancelled', summary: `${String(controller.signal.reason ?? '已取消')}${note}`, ...(partial ? { data: partial } : {}) };
        }
        return { status: 'failed', failureCode: 'ERROR', summary: String(e?.message ?? e) };
      })
      .then((result) => {
        if (timeout !== null) clearTimeout(timeout);
        if (controller.signal.reason === 'TIMEOUT' && (result.status === 'cancelled' || result.status === 'succeeded')) {
          // 已过期限的执行不能因为技能忽略 abort 或恰好收尾就改报成功；保留已发生的数据。
          result = { status: 'failed', failureCode: 'TIMEOUT', summary: `${skill.name} 超时`, ...(result.data ? { data: result.data } : {}) };
        }
        if (controller.signal.aborted && controller.signal.reason !== 'TIMEOUT' && result.status === 'succeeded') {
          result = { status: 'cancelled', summary: `${skill.name} 已被取消（结果作废）`, ...(result.data ? { data: result.data } : {}) };
        }
        if (task.cancelCode && result.status !== 'succeeded') {
          result = { status: 'failed', failureCode: task.cancelCode, summary: `${skill.name} 失败：${task.cancelCode}${task.cancelReason ? `（${task.cancelReason}）` : ''}`, ...(result.data ? { data: result.data } : {}) };
        }
        if (this.current?.id === task.id) {
          this.current = null;
          this.adapter.stopAll();
        }
        const endedAt = Date.now();
        const durationMs = endedAt - task.startedAt;
        // 取消/超时的迟到回调可能在新任务已经开始后才落定。只有期间没有新 planVersion 时，
        // 当前 adapter 状态和背包才还能归给这个任务；否则保留结果数据里的实测事实，末状态记 null。
        const stillOwned = this.version === task.planVersion;
        const endState = stillOwned ? readState(this.adapter) : null;
        const endScope = stillOwned ? scopeOf(endState, endedAt) : null;
        const invAfter = endState ? countsOf(endState.inventory) : null;
        const resultData = result.data && typeof result.data === 'object' ? result.data as Record<string, unknown> : undefined;
        const measured = resultData ? lastPositionOf(resultData) : null;
        const resolved = resultData ? resolvedTargetOf(resultData) : null;
        // 动作顺手用掉、结果里又没提到的东西（自动做的工作台、熔炉、船、镐子、火把、烧掉的燃料……）：如实补一句。
        // 迟到回调不拿新任务的背包补摘要，避免把别人的消耗记到旧动作头上。
        if (stillOwned && invAfter && source !== 'filler') {
          const spent = spentNote(invBefore, invAfter, result.summary);
          if (spent) result = { ...result, summary: `${result.summary}${spent}` };
        }
        this.memory.recordSkill(skill.name, result.status, result.failureCode);
        const sev = result.status === 'failed' ? 'P1' : source === 'filler' ? 'P3' : 'P2';
        this.bus.publish('task_end', sev, `[${source}] ${skill.name} → ${result.status}${result.failureCode ? `(${result.failureCode})` : ''}：${result.summary}`, {
          // 保留原有字段，供既有观察/记账/学习消费者继续使用。
          taskId: task.id,
          durationMs,
          status: result.status,
          failureCode: result.failureCode,
          skill: task.skill,
          summary: result.summary,
          source,
          // 结构化委托事实：任何入口的取消/超时/失败/嵌套都落到同一份父委托身份上。
          planId: task.planId ?? null,
          planVersion: task.planVersion,
          stepId: task.stepId ?? null,
          origin: task.origin ?? originOfSource(task.source),
          authorizedBy: task.authorizedBy ?? null,
          // 当前调用链没有“任务派发任务”的父子 Arbiter；嵌套 use_skill/代码技能共享本任务 id。
          parentTaskId: null,
          startedAt: task.startedAt,
          deadline: task.deadline,
          args: task.requestedArgs ?? task.args,
          normalizedArgs: task.args,
          budget: {
            deadline: task.deadline,
            climb: meta.climb ? { ...meta.climb } : null,
            make: typeof (task.args as { make?: unknown } | null)?.make === 'boolean' ? (task.args as { make: boolean }).make : null,
          },
          scope: {
            start: startedScope,
            end: endScope,
          },
          lateCompletion: !stillOwned,
          // 只报实测位置，绝不拿目标或请求坐标补齐。
          lastPosition: endState ? { ...endState.pos } : measured?.position ?? null,
          lastPositionFrom: endState ? 'adapter.state' : measured?.from ?? null,
          // 解析目标只在技能明确返回目标字段时填写；position/lastPosition 不能冒充目标。
          resolvedTarget: resolved?.target ?? null,
          resolvedTargetFrom: resolved?.from ?? null,
          // 结构化消费：背包实际增减；开始或结束背包没有实测、或迟到回调时未知，明确 null。
          inventoryDiff: startedScope && invAfter ? diffCounts(invBefore, invAfter) : null,
          // 结果/部分效果原样保留（取消、超时、STUCK 都不改写已确认 data）。
          data: result.data ?? null,
          // 动作声明的持续效果（比如扔掉的东西几分钟内不该回到手上）：交给 EffectWatch 盯着
          ...(result.status === 'succeeded' && result.data?.expect ? { expect: result.data.expect } : {}),
        });
        const { controller: _c, cancelCode: _cc, cancelReason: _cr, preemptedBy, gentle, ...info } = task;
        // 可选的生产者接缝：默认未注入时这里完全不执行。生产者只收到实际测到的
        // 开始/结束作用域和已结算结果；它不能反过来改写 result/task 或关停流程。
        if (this.taskFactProducer) {
          try {
            this.taskFactProducer({
              task: info,
              result,
              endedAt,
              durationMs,
              startScope: startedScope,
              endScope,
              lateCompletion: !stillOwned,
              ...(preemptedBy !== undefined ? { preemptedBy } : {}),
            });
          } catch (error) {
            this.bus.publish('spatial_journal_producer_failed', 'P1',
              `任务事实生产者失败：${error instanceof Error ? error.message : String(error)}`,
              { taskId: task.id, skill: task.skill });
          }
        }
        this.emit('done', { task: info, result, durationMs, preemptedBy, gentle } satisfies TaskOutcome);
      });

    const { controller: _c, gentle: _g, ...info } = task;
    return info;
  }

  /** 取消当前任务并立即释放控制。asFailure 让取消计为失败（例如卡死）。 */
  cancel(reason: string, asFailure?: FailureCode, preemptedBy?: TaskSource, gentle?: boolean) {
    const t = this.current;
    if (!t) return;
    t.cancelCode = asFailure;
    if (asFailure) t.cancelReason = reason;
    t.preemptedBy = preemptedBy;
    t.gentle = gentle;
    this.current = null;
    t.controller.abort(reason);
    this.adapter.stopAll();
  }
}

/**
 * 合并调用方信号与任务信号：任一方中止都以它的 reason 中止合并信号。
 * `dispose` 移除来源监听；调用方在动作落定后调用，避免长任务上累积监听。
 */
function mergeAbortSignals(a: AbortSignal, b: AbortSignal) {
  const controller = new AbortController();
  const dispose = () => {
    a.removeEventListener('abort', onAbort);
    b.removeEventListener('abort', onAbort);
  };
  const onAbort = (event: Event) => {
    dispose();
    controller.abort((event.target as AbortSignal).reason);
  };
  a.addEventListener('abort', onAbort, { once: true });
  b.addEventListener('abort', onAbort, { once: true });
  // 装好监听后复核：任何在装监听前就已中止的来源都不会再派发事件。
  const alreadyAborted = a.aborted ? a : b.aborted ? b : null;
  if (alreadyAborted) {
    dispose();
    controller.abort(alreadyAborted.reason);
  }
  return { signal: controller.signal, dispose };
}

function originOfSource(source: TaskSource): TaskOrigin {
  return source === 'llm' || source === 'rule' || source === 'user' ? 'agent' : 'scheduler';
}

/** Adapter state is a measurement boundary: unavailable state stays absent, never synthesized. */
function readState(adapter: GameAdapter): AgentState | null {
  try { return adapter.state(); } catch { return null; }
}

function scopeOf(state: AgentState | null, at: number): TaskScopeMeasurement | null {
  return state ? { worldId: state.worldId, dim: state.dim, sessionId: state.sessionId, at, pos: { ...state.pos } } : null;
}

function countsOf(inventory: readonly { name: string; count: number }[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const i of inventory) m.set(i.name, (m.get(i.name) ?? 0) + i.count);
  return m;
}

function diffCounts(before: Map<string, number>, after: Map<string, number>) {
  const gained: Record<string, number> = {}, lost: Record<string, number> = {};
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const d = (after.get(name) ?? 0) - (before.get(name) ?? 0);
    if (d > 0) gained[name] = d; else if (d < 0) lost[name] = -d;
  }
  return { gained, lost };
}

/** Only finite world coordinates; arrays and partial objects are not coordinates. */
function pointOf(value: unknown): Vec3Like | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const point = value as Record<string, unknown>;
  return ['x', 'y', 'z'].every((key) => typeof point[key] === 'number' && Number.isFinite(point[key]))
    ? { x: point.x as number, y: point.y as number, z: point.z as number } : null;
}

/** 技能显式返回的目标字段；不把 position/lastPosition 当目标。 */
function resolvedTargetOf(data: Record<string, unknown>): { target: Vec3Like; from: string } | null {
  // Newer navigation envelopes carry the explicit resolved target; it is the
  // authoritative fact when present.
  const resolved = pointOf(data.resolvedTarget);
  if (resolved) return { target: resolved, from: 'data.resolvedTarget' };
  const target = pointOf(data.target);
  if (target) return { target, from: 'data.target' };
  const cell = pointOf(data.targetCell);
  return cell ? { target: cell, from: 'data.targetCell' } : null;
}

/** 结果里明确记录的最后实测位置；来源写清楚，避免和请求坐标或当前身体混淆。 */
function lastPositionOf(data: Record<string, unknown>): { position: Vec3Like; from: string } | null {
  const direct = pointOf(data.position);
  if (direct) return { position: direct, from: 'data.position' };
  const pos = pointOf(data.pos);
  if (pos) return { position: pos, from: 'data.pos' };
  const nav = data.nav && typeof data.nav === 'object' ? data.nav as Record<string, unknown> : null;
  const navLast = pointOf(nav?.lastPosition);
  if (navLast) return { position: navLast, from: 'data.nav.lastPosition' };
  const last = pointOf(data.lastPosition);
  return last ? { position: last, from: 'data.lastPosition' } : null;
}

/** 背包里少了、结果里又没提到的东西：“；顺带用掉了 oak_planks×5、coal×1” */
export function spentNote(before: Map<string, number>, after: Map<string, number>, summary: string): string {
  const out: string[] = [];
  for (const [name, n] of before) {
    const d = n - (after.get(name) ?? 0);
    if (d > 0 && !summary.includes(name)) out.push(`${name}×${d}`);
  }
  return out.length ? `；顺带用掉了 ${out.slice(0, 8).join('、')}${out.length > 8 ? ` 等 ${out.length} 样` : ''}` : '';
}
