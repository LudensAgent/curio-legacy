import type { AgentState } from '../adapter/types.ts';
import type { Step } from '../arbiter/arbiter.ts';
import type { Percept } from '../perception/perception.ts';
import { feetCell } from '../perception/local.ts';
import { evaluateCondition } from '../projects/conditions.ts';
import { SKILLS } from '../skills/index.ts';
import { STANCE_MOVES } from '../skills/stance.ts';
import { PLACEABLE } from '../skills/survival.ts';
import type { SkillResult } from '../skills/types.ts';
import { shortId } from '../util.ts';
import type { Activity, ActivityDraft, ActivityOutcome, ActivityRecord, ActivityStep } from './types.ts';

/**
 * 截断长反馈时同时保留头尾：开头交代是哪一步/什么失败，结尾常带可执行事实
 * （如 `→ dig_at {"at":[-1,2,0],"facing":"N"}`）。只留开头会把下一步动作切掉，
 * agent 就会照着半截话重做错事。默认 320 字，兼顾提示词成本。
 */
export function clipFeedback(text: string, max = 320): string {
  if (text.length <= max) return text;
  // max 太小时 head+tail 会挤掉分隔符，tail=0 时 slice(-0) 还会返回整串；直接硬截。
  if (max <= 5) return text.slice(0, max);
  const head = Math.ceil((max * 2) / 3);
  const tail = max - head - 1;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

export const inventoryOf = (s: Pick<AgentState, 'inventory'>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const i of s.inventory) out[i.name] = (out[i.name] ?? 0) + i.count;
  return out;
};

/** 物品名在技能参数里可能带 `minecraft:` 前缀，背包账本用不带前缀的名字。 */
const itemBaseName = (name: string) => name.replace(/^minecraft:/, '');

export function diffInventory(before: Record<string, number>, after: Record<string, number>) {
  const gained: Record<string, number> = {}, lost: Record<string, number> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const d = (after[k] ?? 0) - (before[k] ?? 0);
    if (d > 0) gained[k] = d; else if (d < 0) lost[k] = -d;
  }
  return { gained, lost };
}

/**
 * 同一逻辑动作的原始派发额度：绝对期限与开工背包。
 * 自动重试/续跑沿用这份账本；新的一段活（新的 Agent 委托）重新起算，不设全局配额。
 * 只放在内存里，随 Activity 一起被回收。
 */
type StepLedger = {
  deadline: number;
  resume: boolean;
  /** Inventory snapshot at the previous dispatch, so consumption accumulates per attempt. */
  last: Record<string, number>;
  /** Normalized item name -> units lost across attempts. Pickups cannot erase prior spend. */
  spent: Record<string, number>;
};
const ledgers = new WeakMap<Activity, Map<string, StepLedger>>();
const stepKeyOf = (step: Step) => step.id ?? `${step.skill}:${JSON.stringify(step.args ?? {})}`;

function ledgerOf(a: Activity) {
  let map = ledgers.get(a);
  if (!map) {
    map = new Map();
    ledgers.set(a, map);
  }
  return map;
}

/** 派发前读取这个逻辑动作的期限与材料基线；只有被标记为自动续跑的动作沿用旧账本。 */
export function beginStep(a: Activity, step: Step, state: Pick<AgentState, 'inventory'>) {
  const map = ledgerOf(a);
  const key = stepKeyOf(step);
  const previous = map.get(key);
  const continuation = previous?.resume === true;
  const inventory = inventoryOf(state);
  if (!previous || !continuation) {
    map.set(key, {
      deadline: Date.now() + (SKILLS[step.skill]?.timeoutMs ?? 0),
      resume: false,
      last: inventory,
      spent: {},
    });
  } else {
    previous.resume = false;
    const { lost } = diffInventory(previous.last, inventory);
    for (const [name, count] of Object.entries(lost)) {
      const base = itemBaseName(name);
      previous.spent[base] = (previous.spent[base] ?? 0) + count;
    }
    previous.last = inventory;
  }
  const ledger = map.get(key)!;
  return { deadlineMs: ledger.deadline, remainingMs: ledger.deadline - Date.now(), continuation };
}

/** 标记下一次派发是同一逻辑动作的自动重试/续跑，而不是新的独立动作。 */
export function markContinuation(a: Activity, step: Step | undefined) {
  if (!step) return;
  const ledger = ledgerOf(a).get(stepKeyOf(step));
  if (ledger) ledger.resume = true;
}

/** 新一轮 routine 是同一段活里的再次执行，按新一次派发重新起算，不继承上一轮的期限与耗材。 */
function resetStepBudgets(a: Activity) {
  ledgers.delete(a);
}

/**
 * 原委托声明的材料额度。当前 schema 里只有这两处能表达数量：
 * - climb_up 的 height：每确认升高一格最多消耗一个垫脚方块；
 * - place_at 的一次放置：最多花 1 个指定物品。
 * 通用 make 只是 boolean，没有数量，不能在这里假装有额度。
 */
