import type { AgentState } from '../adapter/types.ts';
import type { Step } from '../arbiter/arbiter.ts';
import { evaluateCondition } from '../projects/conditions.ts';
import type { SkillResult } from '../skills/types.ts';
import { shortId } from '../util.ts';
import type { Activity, ActivityDraft, ActivityOutcome, ActivityRecord } from './types.ts';

export const inventoryOf = (s: Pick<AgentState, 'inventory'>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const i of s.inventory) out[i.name] = (out[i.name] ?? 0) + i.count;
  return out;
};

export function diffInventory(before: Record<string, number>, after: Record<string, number>) {
  const gained: Record<string, number> = {}, lost: Record<string, number> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const d = (after[k] ?? 0) - (before[k] ?? 0);
    if (d > 0) gained[k] = d; else if (d < 0) lost[k] = -d;
  }
  return { gained, lost };
}

/** 做法的“签名”：技能 + 主要对象，用来认出“同一套做法”，修正窍门的成败次数 */
export function signatureOf(steps: Step[]): string {
  return steps.map((st) => {
    const a = (st.args ?? {}) as Record<string, unknown>;
    const key = a.block ?? a.item ?? a.animal ?? a.target ?? a.blueprint ?? a.crop ?? a.for ?? a.direction ?? '';
    return key && typeof key !== 'object' ? `${st.skill}:${String(key)}` : st.skill;
  }).join('>');
}

export function createActivity(draft: ActivityDraft, monologue: string, source: Activity['source'], state: Pick<AgentState, 'inventory'>): Activity {
  return {
    id: shortId('act_'), what: draft.what, why: draft.why, kind: draft.kind, steps: draft.steps.map((s) => ({ ...s })),
    repeat: Math.max(1, Math.min(12, draft.repeat || 1)), iteration: 0, index: 0,
    ...(draft.doneWhen ? { doneWhen: draft.doneWhen } : {}), ...(draft.expect ? { expect: draft.expect } : {}),
    ...(draft.ifStuck ? { ifStuck: draft.ifStuck } : {}), ...(draft.agendaId ? { agendaId: draft.agendaId } : {}),
    source, monologue, startedAt: Date.now(), failures: 0, consecutiveFailures: 0, adaptations: [], results: [],
    startInventory: inventoryOf(state),
  };
}

export function doneWhenMet(a: Activity, state: AgentState): boolean {
  return !!a.doneWhen && evaluateCondition(a.doneWhen, state).status === 'satisfied';
}

/** 下一个动作；这一轮做完了就开始下一轮；都做完返回 null */
export function nextStep(a: Activity): Step | null {
  if (a.index >= a.steps.length) {
    if (a.iteration + 1 >= a.repeat) return null;
    a.iteration++;
    a.index = 0;
  }
  const step = a.steps[a.index++];
  return step ? { skill: step.skill, args: step.args } : null;
}

/** 还剩多少个动作（估计，用来决定什么时候开始想“接下来做什么”） */
export function remainingSteps(a: Activity): number {
  return Math.max(0, a.steps.length - a.index) + Math.max(0, a.repeat - a.iteration - 1) * a.steps.length;
}

/** 失败了值得原样再试一次的情况（路被挡、东西跑了、偶发错误） */
const RETRYABLE = new Set(['TIMEOUT', 'STUCK', 'PATH_NOT_FOUND', 'TARGET_GONE', 'ERROR', 'EFFECT_NOT_CONFIRMED']);
/** 不想清楚就没法继续的失败（缺材料、缺工具、背包满…） */
const NEEDS_THOUGHT = new Set(['MISSING_MATERIALS', 'NO_CRAFTING_TABLE', 'TOOL_MISSING', 'UNKNOWN_ITEM', 'BAD_ARGS', 'INVENTORY_FULL', 'NO_FOOD', 'WRONG_DIMENSION', 'LOW_HP']);

export type StepVerdict =
  | { kind: 'continue'; adapted?: string }
  | { kind: 'done'; met: boolean; why: string }
  | { kind: 'stuck'; why: string };

/**
 * 一个动作结束后，身体自己能处理的就自己处理（像真人那样“没找到就换个地方找”“没走过去就再走一次”），
 * 处理不了才交给脑子想。返回这段活接下来怎么办。
 */
