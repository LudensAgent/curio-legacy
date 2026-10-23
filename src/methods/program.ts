import type { AgentState, GameAdapter } from '../adapter/types.ts';
import type { WorldMemory } from '../memory/store.ts';
import { evaluateCondition, validateCondition } from '../projects/conditions.ts';
import { SKILLS, LLM_HIDDEN } from '../skills/index.ts';
import type { SkillCtx, SkillResult } from '../skills/types.ts';
import { fail, ok } from '../skills/types.ts';
import { throwIfAborted } from '../util.ts';

export interface Parameter {
  type: 'integer' | 'item' | 'string';
  default: number | string;
  min?: number;
  max?: number;
  values?: string[];
}
export type Parameters = Record<string, Parameter>;
export type Program =
  | { type: 'call'; skill: string; args?: unknown }
  | { type: 'sequence'; steps: Program[] }
  | { type: 'if'; condition: unknown; then: Program; else?: Program }
  | { type: 'repeat'; times: number | { param: string }; body: Program };

export function substitute(value: unknown, parameters: Record<string, string | number>, depth = 0): any {
  if (depth > 12) throw new Error('参数模板过深');
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => substitute(v, parameters, depth + 1));
  const object = value as Record<string, unknown>;
  if ('param' in object) {
    if (Object.keys(object).length !== 1 || typeof object.param !== 'string' || !(object.param in parameters)) throw new Error('未知参数引用');
    return parameters[object.param];
  }
  return Object.fromEntries(Object.entries(object).map(([key, v]) => {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('不支持的参数字段');
    return [key, substitute(v, parameters, depth + 1)];
  }));
}

export function validateParameters(raw: unknown, adapter: Pick<GameAdapter, 'isKnownItem'>): Parameters {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length > 8) throw new Error('最多支持 8 个具名参数');
  const output: Parameters = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!/^[a-z][a-z0-9_]{0,30}$/.test(name) || ['constructor', 'prototype'].includes(name) || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('参数定义无效');
    const parameter = value as Parameter;
    if (!['integer', 'item', 'string'].includes(parameter.type)) throw new Error('只支持整数、具体物品和枚举文字参数');
    if (parameter.type === 'integer') {
      const min = parameter.min ?? 1, max = parameter.max ?? 64;
      if (![min, max, parameter.default].every((n) => typeof n === 'number' && Number.isFinite(n) && Number.isInteger(n)) || min < -1024 || max > 2304 || max < min || Number(parameter.default) < min || Number(parameter.default) > max) throw new Error('整数参数范围或默认值无效');
      output[name] = { type: 'integer', min, max, default: parameter.default };
    } else {
      if (!Array.isArray(parameter.values) || !parameter.values.length || parameter.values.length > 20 || parameter.values.some((v) => typeof v !== 'string' || !v || v.length > 80) || !parameter.values.includes(String(parameter.default))) throw new Error('文字参数需要有限的允许值和默认值');
      if (parameter.type === 'item' && parameter.values.some((v) => !adapter.isKnownItem(v))) throw new Error('物品参数包含未知物品');
      output[name] = { type: parameter.type, values: [...new Set(parameter.values)], default: parameter.default };
    }
  }
  return output;
}

export function bindParameters(definitions: Parameters, raw: unknown): Record<string, string | number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('parameters 须为对象');
  if (Object.keys(raw).some((name) => !Object.hasOwn(definitions, name))) throw new Error('提供了未知参数');
  return Object.fromEntries(Object.entries(definitions).map(([name, definition]) => {
    const value = (raw as any)[name] ?? definition.default;
    if (definition.type === 'integer' ? typeof value !== 'number' || !Number.isInteger(value) || value < definition.min! || value > definition.max! : typeof value !== 'string' || !definition.values!.includes(value)) throw new Error(`参数 ${name} 超出允许范围`);
    return [name, value];
  }));
}

