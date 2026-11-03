import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { SkillCurator } from '../src/codeskills/curator.ts';
import { SkillSmith } from '../src/codeskills/smith.ts';
import { EventBus, type AgentEvent } from '../src/events.ts';
import { SkillBook } from '../src/knowledge/skillbook.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { BehaviorEngine } from '../src/mind/behaviors.ts';
import { Vision } from '../src/perception/vision.ts';
import { setBehaviorRegistry } from '../src/skills/use-skill.ts';
import { FakeAdapter } from './fake-adapter.ts';

const flush = async () => { for (let i = 0; i < 10; i++) await setImmediate(); };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'curio-lifecycle-fixes-'));
const senses0 = { perceivedEntities: () => [] };
const definition = { name: 'observed-move', description: '按委托向前移动一小步', code: 'await api.move({forward:true},50); return {moved:true};',
  verify: 'const s = await api.state(); return Math.hypot(s.pos.x-args.before.pos.x,s.pos.z-args.before.pos.z)>0.01 ? true : "没有移动";' };

/** 带真实 Arbiter 的环境：能走完 use_skill → done 的完整链路，验证候选自动接手只记一次试验。 */
function runtime(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-lifecycle-runtime-'));
  const adapter = new FakeAdapter(), bus = new EventBus(), memory = new WorldMemory(null);
  const senses = new Vision(adapter), arbiter = new Arbiter(adapter, memory, bus, senses);
  const book = new SkillBook(null, directory);
  const engine = new BehaviorEngine(book, adapter, arbiter, bus, senses, path.join(directory, 'stats.json'));
  setBehaviorRegistry(engine);
  t.after(() => { setBehaviorRegistry(null); engine.dispose(); arbiter.cancel('test end'); memory.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, adapter, bus, book, engine, arbiter };
}

test('合并失败不能以“已被替代”退役来源；独立放弃仍执行；部分失败一并报告', async (t) => {
  const directory = tmp(), adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(null, directory);
  const engine = new BehaviorEngine(book, adapter, null, bus, senses0, path.join(directory, 'stats.json'));
  t.after(() => { engine.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  const skill = (name: string) => ({ name, description: `${name} 的做法`, code: 'return {worked:true};', verify: 'const s = await api.state(); return true;' });
  for (const name of ['skill-a', 'skill-b', 'skill-c']) assert.ok(engine.write(skill(name)).ok);
  for (const name of ['skill-b', 'skill-c']) for (let i = 0; i < 3; i++) engine.recordInvocation(name, { status: 'succeeded', summary: '实际做成', data: { version: 1, verified: true } });
  const planner = { autonomous: true, noteInvalid() {}, complete: async () => ({ text: JSON.stringify({
    // 合并代码缺 verify：engine.write 会拒绝，合并失败
    merge: [{ from: ['skill-a', 'skill-b'], skill: { name: 'skill-a', description: '合并 A B', code: 'return {merged:true};' } }],
    retire: [
      { name: 'skill-b', target: 'skill', version: 1, why: '已并入 skill-a' },
      { name: 'skill-c', target: 'skill', version: 1, why: '独立决定不再用' },
    ],
  }), latencyMs: 0 }) };
  const curator = new SkillCurator(planner, engine, book, bus);
  const result = await curator.check(Date.now(), { force: true });
  assert.equal(engine.inactive('skill-b'), false, '合并失败不能退役来源');
  assert.equal(engine.inactive('skill-c'), true, '独立放弃仍执行');
  assert.match(result!, /未完成/);
  assert.match(result!, /skill-b/);
  assert.match(result!, /收起 skill-c/);
});

test('救命候选自动接手只记一次试验：完成后按执行结果记成败，事后观测不再重复', async (t) => {
  const w = runtime(t);
  assert.ok(w.engine.write({ ...definition, when: { hp_below: 8 } }, { by: 'mind' }).ok);
  const after: AgentEvent[] = [];
  const onAftermath = (event: AgentEvent) => { if (event.type === 'skill_aftermath') after.push(event); };
  w.bus.on('event', onAftermath);
  t.after(() => w.bus.off('event', onAftermath));
  w.adapter.hp = 6;
  const now = Date.now(), done = new Promise<TaskOutcome>((resolve) => w.arbiter.once('done', resolve));
  assert.equal(w.engine.tick(null, now), true, '救命候选自动接手');
  assert.equal((await done).result.status, 'succeeded');
  assert.equal(w.engine.statsOf(definition.name)?.uses, 1);
  assert.deepEqual(w.engine.currentStats(definition.name, true), { ok: 1, fail: 0 }, '完成即按执行结果记一次成败');
  w.adapter.hp = 10;
  w.engine.tick(null, now + BehaviorEngine.AFTERMATH_MS + 1);
  assert.deepEqual(w.engine.currentStats(definition.name, true), { ok: 1, fail: 0 }, '事后观测不再重复计成败');
  assert.equal(w.engine.statsOf(definition.name)?.uses, 1);
  assert.equal(after.length, 1, '同一次试验只补一条事后观测');
  assert.equal(w.engine.get(definition.name, true)?.version, 1, '一次成功不足晋升，候选仍是候选');
});

test('同一父任务里两次同名同版本调用仍是两次试验，不按名称或版本去重', (t) => {
  const directory = tmp(), adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(null, directory);
  const engine = new BehaviorEngine(book, adapter, null, bus, senses0);
  t.after(() => { engine.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  assert.ok(engine.write(definition).ok);
  engine.recordInvocation(definition.name, { status: 'succeeded', summary: '第一次调用', data: { version: 1, verified: true } });
  engine.recordInvocation(definition.name, { status: 'succeeded', summary: '第二次调用', data: { version: 1, verified: true } });
  assert.equal(engine.statsOf(definition.name)?.uses, 2);
  assert.deepEqual(engine.currentStats(definition.name), { ok: 2, fail: 0 });
});

test('advisory 技能不自动接手但可显式调用，covered_by 不把只提醒技能当作已有覆盖', async () => {
  const adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(null, tmp());
  const engine = new BehaviorEngine(book, adapter, null, bus, senses0);
  assert.ok(engine.write({ name: 'shield-emergency', description: '举盾后撤的应急做法', when: { hp_below: 8 }, steps: [{ skill: 'look_around' }] }).ok);
  (engine as any).touch('shield-emergency', (st: any) => { st.advisory = { since: Date.now(), why: '和另一份来回拉锯' }; });
  assert.match(engine.handlesNow('shield-emergency')!, /只提醒、不自动接手/);
  assert.match(engine.autoNote('shield-emergency')!, /只提醒、不自动接手/);
  assert.match(engine.reliable('shield-emergency')!, /不够可靠/, 'reliable 仍按证据说话，不因 advisory 一刀切排除组合入口');
  assert.doesNotMatch(engine.reliable('shield-emergency')!, /拉锯|只提醒/);
  assert.equal(engine.overview().find((l) => l.startsWith('shield-emergency'))?.includes('只提醒不自动接手'), true, '概览标出拉锯状态');
  const index = book.index(undefined, (name, trial) => engine.executionError(name, trial), (name) => engine.autoNote(name));
  assert.match(index.find((l) => l.startsWith('shield-emergency'))!, /但拉锯后只提醒、不自动接手/);
  // covered_by 集成：模型说“这事归它管”，但它是 advisory，不应宣称覆盖
  const prompts: unknown[][] = [];
  const planner = { autonomous: true, noteInvalid() {}, complete: async (msgs: unknown[]) => { prompts.push(msgs); return { text: JSON.stringify({ none: true, why: '它管', covered_by: 'shield-emergency' }), latencyMs: 1 }; } };
  const smith = new SkillSmith(planner as any, engine, book, bus, () => adapter.state(), () => [], { maxPerHour: 24, repeatMs: 0, ownersFile: null });
  for (let i = 0; i < 3; i++) { smith.didAction('dig_at', { at: [1, 1, 0] }); smith.didAction('step', { at: [1, 1, 0] }); }
  await flush();
  assert.equal(prompts.length, 1);
  assert.equal(smith.ownerOf('repeated:dig_at > step'), null, 'advisory 技能不被记为覆盖者');
  smith.stop();
  engine.dispose();
});
