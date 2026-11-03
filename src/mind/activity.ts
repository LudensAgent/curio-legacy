import type { AgentState } from '../adapter/types.ts';
import type { Step } from '../arbiter/arbiter.ts';
import type { Percept } from '../perception/perception.ts';
import { feetCell } from '../perception/local.ts';
import { evaluateCondition } from '../projects/conditions.ts';
import { SKILLS } from '../skills/index.ts';
import type { SkillResult } from '../skills/types.ts';
import { shortId } from '../util.ts';
import type { Activity, ActivityDraft, ActivityOutcome, ActivityRecord, ActivityStep } from './types.ts';

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

export function targetKeyOf(step: Step): string {
  const a = (step.args ?? {}) as Record<string, unknown>;
  const target = a.target ?? a.block ?? a.item ?? a.animal ?? a.projectId ?? a.blueprint ?? a.for ?? a.direction ?? '';
  return `${step.skill}:${typeof target === 'object' && target ? JSON.stringify(target) : String(target)}`;
}

/** 不包含时间、背包和朝向，只有实际看见的环境改变才算新的重试依据。 */
export function viewOf(p?: Percept): string | undefined {
  return p ? JSON.stringify({ around: p.self.around, view: p.vision?.view, resources: p.nearby.resources.filter((r) => r.seen === 'now') }) : undefined;
}

