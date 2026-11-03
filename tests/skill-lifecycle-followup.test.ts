import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { ObservedGameClock } from '../src/codeskills/game-clock.ts';
import { SkillCurator } from '../src/codeskills/curator.ts';
import { EventBus } from '../src/events.ts';
import { SkillBook } from '../src/knowledge/skillbook.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Attention } from '../src/mind/attention.ts';
import { BehaviorEngine } from '../src/mind/behaviors.ts';
import { Vision } from '../src/perception/vision.ts';
import { setBehaviorRegistry } from '../src/skills/use-skill.ts';
import type { SkillResult } from '../src/skills/types.ts';
import { FakeAdapter } from './fake-adapter.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'curio-lifecycle-followup-'));
const senses0 = { perceivedEntities: () => [] };
const codeSkill = (name: string) => ({ name, description: `${name} 的做法`, code: 'return {worked:true};', verify: 'const s = await api.state(); return true;' });

/** 带真实 Arbiter 的环境：engine 监听 arbiter 的 done 事件，测试直接 emit done 回执。 */
function runtime(t: TestContext) {
  const directory = tmp();
  const adapter = new FakeAdapter(), bus = new EventBus(), memory = new WorldMemory(null);
  const senses = new Vision(adapter), arbiter = new Arbiter(adapter, memory, bus, senses);
  const book = new SkillBook(null, directory);
  const engine = new BehaviorEngine(book, adapter, arbiter, bus, senses, path.join(directory, 'stats.json'));
  setBehaviorRegistry(engine);
  t.after(() => { setBehaviorRegistry(null); engine.dispose(); arbiter.cancel('test end'); memory.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, adapter, bus, book, engine, arbiter };
}

function done(name: string, args: Record<string, unknown>, result: Partial<SkillResult> & { status: SkillResult['status'] }, source: TaskOutcome['task']['source'] = 'llm'): TaskOutcome {
  return {
    task: { id: `t_${Math.random().toString(36).slice(2)}`, planVersion: 1, skill: 'use_skill', args: { name, ...args }, source, startedAt: Date.now() - 10, deadline: Date.now() + 1000, progress: 1, note: '', movement: false },
    result: result as SkillResult,
    durationMs: 1,
  };
}

function curatorSetup(t: TestContext) {
  const directory = tmp(), adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(null, directory);
  const engine = new BehaviorEngine(book, adapter, null, bus, senses0, path.join(directory, 'stats.json'));
  const planner = { autonomous: false, noteInvalid() {}, async complete() { return { text: '{"ok":true}', latencyMs: 0 }; } };
  const curator = new SkillCurator(planner, engine, book, bus, {}, new ObservedGameClock(path.join(directory, 'clock.json')), path.join(directory, 'lifetimes.json'));
  curator.dim = () => adapter.dim;
  t.after(() => { curator.stop(); engine.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  let worldAgeTicks = 0;
  const observe = (ticks = 0) => { worldAgeTicks += ticks; curator.observe({ ...adapter.state(), worldAgeTicks }, false); };
  return { engine, curator, observe };
}

test('合并只生成候选时，同轮不能以“已被替代”收起来源', async (t) => {
  const directory = tmp(), adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(null, directory);
  const engine = new BehaviorEngine(book, adapter, null, bus, senses0, path.join(directory, 'stats.json'));
  t.after(() => { engine.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  for (const name of ['skill-a', 'skill-b']) assert.ok(engine.write(codeSkill(name)).ok);
  for (const name of ['skill-a', 'skill-b']) for (let i = 0; i < 3; i++) engine.recordInvocation(name, { status: 'succeeded', summary: '实际做成', data: { version: 1, verified: true } });
  const planner = { autonomous: true, noteInvalid() {}, complete: async () => ({ text: JSON.stringify({
    merge: [{ from: ['skill-a', 'skill-b'], skill: { name: 'skill-a', description: '合并 AB', code: 'return {worked:true};', verify: 'const s = await api.state(); return true;' } }],
    retire: [{ name: 'skill-b', target: 'skill', version: 1, why: '已并入 skill-a' }],
  }), latencyMs: 0 }) };
  const curator = new SkillCurator(planner, engine, book, bus);
  const result = await curator.check(Date.now(), { force: true });
  assert.equal(engine.inactive('skill-b'), false, '合并只生成候选，替代尚未验收，不能收起来源');
  assert.match(result!, /未完成/);
});

test('首轮合并失败、第二轮删掉 merge 只留 retire，仍不能收起来源', async (t) => {
  const directory = tmp(), adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(null, directory);
  const engine = new BehaviorEngine(book, adapter, null, bus, senses0, path.join(directory, 'stats.json'));
  t.after(() => { engine.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  for (const name of ['skill-a', 'skill-b']) assert.ok(engine.write(codeSkill(name)).ok);
  for (let i = 0; i < 3; i++) engine.recordInvocation('skill-b', { status: 'succeeded', summary: '实际做成', data: { version: 1, verified: true } });
  const planner = { autonomous: true, noteInvalid() {}, complete: async (_msgs: unknown[], opts: { attempt?: number }) => {
    if (opts.attempt === 0) return { text: JSON.stringify({
      // 代码缺 verify：engine.write 拒绝，首轮合并失败
      merge: [{ from: ['skill-a', 'skill-b'], skill: { name: 'skill-a', description: '合并 AB', code: 'return {merged:true};' } }],
      retire: [{ name: 'skill-b', target: 'skill', version: 1, why: '已并入 skill-a' }],
    }), latencyMs: 0 };
    // 第二轮删掉 merge、只留“已并入”的 retire
    return { text: JSON.stringify({ retire: [{ name: 'skill-b', target: 'skill', version: 1, why: '已并入 skill-a' }] }), latencyMs: 0 };
  } };
  const curator = new SkillCurator(planner, engine, book, bus);
  const result = await curator.check(Date.now(), { force: true });
  assert.equal(engine.inactive('skill-b'), false, '首轮合并失败后，第二轮删掉 merge 只留 retire 也不能收起来源');
  assert.match(result!, /未完成/);
});

test('应急去重：advisory 稳定版不算代表，同做法候选留作种子不被收', (t) => {
  const w = curatorSetup(t);
  const shield = { description: '举盾后撤', when: { hostile: { within: 8 } }, code: 'await api.shield(true); return {worked:true};', verify: 'const s = await api.state(); return true;' };
  assert.ok(w.engine.write({ ...shield, name: 'shield-stable' }).ok);
  w.engine.recordInvocation('shield-stable', { status: 'succeeded', summary: '举盾后撤', data: { version: 1, verified: true } });
  (w.engine as any).touch('shield-stable', (st: any) => { st.advisory = { since: Date.now(), why: '和另一份来回拉锯' }; });
  assert.ok(w.engine.write({ ...shield, name: 'shield-cand' }, { by: 'mind' }).ok);
  w.observe(); w.observe(24_000);
  assert.deepEqual(w.curator.retireRedundantEmergency(), [], 'advisory 稳定版不当代表，候选留作种子');
  assert.equal(w.engine.candidateRetirement('shield-cand'), undefined, '同做法候选保留');
  assert.equal(w.engine.inactive('shield-stable'), false, 'advisory 稳定版不被这步收起');
});

test('应急去重：举盾与攻击做法不同，不互相替代', (t) => {
  const w = curatorSetup(t);
  assert.ok(w.engine.write({ name: 'attack-stable', description: '攻击应对', when: { hostile: { within: 8 } }, code: 'await api.attack(1); return {worked:true};', verify: 'const s = await api.state(); return true;' }).ok);
  w.engine.recordInvocation('attack-stable', { status: 'succeeded', summary: '攻击得手', data: { version: 1, verified: true } });
  assert.ok(w.engine.write({ name: 'shield-cand', description: '举盾后撤', when: { hostile: { within: 8 } }, code: 'await api.shield(true); return {worked:true};', verify: 'const s = await api.state(); return true;' }, { by: 'mind' }).ok);
  w.observe(); w.observe(24_000);
  assert.deepEqual(w.curator.retireRedundantEmergency(), [], '举盾与攻击是不同做法，不互相收');
  assert.equal(w.engine.candidateRetirement('shield-cand'), undefined, '举盾候选保留');
});

test('事后观测带版本和任务，死亡或判断不了时不说“解除了”', () => {
  const directory = tmp(), adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(null, directory);
  const engine = new BehaviorEngine(book, adapter, null, bus, senses0, path.join(directory, 'stats.json'));
  const after: { data: any; msg: string }[] = [];
  bus.on('event', (ev: any) => { if (ev.type === 'skill_aftermath') after.push(ev); });
  assert.ok(engine.write({ name: 'guard-skill', description: '举盾应对', when: { hostile: { within: 8 } }, code: 'return {worked:true};', verify: 'const s = await api.state(); return true;' }).ok);
  const b = engine.get('guard-skill')!;
  (engine as any).aftermath.set('guard-skill', { taskId: 't9', behavior: b, hp: 20, at: Date.now() - 13_000, context: '', summary: '举盾' });
  (engine as any).judge('guard-skill', true);
  const ev = after[0];
  assert.equal(ev.data.died, true);
  assert.equal(ev.data.still, null, '死了无法判断处境，不能误说“解除了”');
  assert.equal(ev.data.version, 1);
  assert.equal(ev.data.taskId, 't9');
  assert.ok(!/解除了/.test(ev.msg), '消息里不说“解除了”');
  engine.dispose();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('事后观测进入注意力：只报事实，死亡显著度更高', () => {
  const attention = new Attention();
  const n = attention.fromEvent({ ts: Date.now(), type: 'skill_aftermath', severity: 'P3', msg: '技能「a」事后观测：做完后又掉了 5 点血', data: { name: 'a', died: false, lost: 5, still: null } });
  assert.ok(n, '事后观测作为注意条目');
  assert.match(n!.what, /事后观测/);
  const dead = attention.fromEvent({ ts: Date.now(), type: 'skill_aftermath', severity: 'P3', msg: '技能「b」事后观测：做完后不久就死了', data: { name: 'b', died: true, lost: 0, still: null } });
  assert.ok(dead, '死亡的事后观测也进入注意力');
  assert.ok(dead!.salience > n!.salience, '死亡的事后观测显著度更高');
});

test('候选被 STUCK 终止（回执缺版本），失败记到候选而不是稳定版', (t) => {
  const w = runtime(t);
  const def = { description: '应急做法', code: 'await api.move({forward:true},50); return {moved:true};', verify: 'const s = await api.state(); return true;' };
  assert.ok(w.engine.write({ ...def, name: 'stuck-skill' }).ok);
  assert.ok(w.engine.write({ ...def, name: 'stuck-skill' }, { by: 'mind' }).ok);
  w.arbiter.emit('done', done('stuck-skill', { trial: true }, { status: 'failed', failureCode: 'STUCK', summary: 'use_skill 卡死' }, 'reflex'));
  assert.equal(w.engine.statsOf('stuck-skill')?.byVersion?.['2']?.fail ?? 0, 1, '失败记到候选 v2');
  assert.equal(w.engine.statsOf('stuck-skill')?.byVersion?.['1']?.fail ?? 0, 0, '稳定 v1 不记失败');
  assert.equal(w.engine.statsOf('stuck-skill')?.byVersion?.['1']?.ok ?? 0, 0);
});

test('稳定技能：verify 通过才算成功，没写 verify 的“跑完了”只记使用不记成败', (t) => {
  const w = runtime(t);
  assert.ok(w.engine.write({ name: 'steps-move', description: '向前移动', steps: [{ skill: 'look_around' }] }).ok);
  assert.ok(w.engine.write({ name: 'code-heal', description: '回血做法', code: 'return {worked:true};', verify: 'const s = await api.state(); return true;' }).ok);
  // 没写 verify 的 steps 技能“跑完了”（真实回执 verified:false）：目标达成未知，只记使用、不记成败
  w.arbiter.emit('done', done('steps-move', {}, { status: 'succeeded', summary: '跑完了', data: { verified: false } }));
  assert.equal(w.engine.statsOf('steps-move')?.uses, 1, '记一次使用');
  assert.equal(w.engine.statsOf('steps-move')?.ok, 0, '不把“跑完了”冒充成成功');
  assert.equal(w.engine.statsOf('steps-move')?.fail, 0, '也不当成失败');
  // 代码技能 verify 通过：记成功
  w.arbiter.emit('done', done('code-heal', {}, { status: 'succeeded', summary: '做完了', data: { verified: true, version: 1 } }));
  assert.deepEqual(w.engine.currentStats('code-heal'), { ok: 1, fail: 0 });
  // 代码技能执行失败：记失败
  w.arbiter.emit('done', done('code-heal', {}, { status: 'failed', failureCode: 'ERROR', summary: '没成', data: { version: 1 } }));
  assert.deepEqual(w.engine.currentStats('code-heal'), { ok: 1, fail: 1 });
});

test('handlesNow 区分候选与可复用的稳定版', (t) => {
  const directory = tmp(), adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(null, directory);
  const engine = new BehaviorEngine(book, adapter, null, bus, senses0, path.join(directory, 'stats.json'));
  t.after(() => { engine.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  // 候选（只有候选、需 trial:true）：不算覆盖
  assert.ok(engine.write({ name: 'only-candidate', description: '候选做法', when: { hostile: { within: 8 } }, code: 'return {worked:true};', verify: 'const s = await api.state(); return true;' }, { by: 'mind' }).ok);
  assert.match(engine.handlesNow('only-candidate')!, /候选/, '只有候选时不算覆盖');
  // 稳定的显式调用技能：可显式复用，算覆盖
  assert.ok(engine.write({ name: 'manual-skill', description: '手动调用', steps: [{ skill: 'look_around' }] }).ok);
  assert.equal(engine.handlesNow('manual-skill'), null, '显式调用技能可复用，算覆盖');
  // 稳定的自动技能：可自动处理，算覆盖（证据是否可靠由 ownerOf/统计另行把关）
  assert.ok(engine.write({ name: 'fresh-auto', description: '自动技能', when: { hostile: { within: 8 } }, steps: [{ skill: 'look_around' }] }).ok);
  assert.equal(engine.handlesNow('fresh-auto'), null, '自动技能可处理，算覆盖');
  // 收起/停用后不再算覆盖
  assert.ok(engine.retire('manual-skill', '测试收起'));
  assert.match(engine.handlesNow('manual-skill')!, /收起或停用/, '收起后不算覆盖');
});