export function validateProgram(raw: unknown, parameters: Record<string, string | number>, adapter: GameAdapter, memory: WorldMemory, state: AgentState): Program {
  let nodes = 0;
  const walk = (node: any, depth: number): Program => {
    if (++nodes > 32 || depth > 5 || !node || typeof node !== 'object' || Array.isArray(node)) throw new Error('程序最多 32 个节点、5 层嵌套');
    if (node.type === 'call') {
      const skill = SKILLS[node.skill];
      if (!skill || LLM_HIDDEN.has(node.skill) || node.skill.includes(':')) throw new Error(`不可组合的底层技能: ${String(node.skill)}`);
      const validation = skill.validate(substitute(node.args ?? {}, parameters), adapter);
      if (!validation.ok) throw new Error(`${node.skill}: ${validation.error}`);
      return { type: 'call', skill: node.skill, args: structuredClone(node.args ?? {}) };
    }
    if (node.type === 'sequence') {
      if (!Array.isArray(node.steps) || !node.steps.length || node.steps.length > 12) throw new Error('sequence 需要 1–12 个子节点');
      return { type: 'sequence', steps: node.steps.map((step: unknown) => walk(step, depth + 1)) };
    }
    if (node.type === 'repeat') {
      const times = substitute(node.times, parameters);
      if (!Number.isInteger(times) || times < 1 || times > 8) throw new Error('repeat 次数须为 1–8');
      return { type: 'repeat', times: structuredClone(node.times), body: walk(node.body, depth + 1) };
    }
    if (node.type === 'if') {
      validateCondition(substitute(node.condition, parameters), adapter, memory, state);
      return { type: 'if', condition: structuredClone(node.condition), then: walk(node.then, depth + 1), ...(node.else ? { else: walk(node.else, depth + 1) } : {}) };
    }
    throw new Error('只支持 call / sequence / if / repeat');
  };
  const program = walk(raw, 0);
  const cost = (node: Program): number => node.type === 'call' ? 1 : node.type === 'sequence' ? node.steps.reduce((sum, child) => sum + cost(child), 0) : node.type === 'repeat' ? substitute(node.times, parameters) * cost(node.body) : Math.max(cost(node.then), node.else ? cost(node.else) : 0);
  if (cost(program) > 64) throw new Error('方法在最坏路径超过 64 个底层动作');
  if (JSON.stringify(program).length > 16_000) throw new Error('程序过大');
  return program;
}

/** Runs solely within the Arbiter's guarded context, retaining the same task and AbortSignal. */
export async function executeProgram(program: Program, parameters: Record<string, string | number>, ctx: SkillCtx): Promise<SkillResult> {
  let remainingCalls = 64;
  const run = async (node: Program): Promise<SkillResult> => {
    throwIfAborted(ctx.signal);
    if (Date.now() >= ctx.deadline) return fail('TIMEOUT', '方法执行时间预算耗尽');
    if (node.type === 'call') {
      if (--remainingCalls < 0) return fail('BAD_ARGS', '方法执行超过 64 个底层动作');
      const skill = SKILLS[node.skill];
      if (!skill || LLM_HIDDEN.has(node.skill) || node.skill.includes(':')) return fail('BAD_ARGS', '底层技能已不可用');
      const validation = skill.validate(substitute(node.args ?? {}, parameters), ctx.adapter);
      if (!validation.ok) return fail('BAD_ARGS', validation.error);
      const result = await skill.run({ ...ctx, deadline: Math.min(ctx.deadline, Date.now() + skill.timeoutMs) }, validation.args);
      throwIfAborted(ctx.signal);
      return result;
    }
    if (node.type === 'sequence') {
      for (const child of node.steps) { const result = await run(child); if (result.status !== 'succeeded') return result; }
    } else if (node.type === 'repeat') {
      const times = substitute(node.times, parameters);
      if (!Number.isInteger(times) || times < 1 || times > 8) return fail('BAD_ARGS', '循环次数无效');
      for (let i = 0; i < times; i++) { const result = await run(node.body); if (result.status !== 'succeeded') return result; }
    } else {
      const state = ctx.adapter.state();
      const condition = validateCondition(substitute(node.condition, parameters), ctx.adapter, ctx.memory, state);
      const result = evaluateCondition(condition, state);
      if (result.status === 'unknown') return fail('NOT_CONNECTED', '分支条件没有有效观测');
      const branch = result.status === 'satisfied' ? node.then : node.else;
      if (branch) return run(branch);
    }
    return ok('受限方法程序执行结束');
  };
  return run(program);
}