export function createActivity(draft: ActivityDraft, monologue: string, source: Activity['source'], state: Pick<AgentState, 'inventory'>): Activity {
  return {
    id: shortId('act_'), what: draft.what, why: draft.why, kind: draft.kind, steps: draft.steps.map((s) => ({ ...s })),
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
export function nextStep(a: Activity): Step | null {
  if (a.index >= a.steps.length) {
    if (a.iteration + 1 >= a.repeat) return null;
    a.iteration++;
    a.index = 0;
    a.climbSpent = {}; // 新一轮：重置累计额度，从原始参数开始。
  }
  const step = a.steps[a.index++];
  if (!step) return null;
  // climb_up 跨自动重试/恢复共享剩余额度：派发时按累计已爬格数扣减，只改本次派发的副本，不改模板。
  if (step.skill === 'climb_up' && a.climbSpent) {
    const spent = a.climbSpent[JSON.stringify(step.args ?? {})] ?? 0;
    if (spent > 0) {
      const args = step.args && typeof step.args === 'object' && !Array.isArray(step.args) ? { ...step.args } : step.args;
      if (args && typeof args === 'object' && !Array.isArray(args)) {
        const height = (args as Record<string, unknown>).height;
        if (typeof height === 'number') {
          (args as Record<string, unknown>).height = Math.max(1, height - spent);
          return { skill: step.skill, args };
        }
      }
    }
  }
  return { skill: step.skill, args: step.args };
}

/** 还剩多少个动作（估计，用来决定什么时候开始想“接下来做什么”） */
export function remainingSteps(a: Activity): number {
  return Math.max(0, a.steps.length - a.index) + Math.max(0, a.repeat - a.iteration - 1) * a.steps.length;
}

/** 顺手的步骤遇到这些失败，再做几轮也一样：直接从这段活里去掉 */
const OPTIONAL_HOPELESS = new Set(['TARGET_GONE', 'BAD_ARGS', 'UNKNOWN_ITEM', 'WRONG_DIMENSION']);

/** 失败了值得原样再试一次的情况（路被挡、东西跑了、偶发错误） */
const RETRYABLE = new Set(['TIMEOUT', 'STUCK', 'PATH_NOT_FOUND', 'TARGET_GONE', 'ERROR', 'EFFECT_NOT_CONFIRMED']);
/** 不想清楚就没法继续的失败（缺材料、缺工具、背包满…） */
const NEEDS_THOUGHT = new Set(['MISSING_MATERIALS', 'NO_CRAFTING_TABLE', 'TOOL_MISSING', 'UNKNOWN_ITEM', 'BAD_ARGS', 'INVENTORY_FULL', 'NO_FOOD', 'WRONG_DIMENSION', 'LOW_HP']);

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
    return `；收工条件未满足或无法确认：${JSON.stringify(a.doneWhen)}；状态 ${evidence.status}，实际 ${JSON.stringify(evidence.actual)}；位置 (${state.pos.x.toFixed(1)},${state.pos.y.toFixed(1)},${state.pos.z.toFixed(1)})`;
  };
  const previous = [...a.results].reverse().find((r) => r.status === 'failed' && targetKeyOf(r) === targetKeyOf(step));
  const view = viewOf(percept);
  const baseline = previous?.pos ? previous : a.stepStart;
  const changed = !!baseline && (!!baseline.pos && Math.hypot(state.pos.x - baseline.pos.x, state.pos.y - baseline.pos.y, state.pos.z - baseline.pos.z) >= 0.5 ||
    baseline.view !== undefined && view !== undefined && baseline.view !== view);
  const previousPosition = a.results.at(-1)?.pos;
  if (previousPosition && JSON.stringify(feetCell(previousPosition)) !== JSON.stringify(feetCell(state.pos))) delete a.airDigs;
  a.results.push({ skill: step.skill, args: step.args, status: result.status, failureCode: result.failureCode, summary: result.summary.slice(0, 160), at: Date.now(), durationMs, pos: { ...state.pos }, ...(view !== undefined ? { view } : {}) });
  if (a.results.length > 16) a.results = a.results.slice(-16);
  if (result.status === 'succeeded') {
    a.consecutiveFailures = 0;
    // climb_up 成功：本逻辑动作额度用完，清掉累计，下一轮从原始参数开始。
    if (step.skill === 'climb_up' && a.climbSpent) delete a.climbSpent[JSON.stringify(a.steps[Math.max(0, a.index - 1)]?.args ?? step.args ?? {})];
    // 恢复（use_skill）内部爬升也要入账：失败时的站位到现在的净上升，加回父动作余额，避免原动作又整段重爬。
    if (step.skill === 'use_skill') {
      const failure = (step.args as Record<string, unknown> | undefined)?.failure as { skill?: string; position?: { y: number } } | undefined;
      if (failure?.skill === 'climb_up' && typeof failure.position?.y === 'number') {
        const dy = Math.floor(state.pos.y) - Math.floor(failure.position.y);
        if (dy > 0) {
          const climbStep = a.steps.find((s) => s.skill === 'climb_up');
          if (climbStep) {
            const key = JSON.stringify(climbStep.args ?? {});
            a.climbSpent ??= {};
            a.climbSpent[key] = (a.climbSpent[key] ?? 0) + dy;
          }
        }
      }
    }
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
      if (a.doneWhen) return { kind: 'done', met: false, why: `${a.repeat} 轮做完了（最后一步：${result.summary.slice(0, 160)}）${conditionUnmet()}` };
      return { kind: 'done', met: true, why: '这段活的步骤都做完了' };
    }
    return { kind: 'continue' };
  }
  if (result.status === 'cancelled') return { kind: 'continue' };
  if (softMiss(a, step, result)) {
    a.consecutiveFailures = 0;
    const own = ownStep(a, step);
    const optional = own?.optional === true;
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
  const key = `${a.index - 1}:${step.skill}:${code}`;
  if (a.failures >= 5) return { kind: 'stuck', why: `这段活已经失败 ${a.failures} 次了（最近：${result.summary.slice(0, 80)}）` };
  if (NEEDS_THOUGHT.has(code)) return { kind: 'stuck', why: result.summary.slice(0, 160) };
  // 机械执行失败先由身体就地应变（照亮、垫支撑、清头顶），补不动才交给脑子——脑子想不出“太暗/没支撑/头顶被挡”的新答案。
  const data = result.data as Record<string, any> | undefined;
  const stepArgs = (step.args ?? {}) as Record<string, any>;
  const facing = stepArgs.facing ?? a.facing;
  const hasItem = (re: RegExp) => state.inventory.some((i) => i.count > 0 && re.test(i.name));
  const dark = percept?.light != null && percept.light.level !== 'bright';
  const adapt = (skill: string, args: unknown, what: string, tag: string): StepVerdict => {
    // 用稳定的步签名（不随 index 因插步而偏移）标记「同一逻辑步只应变一次」
    const mark = `${tag}:${step.skill}:${code}:${JSON.stringify(step.args ?? {}).slice(0, 60)}`;
    if (a.adaptations.includes(mark)) return { kind: 'stuck', why: result.summary.slice(0, 160) };
    a.adaptations.push(mark);
    a.steps.splice(Math.max(0, a.index - 1), 0, { skill, args });
    a.index = Math.max(0, a.index - 1);
    return { kind: 'continue', adapted: what };
  };
  // 1) 看不清：先照亮再看（没火把或不暗就照旧交回）
  if (data?.obscured) {
    if (dark && hasItem(/^torch$/)) return adapt('place_torch', {}, '看不清，先插火把照亮再试', 'light');
    return { kind: 'stuck', why: result.summary.slice(0, 160) };
  }
  // climb_up 已实际爬升但未满足停止条件：把已爬格数累计进本轮额度（不写回模板），后续清障/重试/恢复只爬剩余额度；
  // 额度耗尽就标记 exhausted，由调度器终止自动推进（不再插恢复、不再重放原动作），避免 16 格变 33 格。
  if (step.skill === 'climb_up' && typeof data?.climbed === 'number' && data.climbed > 0 && data?.goalReached === false) {
    const own = a.steps[Math.max(0, a.index - 1)];
    const key = JSON.stringify(own?.args ?? step.args ?? {});
    const spent = (a.climbSpent?.[key] ?? 0) + data.climbed;
    a.climbSpent ??= {};
    a.climbSpent[key] = spent;
    const height = own?.skill === 'climb_up' && own.args && typeof own.args === 'object' ? (own.args as Record<string, unknown>).height : undefined;
    if (typeof height === 'number' && spent >= height) return { kind: 'stuck', why: result.summary.slice(0, 160), exhausted: true };
  }
  // 3) 头顶跳跃空间受阻：先挖开头顶再垫/迈。place_at / climb_up 是 Agent 明确要「往上」，自动清头顶属于稳定执行已选动作。
  if (step.skill === 'place_at' && data?.pillarFailure === 'NOT_PLACED:头顶跳跃空间受阻'
    || step.skill === 'climb_up' && data?.failureCause === 'PILLAR_CLEARANCE') {
    // 障碍格可能有多格（身后/侧上方）：一次全挖空，别再一格一格挤牙膏、也别硬编码 [0,2,0]
    const cells: { at: [number, number, number]; facing?: string }[] = data?.pillarClearance?.cells?.length
      ? data.pillarClearance.cells
      : [{ at: data?.pillarClearance?.at ?? [0, 2, 0], facing: data?.pillarClearance?.facing ?? facing }];
    const mark = `clearance:${step.skill}:${code}:${JSON.stringify(step.args ?? {}).slice(0, 60)}`;
    if (a.adaptations.includes(mark)) return { kind: 'stuck', why: result.summary.slice(0, 160) };
    a.adaptations.push(mark);
    a.steps.splice(Math.max(0, a.index - 1), 0, ...cells.map((c) => ({ skill: 'dig_at', args: { at: c.at, ...(c.facing ? { facing: c.facing } : {}) } })));
    a.index = Math.max(0, a.index - 1);
    return { kind: 'continue', adapted: `头顶被挡，先把 ${cells.length} 格障碍全挖开再走` };
  }
  // goto 是「委托寻路」：头顶被挡是路线事实，不替 Agent 决定挖哪一格——挖开、绕行还是退回去由它定。
  if (step.skill === 'goto' && data?.pillarClearance) return { kind: 'stuck', why: result.summary.slice(0, 160) };
  // 未加载 = 看不清：并入照亮分支
  if (step.skill === 'place_at' && data?.pillarFailure === 'NOT_PLACED:头顶跳跃空间未加载') {
    if (dark && hasItem(/^torch$/)) return adapt('place_torch', {}, '头顶跳跃空间未加载，先照亮再看', 'light');
    return { kind: 'stuck', why: result.summary.slice(0, 160) };
  }
  if (step.skill === 'place_at' && data?.pillarFailure === 'NOT_PLACED:跳不起来') return { kind: 'stuck', why: result.summary.slice(0, 160) };
  // 4) 脚下有非空气的可替换物（火把/草/雪层…）：先拿掉再垫（同头顶清障，属于稳定执行已选动作）
  if (step.skill === 'place_at' && typeof data?.pillarFailure === 'string' && data.pillarFailure.startsWith('BLOCKED:')) {
    return adapt('dig_at', { at: [0, 0, 0], ...(facing ? { facing } : {}) }, '脚下有东西挡住垫高，先拿掉再垫', 'clearance');
  }
  // 5) 脚下没有实心地面（悬空/水里/梯子上）或服务器拒放：原地垫高垫不了，别白重试，把事实交回脑子
  if (step.skill === 'place_at' && (data?.pillarFailure === 'NO_REFERENCE' || typeof data?.pillarFailure === 'string' && data.pillarFailure.startsWith('NOT_PLACED:Server'))) {
    return { kind: 'stuck', why: result.summary.slice(0, 160) };
  }
  // 其余的 step 落点问题（目标格/头顶是看得见的 stone 等）仍交回：要先挖哪一格是规划决定。
  if (step.skill === 'step' && data?.movementNotAttempted === true) return { kind: 'stuck', why: result.summary.slice(0, 160) };
  // excavate_path 预检阶段就拒绝（一步没推进、一铲没挖）：确定性缺口不能只靠转头/视图变化原样重试，交回事实由心智决定。
  if (step.skill === 'excavate_path' && data?.completedSteps === 0 && (data?.excavatedBlocks ?? 0) === 0) return { kind: 'stuck', why: result.summary.slice(0, 160) };
  if (RETRYABLE.has(code) && !(step.skill === 'goto' && code === 'PATH_NOT_FOUND') && changed && a.consecutiveFailures === 1 && !a.adaptations.includes(`retry:${key}`)) {
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
  return {
    what: a.what, why: a.why, kind: a.kind,
    ...(a.facing ? { facing: a.facing } : {}),
    routine: a.steps.map((s) => `${s.skill} ${argsLabel(s)}${s.optional ? '（顺手）' : ''}`),
    round: `${a.iteration + 1}/${a.repeat}`, next_step: a.index,
    elapsed_real_s: Math.round((Date.now() - a.startedAt) / 1000),
    ...(done ? { done_when: { status: done.status, actual: done.actual } } : {}),
    ...(a.failures ? { failures: a.failures } : {}),
    ...(a.adaptations.length ? { body_adapted: a.adaptations } : {}),
    ...(a.dropped?.length ? { not_done_rejected: a.dropped } : {}),
    recent: a.results.slice(-3).map((r) => `${r.skill} → ${r.status}${r.failureCode ? `(${r.failureCode})` : ''}：${r.summary.slice(0, 80)}`),
    ...(a.expect ? { my_expectation: a.expect } : {}),
    ...(a.hypothesis ? { hypothesis: a.hypothesis } : {}),
  };
}