function materialAllowance(a: Activity, step: Step, state: AgentState) {
  const args = (step.args ?? {}) as Record<string, unknown>;
  const climbKey = step.id ?? JSON.stringify(step.args ?? {});
  const height = a.climb?.[climbKey]?.height
    ?? (typeof args.height === 'number' ? args.height : Number(args.height));
  const item = typeof args.item === 'string' && args.item !== 'any' ? itemBaseName(args.item) : null;
  const declared = step.skill === 'climb_up'
    ? { max: Number.isFinite(height) ? height : 0, names: null as Set<string> | null }
    : step.skill === 'place_at'
      ? { max: 1, names: item === null ? null : new Set([item]) }
      : undefined;
  if (!declared || declared.max <= 0) return undefined;
  const ledger = ledgerOf(a).get(stepKeyOf(step));
  if (!ledger) return undefined;
  // Consumption accumulates across attempts; a later pickup of the same item
  // must not erase earlier spend. Include the loss since the last dispatch so a
  // just-finished attempt is counted before the next beginStep folds it in.
  const { lost } = diffInventory(ledger.last, inventoryOf(state));
  const spent: Record<string, number> = { ...ledger.spent };
  for (const [name, count] of Object.entries(lost)) {
    const base = itemBaseName(name);
    spent[base] = (spent[base] ?? 0) + count;
  }
  const consumed = Object.entries(spent).reduce((n, [name, count]) =>
    n + ((declared.names ? declared.names.has(itemBaseName(name)) : PLACEABLE.includes(itemBaseName(name))) ? count : 0), 0);
  return { max: declared.max, consumed, remaining: Math.max(0, declared.max - consumed) };
}

/** 自动重试前检查原委托的期限与材料额度；返回停止原因，未超限时返回 undefined。 */
function continuationGuard(a: Activity, step: Step | undefined, state: AgentState) {
  if (!step) return undefined;
  const ledger = ledgerOf(a).get(stepKeyOf(step));
  if (ledger && Date.now() >= ledger.deadline) return `「${step.skill}」的自动重试沿用的是原动作期限，现在已经到期；不再拿一个新的超时重来`;
  const material = materialAllowance(a, step, state);
  if (material && material.remaining <= 0) return `「${step.skill}」的自动重试不能超出原委托的材料额度：已消耗 ${material.consumed}，额度 ${material.max}；不再自动花材料`;
  return undefined;
}

/** 技能回执里明确报告的导航阶段（walk_to/walk_known_route/walk_route 等）；没有报告就不编。 */
function reportedStage(result: SkillResult): string | undefined {
  const text = (value: unknown) => typeof value === 'string' && value ? value : undefined;
  const data = result.data;
  const nav = data?.nav && typeof data.nav === 'object' ? data.nav as Record<string, unknown> : undefined;
  return text(nav?.stage) ?? text(nav?.outcome) ?? text(data?.stage);
}

/** 做法的“签名”：技能 + 主要对象，用来认出“同一套做法”，修正窍门的成败次数 */
export function signatureOf(steps: Step[]): string {
  return steps.map((st) => {
    const a = (st.args ?? {}) as Record<string, unknown>;
    const key = a.block ?? a.item ?? a.animal ?? a.target ?? a.blueprint ?? a.crop ?? a.for ?? a.direction ?? '';
    return key && typeof key !== 'object' ? `${st.skill}:${String(key)}` : st.skill;
  }).join('>');
}

export function targetKeyOf(step: Step): string {
  const a = (step.args ?? {}) as Record<string, unknown>;
  const target = a.target ?? a.block ?? a.item ?? a.animal ?? a.projectId ?? a.blueprint ?? a.for ?? a.direction ?? '';
  return `${step.skill}:${typeof target === 'object' && target ? JSON.stringify(target) : String(target)}`;
}

/** 只有位置相关的接触/支撑事实（around）变化才算新的重试依据；转头会改变 vision.view 与 nearby.resources（无关资源），不能当作环境变化触发原样重试。 */
export function viewOf(p?: Percept): string | undefined {
  return p ? JSON.stringify({ around: p.self.around }) : undefined;
}

/**
 * 自动重试只看失败回执里实际观测到的相关事实：支撑/净空、目标格、进度、额度和身体位置。
 * 转头、背包/附近资源增减、无关火把不在其中，不能用来给同一缺口再要一次重试。
 */
const GAP_EVIDENCE_FIELDS = [
  'movementNotAttempted', 'obscured', 'failureCause', 'pillarFailure', 'pillarClearance', 'reference', 'occupied',
  'problems', 'landingSupport', 'completedSteps', 'excavatedBlocks', 'ascendedLevels', 'descendedLevels',
  'goalReached', 'climbed', 'spent', 'targetCell', 'target', 'was', 'drop', 'expectedFoot', 'below', 'partialStop',
  'unsupportedGeometry', 'cavity', 'position', 'placed', 'consumed',
] as const;

function gapEvidence(result: SkillResult): string {
  const data = result.data;
  const stage = reportedStage(result);
  if (!data) return stage ? `{"navStage":${JSON.stringify(stage)}}` : '';
  const picked: Record<string, unknown> = {};
  for (const key of GAP_EVIDENCE_FIELDS) if (data[key] !== undefined) picked[key] = data[key];
  if (stage) picked.navStage = stage;
  const text = JSON.stringify(picked);
  return text.length > 240 ? text.slice(0, 240) : text;
}

