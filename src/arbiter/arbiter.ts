import { EventEmitter } from 'node:events';
import type { GameAdapter } from '../adapter/types.ts';
import type { EventBus } from '../events.ts';
import type { WorldMemory } from '../memory/store.ts';
import { SKILLS } from '../skills/index.ts';
import type { FailureCode, SkillResult } from '../skills/types.ts';
import { AbortedError, shortId } from '../util.ts';

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
  planId?: string;
}

export interface TaskOutcome {
  task: TaskInfo;
  result: SkillResult;
  durationMs: number;
  preemptedBy?: TaskSource;
}

interface Running extends TaskInfo {
  controller: AbortController;
  cancelCode?: FailureCode;
  preemptedBy?: TaskSource;
}

/** 会修改游戏世界或角色状态的方法：任务被取消后，旧任务再调用这些方法会被拦截。 */
const ACTION_METHODS = new Set(['moveTo', 'dig', 'collectNearbyDrops', 'craft', 'eat', 'equipWeapon', 'attack', 'look', 'jump', 'chat']);

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

  constructor(private adapter: GameAdapter, private memory: WorldMemory, private bus: EventBus) {
    super();
  }

  get planVersion() {
    return this.version;
  }

  info(): TaskInfo | null {
    if (!this.current) return null;
    const { controller, cancelCode, preemptedBy, ...info } = this.current;
    return info;
  }

  validate(step: Step): { ok: true; args: unknown } | { ok: false; error: string } {
    const skill = SKILLS[step.skill];
    if (!skill) return { ok: false, error: `未知技能：${step.skill}` };
    return skill.validate(step.args ?? {}, this.adapter);
  }

  private guard(signal: AbortSignal): GameAdapter {
    const target = this.adapter as any;
    return new Proxy(target, {
      get: (t, prop, recv) => {
        const v = Reflect.get(t, prop, recv);
        if (typeof v !== 'function') return v;
        if (ACTION_METHODS.has(String(prop))) {
          return (...args: unknown[]) => {
            if (signal.aborted) {
              this.blockedActions++;
              this.bus.publish('blocked_action', 'P1', `已取消任务试图调用 ${String(prop)}，已拦截`);
              throw new AbortedError('task cancelled');
            }
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
  start(step: Step, source: TaskSource, meta: { planId?: string } = {}): TaskInfo | { error: string } {
    const v = this.validate(step);
    if (!v.ok) {
      this.bus.publish('task_rejected', 'P1', `${step.skill} 参数无效：${v.error}`, { step, source });
      return { error: v.error };
    }
    if (this.current) this.cancel(`被 ${source} 抢占`, undefined, source);

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
    this.bus.publish('task_start', source === 'filler' ? 'P3' : 'P2', `[${source}] ${skill.name} ${JSON.stringify(v.args)}`, {
      taskId: task.id,
      planVersion: task.planVersion,
    });

    const timeout = setTimeout(() => controller.abort('TIMEOUT'), skill.timeoutMs + 2000);
    const ctx = {
      adapter: this.guard(controller.signal),
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
    };

    skill
      .run(ctx, v.args)
      .catch((e: any): SkillResult => {
        if (e?.name === 'AbortedError') return { status: 'cancelled', summary: String(controller.signal.reason ?? '已取消') };
        return { status: 'failed', failureCode: 'ERROR', summary: String(e?.message ?? e) };
      })
      .then((result) => {
        clearTimeout(timeout);
        if (controller.signal.reason === 'TIMEOUT' && result.status === 'cancelled') {
          result = { status: 'failed', failureCode: 'TIMEOUT', summary: `${skill.name} 超时` };
        }
        if (controller.signal.aborted && controller.signal.reason !== 'TIMEOUT' && result.status === 'succeeded') {
          result = { status: 'cancelled', summary: `${skill.name} 已被取消（结果作废）` };
        }
        if (task.cancelCode && result.status !== 'succeeded') {
          result = { status: 'failed', failureCode: task.cancelCode, summary: `${skill.name} 失败：${task.cancelCode}` };
        }
        if (this.current?.id === task.id) {
          this.current = null;
          this.adapter.stopAll();
        }
        const durationMs = Date.now() - task.startedAt;
        this.memory.recordSkill(skill.name, result.status, result.failureCode);
        const sev = result.status === 'failed' ? 'P1' : source === 'filler' ? 'P3' : 'P2';
        this.bus.publish('task_end', sev, `[${source}] ${skill.name} → ${result.status}${result.failureCode ? `(${result.failureCode})` : ''}：${result.summary}`, {
          taskId: task.id,
          durationMs,
          status: result.status,
          failureCode: result.failureCode,
        });
        const { controller: _c, cancelCode: _cc, preemptedBy, ...info } = task;
        this.emit('done', { task: info, result, durationMs, preemptedBy } satisfies TaskOutcome);
      });

    const { controller: _c, ...info } = task;
    return info;
  }

  /** 取消当前任务并立即释放控制。asFailure 让取消计为失败（例如卡死）。 */
  cancel(reason: string, asFailure?: FailureCode, preemptedBy?: TaskSource) {
    const t = this.current;
    if (!t) return;
    t.cancelCode = asFailure;
    t.preemptedBy = preemptedBy;
    this.current = null;
    t.controller.abort(reason);
    this.adapter.stopAll();
  }
}
