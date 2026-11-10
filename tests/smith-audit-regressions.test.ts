import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { SkillSmith, type ForgeKind } from '../src/codeskills/smith.ts';
import { EventBus } from '../src/events.ts';
import { SkillBook } from '../src/knowledge/skillbook.ts';
import { BehaviorEngine } from '../src/mind/behaviors.ts';
import type { ChatMessage, Completion } from '../src/planner/llm.ts';
import { FakeAdapter } from './fake-adapter.ts';

const flush = async () => { for (let i = 0; i < 12; i++) await setImmediate(); };
const observation = (name: string) => ({ name, description: '重新观察身体状态', steps: [{ skill: 'look_around', args: { seconds: 2 } }],
  verify: 'const s = await api.state(); return s.hp > 0 ? true : "已死亡";' });

function setup(t: TestContext, reply: (call: number) => unknown) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-smith-audit-'));
  const adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(null, directory);
  const engine = new BehaviorEngine(book, adapter, null, bus, { perceivedEntities: () => [] });
  const prompts: ChatMessage[][] = [];
  const planner = { autonomous: false, noteInvalid() {}, async complete(messages: ChatMessage[]): Promise<Completion> {
    prompts.push(messages.map((m) => ({ ...m })));
    return { text: JSON.stringify(reply(prompts.length)), latencyMs: 1 };
  } };
  const smith = new SkillSmith(planner, engine, book, bus, () => adapter.state(), () => [], { maxPerHour: 24, repeatMs: 20 * 60_000 });
  const internal = smith as unknown as { next(): void; queue: { headline: string; retryAt?: number }[]; handledAt: Map<string, number> };
  const batch = (kinds: ForgeKind[]) => {
    kinds.forEach((kind) => smith.report(kind, Date.now(), `${kind} request`, 0));
    planner.autonomous = true;
    internal.next();
  };
  t.after(() => { smith.stop(); engine.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { smith, internal, planner, prompts, batch, bus, engine, book };
}

test('F7：批量漏回事件补问原编号，不把第一件 none 当成整批完成', async (t) => {
  const r = setup(t, (call) => ({ results: [{ event: call, none: true, why: `第 ${call} 件无需生成` }] }));
  r.batch(['noted', 'recurring']);
  await flush();
  assert.equal(r.prompts.length, 2);
  assert.match(r.prompts[1].at(-1)!.content, /第 2 件没有结论/);
  assert.equal(r.bus.recent().filter((e) => e.type === 'skill_forge_none').length, 2);
  assert.equal(r.internal.queue.length, 0);
  assert.equal(r.internal.handledAt.size, 2);
});

test('F7：三次漏回后明确延期，重试不被已处理去重吞掉', async (t) => {
  const r = setup(t, (call) => call <= 3 ? { results: [{ event: 1, none: true, why: '只回答第一件' }] } : { none: true, why: '补上第二件结论' });
  r.batch(['noted', 'recurring']);
  await flush();
  assert.equal(r.prompts.length, 3);
  assert.equal(r.internal.queue.length, 1);
  assert.equal(r.internal.queue[0].headline, 'recurring request');
  assert.equal(r.internal.handledAt.size, 1);
  assert.equal(r.bus.recent().find((e) => e.type === 'skill_forge_deferred')?.data?.reason, 'missing_result');
  r.internal.queue[0].retryAt = Date.now() - 1;
  r.internal.next();
  await flush();
  assert.equal(r.prompts.length, 4);
  assert.equal(r.internal.queue.length, 0);
  assert.equal(r.internal.handledAt.size, 2);
  assert.equal(r.bus.recent().filter((e) => e.type === 'skill_forge_skipped').length, 0);
});

test('F7：两份写入预算耗尽只延期未处理事件，仍接受其他事件的明确 none', async (t) => {
  const r = setup(t, (call) => call === 1 ? { results: [
    { event: 1, skill: observation('first-observation') },
    { event: 2, skill: observation('second-observation') },
    { event: 3, skill: observation('third-observation') },
    { event: 4, none: true, why: '无须技能' },
  ] } : { skill: observation('third-observation') });
  r.batch(['noted', 'recurring', 'repeated', 'review']);
  await flush();
  assert.equal(r.prompts.length, 1);
  assert.equal(r.engine.list(true).length, 2);
  assert.equal(r.internal.handledAt.size, 3);
  assert.equal(r.internal.queue.length, 1);
  assert.equal(r.internal.queue[0].headline, 'repeated request');
  assert.equal(r.bus.recent().find((e) => e.type === 'skill_forge_deferred')?.data?.reason, 'budget');
  r.internal.queue[0].retryAt = Date.now() - 1;
  r.internal.next();
  await flush();
  assert.equal(r.engine.list(true).length, 3);
  assert.equal(r.internal.queue.length, 0);
});

test('F7：生成失败保留请求，与没有学习必要和漏回分别记录', async (t) => {
  const r = setup(t, () => ({ results: [{ event: 1, none: true, why: '无需生成' }, { event: 2, skill: { name: 'invalid-draft' } }] }));
  r.batch(['noted', 'recurring']);
  await flush();
  assert.equal(r.prompts.length, 3);
  assert.equal(r.internal.queue.length, 1);
  assert.equal(r.internal.handledAt.size, 1);
  assert.equal(r.bus.recent().find((e) => e.type === 'skill_forge_deferred')?.data?.reason, 'generation_failed');
});

test('F7：模型调用抛错也保留尚无结论的事件，不立即循环请求', async (t) => {
  const r = setup(t, () => { throw new Error('模拟网络失败'); });
  r.batch(['noted', 'recurring']);
  await flush();
  assert.equal(r.prompts.length, 1);
  assert.equal(r.internal.queue.length, 2);
  assert.equal(r.internal.handledAt.size, 0);
  assert.equal(r.bus.recent().filter((e) => e.type === 'skill_forge_deferred').length, 2);
  assert.equal(r.bus.recent().filter((e) => e.type === 'skill_forge_failed').length, 1);
});

test('生成材料保留完整旧契约、候选状态和未截断的结构化事件', async (t) => {
  const r = setup(t, () => ({ none: true, why: '保留待试用候选' }));
  const code = `const s = await api.state();\n${'// original contract details\n'.repeat(120)}return s.hp;`;
  assert.ok(r.engine.write({ name: 'full-contract', description: '带参数的完整旧契约', body: '检查当前状态后结束，不移动。',
    when: { hp_below: 10 }, args: { target: '调用方的目标' }, cooldown_s: 17, priority: 62, overrides: ['torch'], code, verify: observation('unused').verify }).ok);
  assert.ok(r.engine.write({ ...observation('full-contract'), description: '同名待验证版本' }, { by: 'mind' }).ok);
  r.smith.start(60_000);
  const msg = '真实执行记录'.repeat(60);
  const data = { skill: 'craft', status: 'succeeded', args: { item: 'oak_planks' }, result: { inventoryDelta: { oak_planks: 4 } } };
  r.bus.publish('task_end', 'P3', msg, data);
  r.planner.autonomous = true;
  r.smith.report('noted', Date.now(), '检查旧契约', 60_000);
  await flush();
  const facts = JSON.parse(r.prompts[0][1].content) as { existing_skill_contracts: { name: string; status: string; code?: string; args?: unknown; cooldown_s: number; overrides: string[]; verify?: string }[]; observed_events: { msg: string; data: unknown }[] };
  const stable = facts.existing_skill_contracts.find((x) => x.status === 'stable')!;
  assert.equal(stable.code, code);
  assert.deepEqual(stable.args, { target: '调用方的目标' });
  assert.equal(stable.cooldown_s, 17);
  assert.deepEqual(stable.overrides, ['torch']);
  assert.ok(stable.verify);
  assert.ok(facts.existing_skill_contracts.some((x) => x.status === 'candidate_pending_trial' && x.verify));
  assert.equal(facts.observed_events[0].msg, msg);
  assert.deepEqual(facts.observed_events[0].data, data);
  assert.match(r.prompts[0][0].content, /候选不是已覆盖的能力/);
});

test('重复完整候选不报新生成，也不占用批量写入预算', async (t) => {
  const r = setup(t, () => ({ results: [
    { event: 1, skill: observation('existing-observation') },
    { event: 2, skill: observation('new-observation-a') },
    { event: 3, skill: observation('new-observation-b') },
  ] }));
  assert.ok(r.engine.write(observation('existing-observation'), { by: 'mind' }).ok);
  const version = r.engine.get('existing-observation', true)?.version;
  r.batch(['noted', 'recurring', 'repeated']);
  await flush();
  assert.equal(r.engine.get('existing-observation', true)?.version, version);
  assert.equal(r.bus.recent().filter((e) => e.type === 'skill_forge_unchanged').length, 1);
  assert.equal(r.bus.recent().filter((e) => e.type === 'skill_forged').length, 2);
  assert.equal(r.internal.queue.length, 0);
  assert.equal(r.internal.handledAt.size, 3);
});
