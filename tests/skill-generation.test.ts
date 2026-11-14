import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { CodeImprover } from '../src/codeskills/improver.ts';
import { SkillSmith } from '../src/codeskills/smith.ts';
import { PERSISTENT_VERIFY_GUIDANCE } from '../src/codeskills/verify-guidance.ts';
import { EventBus } from '../src/events.ts';
import { SkillBook } from '../src/knowledge/skillbook.ts';
import { BehaviorEngine } from '../src/mind/behaviors.ts';
import type { ChatMessage, Completion } from '../src/planner/llm.ts';
import { FakeAdapter } from './fake-adapter.ts';

const flush = async () => { for (let i = 0; i < 12; i++) await setImmediate(); };

function setup(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-generation-'));
  const adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(null, directory);
  const engine = new BehaviorEngine(book, adapter, null, bus, { perceivedEntities: () => [] });
  t.after(() => { engine.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { adapter, bus, book, engine };
}

const observation = { name: 'observe-again', description: '停下重新观察周围', steps: [{ skill: 'look_around', args: { seconds: 2 } }],
  verify: 'const s = await api.state(); return s.hp > 0 ? true : "观察期间已死亡";' };
const revision = JSON.stringify({ skill: { name: 'repair-trigger', description: '血量较低时重新观察周围', body: '血低时观察两秒；不挖不放，看到周围后停止，不把观察结束当作脱险。',
  when: { hp_below: 5 }, steps: [{ skill: 'look_around', args: { seconds: 2 } }], verify: observation.verify }, change: '根据触发记录收窄条件，并保留原地观察的委托' });

test('生成空正文或被截断的有效 JSON 只算生成失败，不安装技能或记游戏失败', async (t) => {
  const { adapter, engine, bus, book } = setup(t);
  const text = JSON.stringify({ skill: observation });
  const replies: Completion[] = [{ text: '', latencyMs: 1 }, { text, finishReason: 'length', latencyMs: 1 }, { text, finishReason: 'stop', latencyMs: 1 }];
  const invalid: string[] = [];
  let calls = 0;
  const planner = { autonomous: true, noteInvalid(_label: string, error: string) { invalid.push(error); }, async complete() {
    assert.equal(book.get(observation.name), undefined, '不完整的回复不能先写入技能书');
    return replies[calls++];
  } };
  const smith = new SkillSmith(planner, engine, book, bus, () => adapter.state());
  t.after(() => smith.stop());
  smith.report('noted', Date.now(), '需要重新观察的做法', 0);
  await flush();
  assert.equal(calls, 3);
  assert.match(invalid[0], /没有返回正文/);
  assert.match(invalid[1], /截断/);
  assert.equal(bus.recent().filter((e) => e.type === 'skill_forged').length, 1);
  assert.equal(engine.get(observation.name, true)?.name, observation.name);
  assert.equal(engine.statsOf(observation.name)?.fail ?? 0, 0);
});

test('后台改进可修订触发和步骤，保留当前稳定技能直到候选获得游戏证据', async (t) => {
  const { engine, bus } = setup(t);
  assert.ok(engine.write({ name: 'repair-trigger', description: '血量较低时观察脚下', when: { hp_below: 8 },
    code: 'const s = await api.state(); return s.feet;', verify: 'const s = await api.state(); return s.hp > 0 ? true : "已死亡";' }).ok);
  const planner = { autonomous: true, noteInvalid() {}, async complete() { return { text: revision, latencyMs: 1 }; } };
  const improver = new CodeImprover(planner, engine, bus);
  assert.equal(improver.consider('repair-trigger', 'requested', '触发范围太宽'), null);
  await flush();
  assert.equal(engine.get('repair-trigger')?.when?.hp_below, 8);
  const candidate = engine.get('repair-trigger', true);
  assert.equal(candidate?.when?.hp_below, 5);
  assert.equal(candidate?.code, undefined);
  assert.equal(candidate?.steps[0].skill, 'look_around');
  assert.ok(bus.recent().some((e) => e.type === 'skill_improved' && e.data?.candidate === true));
});

test('后台改进完成前被收起，旧回复不能复活技能或安装候选', async (t) => {
  const { engine, bus } = setup(t);
  assert.ok(engine.write({ name: 'repair-trigger', description: '检查脚下的旧做法', code: 'const s = await api.state(); return s.feet;' }).ok);
  let respond: ((value: Completion) => void) | undefined;
  const planner = { autonomous: true, noteInvalid() {}, complete: () => new Promise<Completion>((resolve) => { respond = resolve; }) };
  const improver = new CodeImprover(planner, engine, bus);
  assert.equal(improver.consider('repair-trigger', 'requested'), null);
  assert.ok(engine.retire('repair-trigger', '已经合并进别的做法'));
  const retiredToken = engine.editToken('repair-trigger');
  respond!({ text: revision, latencyMs: 1 });
  await flush();
  assert.equal(engine.editToken('repair-trigger'), retiredToken);
  assert.equal(engine.statsOf('repair-trigger')?.disabled, true);
  assert.ok(bus.recent().some((e) => e.type === 'skill_improve_skipped'));
  assert.ok(!bus.recent().some((e) => e.type === 'skill_improved'));
});

test('生成请求期间同名技能已出现，旧回复不能覆盖新内容', async (t) => {
  const { adapter, engine, bus, book } = setup(t);
  let respond: ((value: Completion) => void) | undefined;
  const planner = { autonomous: true, noteInvalid() {}, complete: () => new Promise<Completion>((resolve) => { respond = resolve; }) };
  const smith = new SkillSmith(planner, engine, book, bus, () => adapter.state());
  t.after(() => smith.stop());
  smith.report('noted', Date.now(), '需要重新观察的做法', 0);
  assert.ok(engine.write({ ...observation, description: '心智已经写下的新观测做法' }).ok);
  const writtenToken = engine.editToken(observation.name);
  respond!({ text: JSON.stringify({ skill: observation }), latencyMs: 1 });
  await flush();
  assert.equal(engine.editToken(observation.name), writtenToken);
  assert.equal(engine.get(observation.name)?.description, '心智已经写下的新观测做法');
  assert.ok(!bus.recent().some((e) => e.type === 'skill_forged'));
});


test('后台改进返回相同完整候选时保留证据，不误报生成新修订', async (t) => {
  const { engine, bus } = setup(t);
  const candidate = { name: 'unchanged-repair', description: '观察脚下状态', code: 'const s = await api.state(); return s.feet;', verify: observation.verify };
  assert.ok(engine.write(candidate, { by: 'mind' }).ok);
  engine.recordInvocation(candidate.name, { status: 'failed', summary: 'TypeError: 当前代码错误', data: { version: 1 } });
  const before = structuredClone(engine.statsOf(candidate.name));
  const planner = { autonomous: true, noteInvalid() {}, async complete() { return { text: JSON.stringify({ skill: candidate }), latencyMs: 1 }; } };
  const improver = new CodeImprover(planner, engine, bus);
  assert.equal(improver.consider(candidate.name, 'requested'), null);
  await flush();
  assert.equal(engine.get(candidate.name, true)?.version, 1);
  assert.deepEqual(engine.statsOf(candidate.name), before);
  assert.ok(bus.recent().some((event) => event.type === 'skill_improve_kept'));
  assert.ok(!bus.recent().some((event) => event.type === 'skill_improved'));
});

test('写技能与改进提示共用持续处境自动技能的判定口径', async (t) => {
  const { adapter, engine, bus, book } = setup(t);
  const systems: string[] = [];
  const planner = { autonomous: true, noteInvalid() {}, async complete(messages: ChatMessage[]) {
    systems.push(messages[0].content);
    return { text: JSON.stringify({ none: true, why: '测试不写技能' }), latencyMs: 1 };
  } };
  const smith = new SkillSmith(planner, engine, book, bus, () => adapter.state());
  t.after(() => smith.stop());
  smith.report('noted', Date.now(), '低血时有远程怪就举盾', 0);
  await flush();
  assert.ok(systems.some((s) => s.includes(PERSISTENT_VERIFY_GUIDANCE)));

  const skill = { name: 'repair-trigger', description: '低血时观察脚下', when: { hp_below: 8 },
    code: 'const s = await api.state(); return s.feet;', verify: 'const s = await api.state(); return s.hp > 0 ? true : "已死亡";' };
  assert.ok(engine.write(skill).ok);
  const improveSystems: string[] = [];
  const improver = new CodeImprover({ autonomous: true, noteInvalid() {}, async complete(messages: ChatMessage[]) {
    improveSystems.push(messages[0].content);
    return { text: JSON.stringify({ keep: true, why: '没有改动' }), latencyMs: 1 };
  } }, engine, bus);
  assert.equal(improver.consider(skill.name, 'requested'), null);
  await flush();
  assert.ok(improveSystems.some((s) => s.includes(PERSISTENT_VERIFY_GUIDANCE)));
  assert.match(PERSISTENT_VERIFY_GUIDANCE, /可观察改善/);
  assert.match(PERSISTENT_VERIFY_GUIDANCE, /不能只核对时间用完/);
  assert.match(PERSISTENT_VERIFY_GUIDANCE, /返回没成并交回心智/);
});
