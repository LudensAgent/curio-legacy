import { EventEmitter } from 'node:events';
import type { GameAdapter } from '../adapter/types.ts';
import type { EventBus } from '../events.ts';
import type { WorldMemory } from '../memory/store.ts';
import { SKILLS } from '../skills/index.ts';
import { isSkillDisabled } from '../skills/disabled.ts';
import { runSkill, validateSkill, type FailureCode, type Senses, type SkillResult } from '../skills/types.ts';
import { AbortedError, shortId } from '../util.ts';
import { availableInventoryFor, craftReservationConflict, reservationsFor } from '../projects/reservations.ts';
import { config } from '../config.ts';
import { fuelBurn } from '../methods/fuel.ts';

export type TaskSource = 'llm' | 'rule' | 'filler' | 'reflex' | 'user';

export interface Step {
  skill: string;
  args?: unknown;
}

export interface TaskInfo {
  id: string;
  planVersion: number;
  skill: string;
  args: unknown;
  source: TaskSource;
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
// lightAt 不在其中：身边的明暗是看得出来的
const XRAY_METHODS = new Set(['findBlocks', 'nearbyEntities', 'blockOptics']);
const ACTION_METHODS = new Set(['moveTo', 'dig', 'placeBlockAt', 'placeBlockStateAt', 'equipItem', 'tossItem', 'arrangeHotbar', 'useGui', 'tradeWith', 'useBlockAt', 'useItem', 'rangedAttack', 'enterPortalAt', 'collectNearbyDrops', 'craft', 'sleepInBed', 'smelt', 'useChest', 'till', 'plant', 'eat', 'equipWeapon', 'attack', 'look', 'jump', 'swimTo', 'diveTo', 'pillarUp', 'drive', 'raiseShield', 'startDraw', 'releaseDraw', 'signText', 'editBook', 'chat', 'stopAll', 'fish', 'useItemOn', 'useBucketAt', 'interactEntity', 'ride', 'dismount', 'emptyFurnace']);

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

  get paused() { return this.pausedFlag; }

  setPaused(paused: boolean) {
    this.pausedFlag = paused;
    if (paused) {
      this.cancel('paused');
      this.adapter.stopAll();
    }
  }

  constructor(private adapter: GameAdapter, private memory: WorldMemory, private bus: EventBus, private senses: Senses) {
    super();
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
            if (prop === 'moveTo') args[1] = { ...(args[1] as object), signal };
            else if (String(prop) in signalIndex) args[signalIndex[String(prop)]] = signal;
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
  start(step: Step, source: TaskSource, meta: { planId?: string; gentle?: boolean; climb?: { height: number; spent: number; startY: number } } = {}): TaskInfo | { error: string } {
    if (this.pausedFlag) return { error: 'Agent 已暂停' };
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
    const task: Running = {
      id: shortId('t_'),
      planVersion: ++this.version,
      skill: skill.name,
      args: v.args,
      source,
      startedAt: now,
      deadline: now + skill.timeoutMs,
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
      source,
    });

    const timeout = setTimeout(() => controller.abort('TIMEOUT'), skill.timeoutMs + 2000);
    const invBefore = inventoryCounts(this.adapter);
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
    };

    runSkill(ctx, skill, v.args as { make?: boolean })
      .catch((e: any): SkillResult => {
        if (e?.name === 'AbortedError') {
          const partial = e?.partial && typeof e.partial === 'object' ? e.partial : undefined;
          return { status: 'cancelled', summary: String(controller.signal.reason ?? '已取消'), ...(partial ? { data: partial } : {}) };
        }
        return { status: 'failed', failureCode: 'ERROR', summary: String(e?.message ?? e) };
      })
      .then((result) => {
        clearTimeout(timeout);
        if (controller.signal.reason === 'TIMEOUT' && result.status === 'cancelled') {
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
        const durationMs = Date.now() - task.startedAt;
        // 动作顺手用掉、结果里又没提到的东西（自动做的工作台、熔炉、船、镐子、火把、烧掉的燃料……）：如实补一句
        if (source !== 'filler') { const spent = spentNote(invBefore, inventoryCounts(this.adapter), result.summary); if (spent) result = { ...result, summary: `${result.summary}${spent}` }; }
        this.memory.recordSkill(skill.name, result.status, result.failureCode);
        const sev = result.status === 'failed' ? 'P1' : source === 'filler' ? 'P3' : 'P2';
        this.bus.publish('task_end', sev, `[${source}] ${skill.name} → ${result.status}${result.failureCode ? `(${result.failureCode})` : ''}：${result.summary}`, {
          taskId: task.id,
          durationMs,
          status: result.status,
          failureCode: result.failureCode,
          skill: task.skill,
          summary: result.summary,
          source,
          // 动作声明的持续效果（比如扔掉的东西几分钟内不该回到手上）：交给 EffectWatch 盯着
          ...(result.status === 'succeeded' && result.data?.expect ? { expect: result.data.expect } : {}),
        });
        const { controller: _c, cancelCode: _cc, cancelReason: _cr, preemptedBy, gentle, ...info } = task;
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

function inventoryCounts(adapter: GameAdapter): Map<string, number> {
  const m = new Map<string, number>();
  try { for (const i of adapter.state().inventory) m.set(i.name, (m.get(i.name) ?? 0) + i.count); } catch { /* 状态暂不可用 */ }
  return m;
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