export function afterStep(a: Activity, step: Step, result: SkillResult, durationMs: number, state: AgentState): StepVerdict {
  a.results.push({ skill: step.skill, args: step.args, status: result.status, failureCode: result.failureCode, summary: result.summary.slice(0, 160), at: Date.now(), durationMs });
  if (a.results.length > 16) a.results = a.results.slice(-16);
  if (result.status === 'succeeded') {
    a.consecutiveFailures = 0;
    if (doneWhenMet(a, state)) return { kind: 'done', met: true, why: '达到了收工条件' };
    if (remainingSteps(a) === 0) {
      if (a.doneWhen) return { kind: 'done', met: false, why: `${a.repeat} 轮做完了，但收工条件还没达到` };
      return { kind: 'done', met: true, why: '这段活的步骤都做完了' };
    }
    return { kind: 'continue' };
  }
  if (result.status === 'cancelled') return { kind: 'continue' };
  a.failures++;
  a.consecutiveFailures++;
  const code = result.failureCode ?? 'ERROR';
  const args = (step.args ?? {}) as Record<string, unknown>;
  const target = String(args.block ?? args.animal ?? args.for ?? '');
  const key = `${a.index - 1}:${step.skill}:${code}`;
  if (a.failures >= 5) return { kind: 'stuck', why: `这段活已经失败 ${a.failures} 次了（最近：${result.summary.slice(0, 80)}）` };
  // 找不到要的东西：先换个地方找找（每段活一次）
  if (code === 'NOT_FOUND' && target && ['gather', 'hunt', 'collect_seeds', 'forage'].includes(step.skill) && !a.adaptations.includes(`search:${target}`)) {
    a.adaptations.push(`search:${target}`);
    a.steps.splice(a.index - 1, 0, { skill: 'explore', args: { until: target.split('|')[0] === 'animal' ? 'animal' : target, distance: 64 } });
    a.index = Math.max(0, a.index - 1);
    return { kind: 'continue', adapted: `附近没找到 ${target}，换个方向找找` };
  }
  if (NEEDS_THOUGHT.has(code)) return { kind: 'stuck', why: result.summary.slice(0, 160) };
  if (RETRYABLE.has(code) && a.consecutiveFailures === 1 && !a.adaptations.includes(`retry:${key}`)) {
    a.adaptations.push(`retry:${key}`);
    a.index = Math.max(0, a.index - 1);
    return { kind: 'continue', adapted: `${step.skill} 没成，再试一次` };
  }
  return { kind: 'stuck', why: result.summary.slice(0, 160) };
}

export function recordOf(a: Activity, outcome: ActivityOutcome, summary: string, state: AgentState): ActivityRecord {
  const { gained, lost } = diffInventory(a.startInventory, inventoryOf(state));
  return {
    id: a.id, what: a.what, kind: a.kind, outcome, summary: summary.slice(0, 200),
    durationSec: Math.round((Date.now() - a.startedAt) / 1000), gained, lost,
    ...(a.expect ? { expect: a.expect } : {}), ...(a.hypothesis ? { hypothesis: a.hypothesis } : {}),
    at: Date.now(), signature: signatureOf(a.steps.filter((s) => !(a.adaptations.length && s.skill === 'explore' && (s.args as any)?.distance === 64))),
    failures: a.failures,
  };
}

/** 把一段活压成一行给模型看 */
export function describeActivity(a: Activity, state: AgentState) {
  const done = a.doneWhen ? evaluateCondition(a.doneWhen, state) : null;
  return {
    what: a.what, why: a.why, kind: a.kind,
    routine: a.steps.map((s) => `${s.skill} ${JSON.stringify(s.args ?? {})}`),
    round: `${a.iteration + 1}/${a.repeat}`, next_step: a.index,
    elapsed_s: Math.round((Date.now() - a.startedAt) / 1000),
    ...(done ? { done_when: { status: done.status, actual: done.actual } } : {}),
    ...(a.failures ? { failures: a.failures } : {}),
    ...(a.adaptations.length ? { body_adapted: a.adaptations } : {}),
    recent: a.results.slice(-3).map((r) => `${r.skill} → ${r.status}${r.failureCode ? `(${r.failureCode})` : ''}：${r.summary.slice(0, 80)}`),
    ...(a.expect ? { my_expectation: a.expect } : {}),
    ...(a.hypothesis ? { hypothesis: a.hypothesis } : {}),
  };
}
