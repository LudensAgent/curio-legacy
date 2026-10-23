import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import type { Percept } from '../src/perception/perception.ts';
import type { Completion, LlmProvider } from '../src/planner/llm.ts';
import { Planner } from '../src/planner/planner.ts';
import type { PlanContext } from '../src/planner/prompt.ts';
import { FakeAdapter } from './fake-adapter.ts';

const validPlan = JSON.stringify({ goal: '探索附近', steps: [{ skill: 'wander' }] });
const emptyUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, unreportedCalls: 0 };
const percept = {
  ts: 0, connected: true, time: { timeOfDay: 1000, phase: 'day' },
  self: { pos: [0, 64, 0], dim: 'overworld', hp: 20, food: 20, biome: 'plains', inWater: false, inLava: false, held: null },
  inventory: [], emptySlots: 36, nearby: { hostile: [], passive: [], players: [], resources: [] },
  vision: null, death_recovery: null, curiosities: [], objective: null, drives: [], stock: null,
  efficiency: [],
  light: null, storage: null, farms: [], learn_candidates: [], reflection_due: false,
  exploration: { visitedChunks: 1, noveltyByDir: { N: 1 }, base: null },
} as Percept;
const context: PlanContext = { reason: 'no_goal', percept, current: null, lastFailure: null, userSuggestion: null };

function reply(usage?: unknown, text = validPlan): Completion {
  return { text, latencyMs: 1, usage: usage as Completion['usage'] };
}

function fixture(responses: (Completion | Error)[], maxCallsPerHour = 1000) {
  const pending = [...responses];
  const provider: LlmProvider = {
    name: 'usage-test',
    async complete() {
      const next = pending.shift();
      assert.ok(next, '不应产生额外的 LLM 调用');
      if (next instanceof Error) throw next;
      return next;
    },
  };
  const cfg = { ...config, llm: { ...config.llm, maxCallsPerHour, timeoutMs: 1000, fakeDelayMs: 0 } };
  const planner = new Planner(cfg, provider, new FakeAdapter(), new WorldMemory(null), new EventBus(), null);
  return { planner, pending };
}

test('LLM token 用量从零开始累加，优先采用服务端总数，缺少总数时使用输入与输出之和', async () => {
  const { planner } = fixture([
    reply({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 17 }),
    reply({ prompt_tokens: 20, completion_tokens: 7 }),
    reply({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }),
  ]);
  assert.deepEqual(planner.stats.tokenUsage, emptyUsage);
  await planner.propose(context);
  assert.deepEqual(planner.stats.tokenUsage, { promptTokens: 10, completionTokens: 5, totalTokens: 17, unreportedCalls: 0 });
  await planner.propose(context);
  await planner.propose(context);
  assert.deepEqual(planner.stats.tokenUsage, { promptTokens: 30, completionTokens: 12, totalTokens: 44, unreportedCalls: 0 });
  assert.equal(planner.stats.calls, 3);
});

test('无效输出的重试也计入启动以来的 token 用量，每次调用只累计一次', async () => {
  const { planner, pending } = fixture([
    reply({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }, '没有 JSON'),
    reply({ prompt_tokens: 14, completion_tokens: 3, total_tokens: 17 }),
  ]);
  await planner.propose(context);
  assert.deepEqual(planner.stats.tokenUsage, { promptTokens: 24, completionTokens: 5, totalTokens: 29, unreportedCalls: 0 });
  assert.equal(planner.stats.invalid, 1);
  assert.equal(planner.stats.ok, 1);
  assert.equal(planner.stats.calls, 2);
  assert.equal(pending.length, 0);
});

test('无效输出耗尽重试后仍保留两次调用的 token 用量', async () => {
  const { planner } = fixture([
    reply({ prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }, '无效'),
    reply({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }, '{"goal":"x","steps":[{"skill":"fly"}]}'),
  ]);
  await assert.rejects(planner.propose(context), /INVALID_PLAN/);
  assert.deepEqual(planner.stats.tokenUsage, { promptTokens: 8, completionTokens: 3, totalTokens: 11, unreportedCalls: 0 });
  assert.equal(planner.stats.invalid, 2);
});

test('缺失或非法 usage 不估算 token，调用异常也标记为未上报', async () => {
  const invalidUsage = [
    undefined,
    null,
    {},
    { prompt_tokens: -1, completion_tokens: -2, total_tokens: -3 },
    { prompt_tokens: NaN, completion_tokens: Infinity, total_tokens: NaN },
    { prompt_tokens: '10', completion_tokens: '5', total_tokens: '15' },
    { prompt_tokens: 0.5, completion_tokens: 1.5, total_tokens: 2.5 },
  ];
  const { planner } = fixture([...invalidUsage.map((usage) => reply(usage)), new Error('connection refused')]);
  for (const _usage of invalidUsage) await planner.propose(context);
  await assert.rejects(planner.propose(context), /connection refused/);
  assert.deepEqual(planner.stats.tokenUsage, { ...emptyUsage, unreportedCalls: invalidUsage.length + 1 });
  assert.equal(planner.stats.errors, 1);
});

test('部分上报只累计已知字段，并标记未完整上报的调用', async () => {
  const { planner } = fixture([
    reply({ total_tokens: 17 }),
    reply({ prompt_tokens: 4 }),
  ]);
  await planner.propose(context);
  await planner.propose(context);
  assert.deepEqual(planner.stats.tokenUsage, { promptTokens: 4, completionTokens: 0, totalTokens: 21, unreportedCalls: 2 });
});

test('新 Planner 重置启动累计值，规则预算回退不增加 token 用量', async () => {
  const { planner } = fixture([reply({ prompt_tokens: 6, completion_tokens: 4, total_tokens: 10 })], 1);
  await planner.propose(context);
  const result = await planner.propose(context);
  assert.equal(result.source, 'rule');
  assert.equal(planner.stats.calls, 1);
  assert.equal(planner.stats.budgetFallbacks, 1);
  assert.deepEqual(planner.stats.tokenUsage, { promptTokens: 6, completionTokens: 4, totalTokens: 10, unreportedCalls: 0 });
  const fresh = fixture([]).planner;
  assert.deepEqual(fresh.stats.tokenUsage, emptyUsage);
});

test('连续多次调用和小时窗口过期都不会清空启动累计用量', async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { planner } = fixture(Array.from({ length: 26 }, () => reply({ prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 })));
  for (let i = 0; i < 25; i++) await planner.propose(context);
  assert.deepEqual(planner.stats.tokenUsage, { promptTokens: 50, completionTokens: 25, totalTokens: 75, unreportedCalls: 0 });

  now += 3_600_001;
  assert.equal(planner.budgetOk(), true);
  assert.equal(planner.stats.callsLastHour, 0);
  assert.equal(planner.stats.tokenUsage.totalTokens, 75);
  await planner.propose(context);
  assert.deepEqual(planner.stats.tokenUsage, { promptTokens: 52, completionTokens: 26, totalTokens: 78, unreportedCalls: 0 });
});
