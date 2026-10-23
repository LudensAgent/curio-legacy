import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Arbiter } from '../src/arbiter/arbiter.ts';
import { Executive } from '../src/brain/executive.ts';
import { Reflex } from '../src/brain/reflex.ts';
import { config } from '../src/config.ts';
import { EventBus, type AgentEvent } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Perception } from '../src/perception/perception.ts';
import { MockProvider, type LlmProvider } from '../src/planner/llm.ts';
import { ruleProposal } from '../src/planner/plan.ts';
import { Planner } from '../src/planner/planner.ts';
import { sleep } from '../src/util.ts';
import { FakeAdapter } from './fake-adapter.ts';

function world(provider: (p: (hint: any) => Record<string, unknown>) => LlmProvider) {
  const adapter = new FakeAdapter();
  for (let i = 0; i < 12; i++) adapter.blocks.push({ name: 'oak_log', pos: { x: 6 + i, y: 64, z: (i % 3) * 2 } });
  for (let i = 0; i < 8; i++) adapter.blocks.push({ name: 'stone', pos: { x: -4 - i, y: 62, z: 3 } });
  const bus = new EventBus();
  const events: AgentEvent[] = [];
  bus.on('event', (e: AgentEvent) => events.push(e));
  const memory = new WorldMemory(null);
  const arbiter = new Arbiter(adapter, memory, bus);
  const perception = new Perception(adapter, memory, bus);
  const cfg = { ...config, llm: { ...config.llm, maxCallsPerHour: 1000, timeoutMs: 10000, fakeDelayMs: 0 } };
  const planner = new Planner(cfg, provider((hint: any) => ruleProposal(hint.percept, memory, hint.reason === 'prefetch' ? hint.current : null)), adapter, memory, bus, null);
  const executive = new Executive({ adapter, arbiter, planner, perception, memory, bus });
  const reflex = new Reflex(adapter, arbiter, bus);
  perception.start(300);
  executive.start(100);
  const stop = () => {
    executive.stop();
    perception.stop();
    reflex.stop();
    arbiter.cancel('test end');
  };
  return { adapter, bus, events, memory, arbiter, executive, reflex, planner, stop };
}

test('LLM 每次思考 2.5 秒时，角色在思考期间仍持续行动（连贯性 ≥ 90%）', async () => {
  const w = world((p) => new MockProvider(0, p, [2500, 2500]));
  const samples: { busy: boolean; llm: boolean }[] = [];
  const iv = setInterval(() => samples.push({ busy: !!w.arbiter.info(), llm: w.executive.inFlight }), 100);
  await sleep(9000);
  clearInterval(iv);
  w.stop();

  const during = samples.filter((s) => s.llm);
  const continuity = during.filter((s) => s.busy).length / Math.max(1, during.length);
  const idle = samples.slice(3).filter((s) => !s.busy).length / samples.length;
  const llmTasks = w.events.filter((e) => e.type === 'task_start' && e.msg.startsWith('[llm]')).length;
  const fillers = w.events.filter((e) => e.type === 'task_start' && e.msg.startsWith('[filler]')).length;
  console.log(`  LLM 思考采样 ${during.length}，其中在行动 ${(continuity * 100).toFixed(0)}%；整体空闲 ${(idle * 100).toFixed(1)}%；LLM 任务 ${llmTasks}，填充 ${fillers}`);
  assert.ok(during.length > 10, '应该有 LLM 思考时段');
  assert.ok(continuity >= 0.9, `连贯性 ${continuity}`);
  assert.ok(idle < 0.1, `空闲比例 ${idle}`);
  assert.ok(llmTasks >= 2, '应执行至少 2 个来自 LLM 计划的任务');
  assert.ok(fillers >= 1, '第一次思考期间应有填充行为');
  assert.ok((w.adapter.inv.get('oak_log') ?? 0) > 0, '应真的采集到原木');
});

test('预规划：最后一步进行中就提前请求下一个计划', async () => {
  const w = world((p) => new MockProvider(0, p, [500, 500]));
  await sleep(5000);
  w.stop();
  const reasons = w.events.filter((e) => e.type === 'llm_request').map((e) => e.msg);
  console.log('  ' + reasons.join(' | '));
  assert.ok(reasons.some((r) => r.includes('prefetch')), '应出现 prefetch 请求');
});

test('LLM 出错时退回规则目标，Agent 不停下', async () => {
  const broken: LlmProvider = { name: 'broken', complete: async () => { throw new Error('connection refused'); } };
  const w = world(() => broken);
  await sleep(3000);
  w.stop();
  assert.ok(w.events.some((e) => e.type === 'llm_error'));
  assert.ok(w.events.some((e) => e.type === 'task_start' && e.msg.startsWith('[rule]')), '应执行规则计划');
});

test('模型输出无效 JSON 时回传错误重试，再失败则用规则目标', async () => {
  let n = 0;
  const bad: LlmProvider = { name: 'bad', complete: async () => ({ text: n++ % 2 ? '{"goal":"x","steps":[{"skill":"fly"}]}' : '我觉得应该去砍树', latencyMs: 1 }) };
  const w = world(() => bad);
  await sleep(1500);
  w.stop();
  assert.ok(w.events.filter((e) => e.type === 'llm_invalid').length >= 2);
  assert.ok(w.planner.stats.invalid >= 2);
  assert.ok(w.events.some((e) => e.type === 'task_start' && e.msg.startsWith('[rule]')));
});

test('反射层：敌对生物贴近时抢占当前任务，处理完后重试被打断的步骤', async () => {
  const w = world((p) => new MockProvider(0, p, [200, 200]));
  w.adapter.speed = 2; // 走得慢，确保任务在进行中被打断
  w.reflex.start(100);
  await sleep(1500);
  const p = w.adapter.pos;
  w.adapter.entities.push({ id: 99, name: 'zombie', kind: 'hostile', pos: { x: p.x + 2, y: p.y, z: p.z }, dist: 2 });
  await sleep(2500);
  w.stop();
  assert.ok(w.events.some((e) => e.type === 'reflex' && e.msg.includes('zombie')), '应触发反射');
  assert.ok(w.adapter.actions.includes('attack:99'), '应攻击僵尸');
  assert.ok(w.events.some((e) => e.type === 'resume_step'), '应重试被打断的步骤');
});