/** 短指纹：把“同一技能/参数/失败码/证据版本”记进 adaptations，避免长参数撑大提示词。 */
function digest(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

export function createActivity(draft: ActivityDraft, monologue: string, source: Activity['source'], state: Pick<AgentState, 'inventory'>): Activity {
  return {
    id: shortId('act_'), what: draft.what, why: draft.why, kind: draft.kind, steps: draft.steps.map((s) => ({ ...s, id: shortId('st_') })),
    ...(draft.facing ? { facing: draft.facing } : {}),
    repeat: Math.max(1, Math.min(12, draft.repeat || 1)), iteration: 0, index: 0,
    ...(draft.doneWhen ? { doneWhen: draft.doneWhen } : {}), ...(draft.expect ? { expect: draft.expect } : {}),
    ...(draft.ifStuck ? { ifStuck: draft.ifStuck } : {}), ...(draft.agendaId ? { agendaId: draft.agendaId } : {}),
    source, monologue, startedAt: Date.now(), failures: 0, consecutiveFailures: 0, adaptations: [], results: [],
    ...(draft.dropped?.length ? { dropped: [...draft.dropped] } : {}),
    startInventory: inventoryOf(state),
  };
}

export function doneWhenMet(a: Activity, state: AgentState, percept?: Percept): boolean {
  return !!a.doneWhen && evaluateCondition(a.doneWhen, state, state.worldId, [], percept).status === 'satisfied';
}

/** 刚刚结束的那一步在 routine 里的原样（带 optional 标记） */
function ownStep(a: Activity, step: Step): ActivityStep | undefined {
  const own = a.steps[Math.max(0, a.index - 1)];
  return own && own.skill === step.skill ? own : undefined;
}

/**
 * 没做成但不算这段活失败的情况：只读观察没看到目标，或者本来就是“顺手、碰运气”的一步。
 * 真人“路上见到动物就打一只”，没见到就接着赶路，不会因此觉得整件事搞砸了。
 */
export function softMiss(a: Activity | null | undefined, step: Step, result: Pick<SkillResult, 'status' | 'failureCode'>): boolean {
  if (result.status !== 'failed') return false;
  if (SKILLS[step.skill]?.readOnly && result.failureCode === 'NOT_FOUND') return true;
  return !!a && ownStep(a, step)?.optional === true;
}

/** 下一个动作；这一轮做完了就开始下一轮；都做完返回 null */
export function nextStep(a: Activity): (Step & { id?: string }) | null {
  if (a.index >= a.steps.length) {
    if (a.iteration + 1 >= a.repeat) return null;
    a.iteration++;
    a.index = 0;
    a.climb = {}; // 新一轮：重置额度账本，从原始目标开始。
    resetStepBudgets(a);
  }
  const step = a.steps[a.index++];
  if (!step) return null;
  if (step.skill === 'climb_up') {
    const key = step.id ?? JSON.stringify(step.args ?? {});
    a.climb ??= {};
    a.climb[key] ??= { height: (step.args as Record<string, unknown>)?.height as number ?? 0, spent: 0, startY: Number.NaN };
    return { skill: step.skill, args: step.args, ...(step.id ? { id: step.id } : {}), ...(step.origin ? { origin: step.origin } : {}), ...(step.authorizedBy ? { authorizedBy: step.authorizedBy } : {}) };
  }
  // 归因随逻辑步骤一起下传：自动插步保留 execution_helper 与授权链，普通步骤仍是 agent。
  // 普通 agent 步骤维持原来的 {skill,args} 形状（调用方按它比较同一步）；只有插步额外带 id，
  // 便于把自动动作追溯到被执行的逻辑步骤。
  const attribution = { ...(step.origin ? { origin: step.origin } : {}), ...(step.authorizedBy ? { authorizedBy: step.authorizedBy } : {}) };
  return { skill: step.skill, args: step.args, ...(step.origin && step.id ? { id: step.id } : {}), ...attribution };
}

/** 还剩多少个动作（估计，用来决定什么时候开始想“接下来做什么”） */
export function remainingSteps(a: Activity): number {
  return Math.max(0, a.steps.length - a.index) + Math.max(0, a.repeat - a.iteration - 1) * a.steps.length;
}

/** 顺手的步骤遇到这些失败，再做几轮也一样：直接从这段活里去掉 */
const OPTIONAL_HOPELESS = new Set(['TARGET_GONE', 'BAD_ARGS', 'UNKNOWN_ITEM', 'WRONG_DIMENSION', 'WOULD_WASTE']);

/** 失败了值得原样再试一次的情况（路被挡、东西跑了、偶发错误） */
const RETRYABLE = new Set(['TIMEOUT', 'STUCK', 'PATH_NOT_FOUND', 'TARGET_GONE', 'ERROR', 'EFFECT_NOT_CONFIRMED']);
/** 不想清楚就没法继续的失败（缺材料、缺工具、背包满…） */
const NEEDS_THOUGHT = new Set(['MISSING_MATERIALS', 'WOULD_WASTE', 'NO_CRAFTING_TABLE', 'TOOL_MISSING', 'UNKNOWN_ITEM', 'BAD_ARGS', 'INVENTORY_FULL', 'NO_FOOD', 'WRONG_DIMENSION', 'LOW_HP']);

export type StepVerdict =
  | { kind: 'continue'; adapted?: string }
  | { kind: 'done'; met: boolean; why: string }
  | { kind: 'stuck'; why: string; /** 额度耗尽，直接终止自动推进，不再插入学得恢复或重放原动作 */ exhausted?: boolean };

/**
 * 一个动作结束后，处理同一动作的短暂失败；需要改变目标或增加探索时交给心智。
 * 返回这段活接下来怎么办。
 */
export function afterStep(a: Activity, step: Step, result: SkillResult, durationMs: number, state: AgentState, percept?: Percept): StepVerdict {
  const conditionReached = (): StepVerdict | null => {
    if (!a.doneWhen) return null;
    const evidence = evaluateCondition(a.doneWhen, state, state.worldId, [], percept);
    if (evidence.status !== 'satisfied') return null;
    a.conditionTriggered = true;
    return { kind: 'done', met: true, why: `收工条件满足：${JSON.stringify(a.doneWhen)}；位置 (${state.pos.x.toFixed(1)},${state.pos.y.toFixed(1)},${state.pos.z.toFixed(1)})；实际 ${JSON.stringify(evidence.actual)}；只确认该条件，其他目标未由此验证` };
  };
  const conditionUnmet = () => {
    if (!a.doneWhen) return '';
    const evidence = evaluateCondition(a.doneWhen, state, state.worldId, [], percept);
    return `；收工条件未满足或无法确认：${JSON.stringify(a.doneWhen)}；状态 ${evidence.status}，实际 ${JSON.stringify(evidence.actual)}${evidence.reason ? `；原因：${evidence.reason}` : ''}；位置 (${state.pos.x.toFixed(1)},${state.pos.y.toFixed(1)},${state.pos.z.toFixed(1)})`;
  };
  const previous = [...a.results].reverse().find((r) => r.status === 'failed' && targetKeyOf(r) === targetKeyOf(step));
  const view = viewOf(percept);
  const baseline = previous?.pos ? previous : a.stepStart;
  const previousPosition = a.results.at(-1)?.pos;
  if (previousPosition && JSON.stringify(feetCell(previousPosition)) !== JSON.stringify(feetCell(state.pos))) delete a.airDigs;
  // 只记录技能明确报告过的阶段（walk_to/walk_known_route 的 nav.outcome、walk_route 的 nav.outcome、
  // 水面技能的 data.stage）；没有报告的技能保持没有，不由耗时或位置臆造阶段。
  const navStage = reportedStage(result);
  const recorded: Activity['results'][number] & { stage?: string } = {
    skill: step.skill, args: step.args, status: result.status, failureCode: result.failureCode, summary: clipFeedback(result.summary), at: Date.now(), durationMs, pos: { ...state.pos }, ...(view !== undefined ? { view } : {})
  };
  if (navStage) recorded.stage = navStage;
  a.results.push(recorded);
  if (a.results.length > 16) a.results = a.results.slice(-16);
  // climb_up 的统一结算与续跑决策：账本已在 climbUp.run 里结算（成功/失败/取消/嵌套都计入），这里只判断完成/继续/耗尽。
  if (step.skill === 'climb_up') {
    const key = a.steps[Math.max(0, a.index - 1)]?.id ?? JSON.stringify(step.args ?? {});
    if (result.status === 'succeeded') {
      if (a.climb) delete a.climb[key];
    } else {
      const budget = a.climb?.[key];
      if (budget && budget.spent >= budget.height && result.data?.goalReached === false) return { kind: 'stuck', why: clipFeedback(result.summary), exhausted: true };
    }
  }
  if (result.status === 'succeeded') {
    a.consecutiveFailures = 0;
    // 真实挖掘、放置或跨格移动是执行进展，不能沿用之前的空挖计数。
    if (step.skill === 'place_at' && result.data?.placed
      || step.skill === 'dig_at' && result.data?.was && result.data.was !== 'air'
      || step.skill === 'dig' && (result.data?.dug as string[] | undefined)?.length) delete a.airDigs;
    // 相对坐标会随身体移动；只统计同一实际目标格的重复空挖。
    if (step.skill === 'dig_at') {
      const key = JSON.stringify(step.args ?? {});
      const air = result.data?.was === 'air';
      const target = result.data?.targetCell as AgentState['pos'] | undefined;
      a.airDigs ??= {};
      if (air && target) {
        const previous = a.airDigs[key];
        const same = previous && previous.target.x === target.x && previous.target.y === target.y && previous.target.z === target.z;
        const count = same ? previous.count + 1 : 1;
        a.airDigs[key] = { target: { ...target }, count };
        if (count >= 3) return { kind: 'stuck', why: `dig_at 连续 ${count} 次确认目标格 (${target.x},${target.y},${target.z}) 是空气，这几次未在该格发生挖掘` };
      }
      else delete a.airDigs[key];
    }
    const reached = conditionReached();
    if (reached) return reached;
    // 挖了一部分后遇到空洞也算动作有实际效果，但重复回到同一格继续挖不能当作下行进展。
    // 只记录身体明确报告的停点；交回心智决定是否继续，不能替它选路。
    if (step.skill === 'dig' && a.repeat > 1) {
      const key = `${a.index - 1}:${JSON.stringify(step.args ?? {})}`;
      const stop = result.data?.partialStop as { pos: { x: number; y: number; z: number }; below: string | null; completed: number; requested: number } | undefined;
      a.partialStops ??= {};
      const prev = a.partialStops[key];
      if (stop && stop.completed < stop.requested) {
        const same = prev && prev.iteration === a.iteration - 1 && prev.pos.x === stop.pos.x && prev.pos.y === stop.pos.y && prev.pos.z === stop.pos.z && prev.below === stop.below;
        const count = same ? prev.count + 1 : 1;
        a.partialStops[key] = { pos: stop.pos, below: stop.below, iteration: a.iteration, count };
        if (count >= 3 && remainingSteps(a) > 0) return { kind: 'stuck', why: `dig 连续 ${count} 轮在 (${stop.pos.x},${stop.pos.y},${stop.pos.z}) 上方停下：本轮确认到达下一级 ${stop.completed}/${stop.requested} 次，再下面是 ${stop.below ?? '未知'}；这几轮停在同一处，请根据实际情况决定下一步` };
      } else delete a.partialStops[key];
    }
    if (remainingSteps(a) === 0) {
      if (a.doneWhen) return { kind: 'done', met: false, why: `${a.repeat} 轮做完了（最后一步：${clipFeedback(result.summary)}）${conditionUnmet()}` };
      return { kind: 'done', met: true, why: '这段活的步骤都做完了' };
    }
    return { kind: 'continue' };
  }
  if (result.status === 'cancelled') return { kind: 'continue' };
  if (softMiss(a, step, result)) {
    a.consecutiveFailures = 0;
    const own = ownStep(a, step);
    const optional = own?.optional === true;
    // optional 移动没到新站位：记下事实，下一步校验后若为相对挖掘/放置则报告依赖缺口（不在此用原始参数判断）。
    if (optional && STANCE_MOVES.has(step.skill)) {
      a.stanceGap = { skill: step.skill, pos: { ...state.pos } };
    }
    // 顺手的一步这次是“再试也不会成”的失败（要挖的已经没了、参数本身就不对；找不到连着两轮）：后面几轮不再做它
    const code = result.failureCode ?? 'ERROR';
    const missKey = `optmiss:${step.skill}:${JSON.stringify(step.args ?? {}).slice(0, 80)}`;
    if (optional && code === 'NOT_FOUND') a.adaptations.push(missKey);
    const hopeless = optional && (OPTIONAL_HOPELESS.has(code) || (code === 'NOT_FOUND' && a.adaptations.filter((x) => x === missKey).length >= 2));
    if (hopeless && own && a.steps.length > 1) {
      const i = a.steps.indexOf(own);
      if (i >= 0) { a.steps.splice(i, 1); if (i < a.index) a.index--; }
      const reached = conditionReached();
      if (reached) return reached;
      return remainingSteps(a) === 0
        ? { kind: 'done', met: !a.doneWhen, why: `顺手的「${step.skill}」没成（${code}）；这段活的步骤都做完了${conditionUnmet()}` }
        : { kind: 'continue', adapted: `顺手的「${step.skill}」再做也不会成（${result.summary.slice(0, 40)}），后面几轮不再做它` };
    }
    const reached = conditionReached();
    if (reached) return reached;
    return remainingSteps(a) === 0
      ? { kind: 'done', met: !a.doneWhen, why: `${optional ? `顺手的「${step.skill}」没成` : '观察没有找到目标'}；这段活的步骤都做完了${conditionUnmet()}` }
      : { kind: 'continue', ...(optional ? { adapted: `顺手的「${step.skill}」没成（${result.failureCode ?? '失败'}），不碍事，接着做` } : {}) };
  }
  a.failures++;
  a.consecutiveFailures++;
  const code = result.failureCode ?? 'ERROR';
  if (a.failures >= 5) return { kind: 'stuck', why: `这段活已经失败 ${a.failures} 次了（最近：${clipFeedback(result.summary, 200)}）` };
  if (NEEDS_THOUGHT.has(code)) return { kind: 'stuck', why: clipFeedback(result.summary) };
  // 自动插步只能是已选动作契约里明确包含的执行辅助；挖、放、耗材和改目标默认交回事实。
  const data = result.data as Record<string, any> | undefined;
  // follow_passage（或包含它的 use_skill 等嵌套动作）报出确定的图断口（connectionGap）时，
  // 原样重试不会改变通道拓扑：按数据字段判断，交回心智，不领重试额度。
  if (data?.connectionGap && typeof data.connectionGap === 'object') {
    const gap = data.connectionGap as { from?: AgentState['pos']; to?: AgentState['pos']; distance?: number };
    const at = (p?: AgentState['pos']) => p ? `(${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)})` : '未知位置';
    return { kind: 'stuck', why: `${clipFeedback(result.summary, 220)}；connectionGap ${at(gap.from)} ↔ ${at(gap.to)}（相距 ${typeof gap.distance === 'number' ? Math.round(gap.distance) : '未知'} 格）是记录几何里的确定断口，原样重试不会接上` };
  }
  // follow_passage（含 use_skill 嵌套结果）明确报告身体被寻路带离记录路线时，这段位移不是进展：
  // 原样重试不会回到记录点，也不把它当自动重试的依据。
  const nestedNavData = data?.lastNavigationFailure as { result?: { data?: Record<string, unknown> } } | undefined;
  if (data?.offRoute === true || nestedNavData?.result?.data?.offRoute === true) {
    return { kind: 'stuck', why: `${clipFeedback(result.summary, 220)}；寻路把身体带离了记录路线（offRoute），这段位移不算进展，原样重试不会回到记录点` };
  }
  // step 的确定性障碍：回执给出了具体要挖的格，且这段活本身已经在挖（dig_at/dig/excavate_path），
  // 就按同一委托先插入这一步挖掘再重试。只处理同一目标列/头脚格，不换方向、不换材料、不扩目标。
  if (step.skill === 'step' && data?.movementNotAttempted === true && data?.remediation?.dig) {
    const rel = data.remediation.dig as unknown;
    const digging = a.steps.some((s) => s.skill === 'dig_at' || s.skill === 'dig' || s.skill === 'excavate_path');
    const scope = `step-dig:${digest(JSON.stringify(step.args ?? {}))}:${digest(JSON.stringify(rel))}`;
    const attempts = a.adaptations.filter((item) => item.startsWith(`step-dig:`)).length;
    if (digging && Array.isArray(rel) && rel.length === 3 && attempts < 2) {
      const mark = `${scope}:${digest(gapEvidence(result))}`;
      if (!a.adaptations.includes(mark)) {
        const own = ownStep(a, step);
        const facing = (step.args as Record<string, unknown> | undefined)?.facing ?? a.facing;
        a.adaptations.push(mark);
        a.steps.splice(Math.max(0, a.index - 1), 0, {
          skill: 'dig_at',
          args: { at: rel, ...(facing ? { facing } : {}) },
          id: shortId('st_'), origin: 'execution_helper',
          authorizedBy: { skill: step.skill, ...(own?.id ? { stepId: own.id } : {}), args: step.args },
        });
        a.index = Math.max(0, a.index - 1);
        markContinuation(a, own);
        return { kind: 'continue', adapted: `迈步被挡，先按回执挖开 [${(rel as number[]).join(',')}] 再重试（同一段活已包含挖掘；不新增目标/材料）` };
      }
    }
  }
  // 确定性预检拒绝先于任何自动照明/清障处理：暗处未知支撑、预检一步未推进，交回事实，不自动耗火把或原样重试。
  if (step.skill === 'step' && data?.movementNotAttempted === true) return { kind: 'stuck', why: clipFeedback(result.summary) };
  if (step.skill === 'excavate_path' && data?.completedSteps === 0 && (data?.excavatedBlocks ?? 0) === 0) return { kind: 'stuck', why: clipFeedback(result.summary) };
  const stepArgs = (step.args ?? {}) as Record<string, any>;
  const facing = stepArgs.facing ?? a.facing;
  // 1) 看不清：交回事实，不自动插火把（照明是耗材，未授权不支出）
  if (data?.obscured) return { kind: 'stuck', why: clipFeedback(result.summary) };
  // 2) climb_up 的动作说明明确包含「头顶挡着会先挖开」：这是该动作契约内的执行辅助。
  //    保留授权链（原步骤/参数），并说明只会消耗工具耐久；同一障碍证据只清一次，最多两次。
  if (step.skill === 'climb_up' && data?.failureCause === 'PILLAR_CLEARANCE') {
    // 障碍格可能有多格（身后/侧上方）：一次全挖空，别再一格一格挤牙膏、也别硬编码 [0,2,0]
    const cells: { at: [number, number, number]; facing?: string }[] = data?.pillarClearance?.cells?.length
      ? data.pillarClearance.cells
      : [{ at: data?.pillarClearance?.at ?? [0, 2, 0], facing: data?.pillarClearance?.facing ?? facing }];
    const scope = `${step.skill}:${digest(JSON.stringify(step.args ?? {}))}:${code}`;
    const mark = `clearance:${scope}:${digest(JSON.stringify(cells.map((cell) => [cell.at, cell.facing ?? null])))}`;
    const cleared = a.adaptations.filter((item) => item.startsWith(`clearance:${scope}:`)).length;
    if (cleared >= 2 || a.adaptations.includes(mark)) return { kind: 'stuck', why: clipFeedback(result.summary) };
    a.adaptations.push(mark);
    const own = ownStep(a, step);
    const authorizedBy = { skill: step.skill, ...(own?.id ? { stepId: own.id } : {}), args: step.args };
    a.steps.splice(Math.max(0, a.index - 1), 0, ...cells.map((c) => ({ skill: 'dig_at', args: { at: c.at, ...(c.facing ? { facing: c.facing } : {}) }, id: shortId('st_'), origin: 'execution_helper' as const, authorizedBy })));
    a.index = Math.max(0, a.index - 1);
    // 清障后回放同一个 climb_up：它仍是同一次委托，沿用原期限/高度/材料账本。
    markContinuation(a, own);
    return { kind: 'continue', adapted: `头顶被挡，先把 ${cells.length} 格障碍挖开再走（climb_up 已授权清障；只消耗工具耐久，不消耗背包方块）` };
  }
  // goto 是「委托寻路」：头顶被挡是路线事实，不替 Agent 决定挖哪一格——挖开、绕行还是退回去由它定。
  if (step.skill === 'goto' && data?.pillarClearance) return { kind: 'stuck', why: clipFeedback(result.summary) };
  // place_at 是普通放置/搭柱：不隐式清顶或挖脚下；交回事实，挖哪一格由 Agent 决定。
  if (step.skill === 'place_at' && data?.pillarFailure === 'NOT_PLACED:头顶跳跃空间受阻') return { kind: 'stuck', why: clipFeedback(result.summary) };
  if (step.skill === 'place_at' && data?.pillarFailure === 'NOT_PLACED:头顶跳跃空间未加载') return { kind: 'stuck', why: clipFeedback(result.summary) };
  if (step.skill === 'place_at' && data?.pillarFailure === 'NOT_PLACED:跳不起来') return { kind: 'stuck', why: clipFeedback(result.summary) };
  // 3) 脚下有非空气的可替换物（火把/草/雪层…）：place_at 没有授予挖掘，不自动 dig_at 清掉。
  if (step.skill === 'place_at' && typeof data?.pillarFailure === 'string' && data.pillarFailure.startsWith('BLOCKED:')) {
    return { kind: 'stuck', why: clipFeedback(result.summary) };
  }
  // 4) 脚下没有实心地面（悬空/水里/梯子上）：确定性缺支撑，原地垫高垫不了，别白重试。
  if (step.skill === 'place_at' && data?.pillarFailure === 'NO_REFERENCE') {
    return { kind: 'stuck', why: clipFeedback(result.summary) };
  }
  // 裸 NOT_PLACED（适配器自身已重试两次仍未放下）和“贴面方块变了”都是确定性拒绝，
  // 不能当成服务器暂时延迟再回放。
  if (
    step.skill === 'place_at' &&
    typeof data?.pillarFailure === 'string' &&
    (data.pillarFailure === 'NOT_PLACED' || data.pillarFailure.includes('脚下贴面方块变了'))
  ) {
    return { kind: 'stuck', why: clipFeedback(result.summary) };
  }
  // 服务器暂时拒绝/尚未站稳不是“没有附着面”：在同一个父委托的期限和材料额度内有限重试（最多两次）。
  // 这些是暂时条件（服务器确认延迟/身体还没落稳），不是同一确定性缺口的原样重试；确定性拒绝已在上面的分支停止。
  if (step.skill === 'place_at' && typeof data?.pillarFailure === 'string' && /^NOT_PLACED(?::|$)/.test(data.pillarFailure)) {
    const own = ownStep(a, step);
    const scope = `pillar-retry:${digest(JSON.stringify(step.args ?? {}))}`;
    const attempts = a.adaptations.filter((item) => item.startsWith(`${scope}:`)).length;
    const mark = `${scope}:${digest(gapEvidence(result))}`;
    // 服务器拒绝/尚未站稳是有界的暂时条件：最多两次；确定性拒绝已在上面的分支立即停止。
    if (attempts >= 2) return { kind: 'stuck', why: clipFeedback(result.summary) };
    const guard = continuationGuard(a, own, state);
    if (guard) return { kind: 'stuck', why: guard };
    a.adaptations.push(mark);
    markContinuation(a, own);
    a.index = Math.max(0, a.index - 1);
    return { kind: 'continue', adapted: `${step.skill} 被服务器暂时拒绝或身体尚未落稳（${data.pillarFailure.slice(0, 60)}）；沿用原委托期限和材料额度再确认一次` };
  }
  // 5) 同一技能+错误+原参数+同一证据版本不原样重试。首次重试要求身体实际移动（相关进展）；
  //    之后只有失败回执里的支撑/净空/目标/进度等事实变了才允许复验，且最多两次。
  //    转头、附近资源增减、无关火把不计入证据。
  const retryScope = `${step.skill}:${digest(JSON.stringify(step.args ?? {}))}:${code}`;
  const retryMark = `retry:${retryScope}:${digest(gapEvidence(result))}`;
  const retries = a.adaptations.filter((item) => item.startsWith(`retry:${retryScope}:`)).length;
  const physicallyMoved = !!baseline?.pos && Math.hypot(state.pos.x - baseline.pos.x, state.pos.y - baseline.pos.y, state.pos.z - baseline.pos.z) >= 0.5;
  // 相对 step 只有“前/上/右”偏移，没有固定世界目标。失败后身体已经换位时，自动重试会
  // 用新站位重新解释同一个 [1,-1,0]，实际变成下一格（空腔里会一路下沉/换列）。这不是
  // 同一个逻辑动作的复验，交回心智按实测位置重新选择；绝对 step/xyz 仍可按原目标复验。
  if (step.skill === 'step' && (step.args as Record<string, unknown> | undefined)?.xyz === undefined && physicallyMoved) {
    return { kind: 'stuck', why: `${clipFeedback(result.summary)}；相对 step 失败后身体已换位，自动重试会用新站位重算落点，交回心智重新选择` };
  }
  // swim_to 的 SWIM_NO_PROGRESS 是同一目标、同一地形下的物理停滞：身体在失败前动过，不代表路线变了。
  // 原样重放同一个目标只会再耗一次时间与氧气；换路线、换手段交回心智决定。
  if (step.skill === 'swim_to' && data?.reason === 'SWIM_NO_PROGRESS') {
    return { kind: 'stuck', why: `${clipFeedback(result.summary)}；同一目标在同样的地形里重放不会改变结果，交回心智换路线或换手段` };
  }
  // surface 头顶被实心方块封住是确定性失败：surface 只按跳、不会挖开；原样重放不会把方块弄掉。
  if (step.skill === 'surface' && data?.blockedAbove) {
    return { kind: 'stuck', why: `${clipFeedback(result.summary)}；头顶被 ${data.blockedAbove.name} 封住，surface 只按跳不能挖，原样重放不会改变结果，交回心智` };
  }
  // 穿门等待超时且身体此刻仍在门方块里：这次失败没有新的身体事实可复验，自动续跑不再
  // 原样重放同一次 30 秒等待；先离开门、换门还是放弃交回心智决定。
  // 只认 travel/recall 回执里明确标注的 portalReason，避免把其它技能数据里的 transition 当成门。
  const portalInsideMs = typeof data?.transition?.insideMs === 'number' ? data.transition.insideMs : 0;
  if (data?.portalReason === 'PORTAL_TRANSITION_TIMEOUT' && portalInsideMs >= 1000) {
    return { kind: 'stuck', why: `${clipFeedback(result.summary)}；这次失败没有新的身体事实可复验，自动续跑不再原样重放，交回心智` };
  }
  if (RETRYABLE.has(code) && !(step.skill === 'goto' && code === 'PATH_NOT_FOUND')
    && !a.adaptations.includes(retryMark) && retries < 2 && (retries > 0 || physicallyMoved)) {
    const guard = continuationGuard(a, ownStep(a, step), state);
    if (guard) return { kind: 'stuck', why: guard };
    a.adaptations.push(retryMark);
    markContinuation(a, ownStep(a, step));
    a.index = Math.max(0, a.index - 1);
    return { kind: 'continue', adapted: `${step.skill} 没成；身体位置或失败回执证据有更新，按原委托再试一次` };
  }
  return { kind: 'stuck', why: clipFeedback(result.summary) };
}

export function recordOf(a: Activity, outcome: ActivityOutcome, summary: string, state: AgentState): ActivityRecord {
  const { gained, lost } = diffInventory(a.startInventory, inventoryOf(state));
  return {
    id: a.id, what: a.what, kind: a.kind, outcome, summary: summary.slice(0, 200),
    ...(a.facing ? { facing: a.facing } : {}),
    ...(outcome === 'done' ? { completion: a.conditionTriggered ? 'condition' as const : 'steps' as const } : outcome === 'unmet' ? { completion: 'unmet' as const } : {}),
    durationSec: Math.round((Date.now() - a.startedAt) / 1000), gained, lost,
    ...(a.expect ? { expect: a.expect } : {}), ...(a.hypothesis ? { hypothesis: a.hypothesis } : {}),
    at: Date.now(), signature: signatureOf(a.steps),
    failures: a.failures,
  };
}

/** 步骤参数的简短写法：图纸只写名字和尺寸，其余太长的截断（免得撑大提示词、又被模型原样抄回来） */
export function argsLabel(step: Step): string {
  const args = (step.args ?? {}) as Record<string, any>;
  if (args.spec && typeof args.spec === 'object') {
    const { spec, ...rest } = args;
    const size = spec.width && spec.depth ? ` ${spec.width}×${spec.depth}` : '';
    return JSON.stringify({ ...rest, spec: `「${spec.name ?? '设计'}」${size}（图纸已省略）` });
  }
  const text = JSON.stringify(args);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

/** 把一段活压成一行给模型看 */
export function describeActivity(a: Activity, state: AgentState, percept?: Percept) {
  const done = a.doneWhen ? evaluateCondition(a.doneWhen, state, state.worldId, [], percept) : null;
  const stageOf = (r: Activity['results'][number]) => (r as { stage?: unknown }).stage;
  const lastStage = [...a.results].reverse().find((r) => typeof stageOf(r) === 'string');
  return {
    what: a.what, why: a.why, kind: a.kind,
    ...(a.facing ? { facing: a.facing } : {}),
    routine: a.steps.map((s) => `${s.skill} ${argsLabel(s)}${s.id ? ` #${s.id}` : ''}${s.optional ? '（顺手）' : ''}`),
    round: `${a.iteration + 1}/${a.repeat}`, next_step: a.index,
    elapsed_real_s: Math.round((Date.now() - a.startedAt) / 1000),
    ...(done ? { done_when: { status: done.status, actual: done.actual } } : {}),
    ...(a.failures ? { failures: a.failures } : {}),
    ...(a.adaptations.length ? { body_adapted: a.adaptations } : {}),
    ...(a.dropped?.length ? { not_done_rejected: a.dropped } : {}),
    // 只在技能真的报告阶段时带上；没报告的步骤不补一个假阶段。
    ...(lastStage ? { last_nav_stage: stageOf(lastStage) } : {}),
    recent: a.results.slice(-3).map((r) => {
      const stage = stageOf(r);
      // 3 条的尾部各自至少留 ~80 字（260 的上限按 2/3 头、1/3 尾切，尾部长 260-174-1=85），
      // 否则 `[前,上,右]=…→ dig_at {…}` 这类可执行尾巴仍会被切掉。
      return `${r.skill} → ${r.status}${r.failureCode ? `(${r.failureCode})` : ''}${typeof stage === 'string' ? `〔阶段 ${stage}〕` : ''}：${clipFeedback(r.summary, 260)}`;
    }),
    ...(a.expect ? { my_expectation: a.expect } : {}),
    ...(a.hypothesis ? { hypothesis: a.hypothesis } : {}),
  };
}
