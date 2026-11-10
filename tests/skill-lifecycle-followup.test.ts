import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { ObservedGameClock } from '../src/codeskills/game-clock.ts';
import { SkillCurator } from '../src/codeskills/curator.ts';
import { SkillSmith } from '../src/codeskills/smith.ts';
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

function done(name: string, args: Record<string, unknown>, result: Partial<SkillResult> & { status: SkillResult['status'] }, source: TaskOutcome['task']['source'] = 'llm', startedAt = Date.now()): TaskOutcome {
  return {
    task: { id: `t_${Math.random().toString(36).slice(2)}`, planVersion: 1, skill: 'use_skill', args: { name, ...args }, source, startedAt, deadline: Date.now() + 1000, progress: 1, note: '', movement: false },
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

test('应急候选不再按动作签名自动去重：同方法名不同参数（useSkill 举盾 vs 攻击）不互相替代', (t) => {
  const w = curatorSetup(t);
  assert.ok(w.engine.write({ name: 'shield-response', description: '举盾应对', when: { hostile: { within: 8 } }, code: 'await api.useSkill("shield-block"); return {worked:true};', verify: 'const s = await api.state(); return true;' }).ok);
  w.engine.recordInvocation('shield-response', { status: 'succeeded', summary: '举盾后撤', data: { version: 1, verified: true } });
  assert.ok(w.engine.write({ name: 'attack-response', description: '攻击应对', when: { hostile: { within: 8 } }, code: 'await api.useSkill("attack-block"); return {worked:true};', verify: 'const s = await api.state(); return true;' }, { by: 'mind' }).ok);
  w.observe(); w.observe(24_000);
  // 不再按「动作签名」（两者都会 api.useSkill）自动去重：盾技能成功不自动收起攻击候选，替代关系由模型按代码/证据判断。
  assert.equal(w.engine.candidateRetirement('attack-response'), undefined, '攻击候选不被自动收起');
  assert.equal(w.engine.inactive('shield-response'), false, '已验证的盾技能保持启用');
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

test('候选被 STUCK 终止（回执缺版本、候选未变），失败记到候选而不是稳定版', (t) => {
  const w = runtime(t);
  const def = { description: '应急做法', code: 'await api.move({forward:true},50); return {moved:true};', verify: 'const s = await api.state(); return true;' };
  assert.ok(w.engine.write({ ...def, name: 'stuck-skill' }).ok);
  assert.ok(w.engine.write({ ...def, name: 'stuck-skill' }, { by: 'mind' }).ok);
  w.arbiter.emit('done', done('stuck-skill', { trial: true }, { status: 'failed', failureCode: 'STUCK', summary: 'use_skill 卡死' }, 'reflex'));
  assert.equal(w.engine.statsOf('stuck-skill')?.byVersion?.['2']?.fail ?? 0, 1, '失败记到候选 v2');
  assert.equal(w.engine.statsOf('stuck-skill')?.byVersion?.['1']?.fail ?? 0, 0, '稳定 v1 不记失败');
  assert.equal(w.engine.statsOf('stuck-skill')?.byVersion?.['1']?.ok ?? 0, 0);
});

test('候选执行期间修订成 v3、回执缺版本：只记使用，不按完成时的 trial 猜当前候选', (t) => {
  const w = runtime(t);
  const def = { description: '应急做法', code: 'await api.move({forward:true},50); return {moved:true};', verify: 'const s = await api.state(); return true;' };
  assert.ok(w.engine.write({ ...def, name: 'stuck-skill' }).ok);
  assert.ok(w.engine.write({ ...def, name: 'stuck-skill' }, { by: 'mind' }).ok);
  const startedAt = Date.now() - 1000; // v2 正在执行
  assert.ok(w.engine.write({ ...def, name: 'stuck-skill', code: def.code + '\n// 修订执行契约' }, { by: 'mind' }).ok); // 执行期间生成 v3
  assert.equal(w.engine.get('stuck-skill', true)?.version, 3);
  w.arbiter.emit('done', done('stuck-skill', { trial: true }, { status: 'failed', failureCode: 'STUCK', summary: 'use_skill 卡死' }, 'reflex', startedAt));
  const st = w.engine.statsOf('stuck-skill')!;
  assert.equal(st.uses, 1, '只记一次使用');
  assert.equal(st.byVersion?.['1']?.fail ?? 0, 0, '不落到稳定版');
  assert.equal(st.byVersion?.['2']?.fail ?? 0, 0, '不猜 v2');
  assert.equal(st.byVersion?.['3']?.fail ?? 0, 0, '不猜 v3');
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

test('跨轮次：替代候选未验收，下一次整理不能以“subsumed_by”收起来源', async (t) => {
  const directory = tmp(), adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(null, directory);
  const engine = new BehaviorEngine(book, adapter, null, bus, senses0, path.join(directory, 'stats.json'));
  t.after(() => { engine.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  for (const name of ['skill-a', 'skill-b']) assert.ok(engine.write(codeSkill(name)).ok);
  for (let i = 0; i < 3; i++) engine.recordInvocation('skill-b', { status: 'succeeded', summary: '实际做成', data: { version: 1, verified: true } });
  let round = 0;
  const planner = { autonomous: true, noteInvalid() {}, complete: async () => {
    const text = round++ === 0
      ? JSON.stringify({ merge: [{ from: ['skill-a', 'skill-b'], skill: { name: 'skill-a', description: '合并 AB', code: 'return {worked:true};', verify: 'const s = await api.state(); return true;' } }] })
      : JSON.stringify({ retire: [{ name: 'skill-b', target: 'skill', version: 1, why: '已并入', subsumed_by: 'skill-a' }] });
    return { text, latencyMs: 0 };
  } };
  const curator = new SkillCurator(planner, engine, book, bus);
  await curator.check(Date.now(), { force: true }); // 第一轮：生成替代候选
  const result = await curator.check(Date.now(), { force: true }); // 第二轮：以 subsumed_by 收起
  assert.equal(engine.inactive('skill-b'), false, '替代候选未验收，不能跨轮次收起来源');
  assert.match(result!, /未完成/);
});

test('首轮出错、第二轮回 {ok:true}：首轮失败照实报出，不吞掉', async (t) => {
  const directory = tmp(), adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(null, directory);
  const engine = new BehaviorEngine(book, adapter, null, bus, senses0, path.join(directory, 'stats.json'));
  t.after(() => { engine.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  for (const name of ['skill-a', 'skill-b']) assert.ok(engine.write(codeSkill(name)).ok);
  const planner = { autonomous: true, noteInvalid() {}, complete: async (_msgs: unknown[], opts: { attempt?: number }) => {
    if (opts.attempt === 0) return { text: JSON.stringify({ merge: [{ from: ['skill-a', 'skill-b'], skill: { name: 'skill-a', description: '合并 AB', code: 'return {merged:true};' } }] }), latencyMs: 0 };
    return { text: '{"ok":true}', latencyMs: 0 };
  } };
  const curator = new SkillCurator(planner, engine, book, bus);
  const result = await curator.check(Date.now(), { force: true });
  assert.match(result!, /未完成/);
  assert.match(result!, /合并/);
});

test('文字合并失败仍不能同轮收起来源记录', async (t) => {
  const directory = tmp(), adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(null, directory);
  const engine = new BehaviorEngine(book, adapter, null, bus, senses0, path.join(directory, 'stats.json'));
  t.after(() => { engine.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  assert.ok(book.write('note-a', '做法 A 的说明', '做法 A 的内容，至少要二十个字才能写下来').ok);
  assert.ok(book.write('note-b', '做法 B 的说明', '做法 B 的内容，至少要二十个字才能写下来').ok);
  const planner = { autonomous: true, noteInvalid() {}, complete: async () => ({ text: JSON.stringify({
    merge: [{ from: ['note-a', 'note-b'], skill: { name: 'note-a', description: '', body: '' } }],
    retire: [{ name: 'note-b', target: 'note', why: '已并入 note-a' }],
  }), latencyMs: 0 }) };
  const curator = new SkillCurator(planner, engine, book, bus);
  const result = await curator.check(Date.now(), { force: true });
  assert.equal(engine.inactive('note-b'), false, '文字合并失败不能收起来源记录');
  assert.match(result!, /未完成/);
});

test('ownerOf 读取旧覆盖记录时也复用 handlesNow：候选不被当作覆盖者', (t) => {
  const directory = tmp(), adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(null, directory);
  const engine = new BehaviorEngine(book, adapter, null, bus, senses0, path.join(directory, 'stats.json'));
  t.after(() => { engine.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  const planner = { autonomous: false, noteInvalid() {}, async complete() { return { text: '{}', latencyMs: 0 }; } };
  const smith = new SkillSmith(planner, engine, book, bus, () => adapter.state(), () => [], { maxPerHour: 24, repeatMs: 0, ownersFile: null });
  assert.ok(engine.write({ name: 'only-cand', description: '候选做法', when: { hostile: { within: 8 } }, code: 'return {worked:true};', verify: 'const s = await api.state(); return true;' }, { by: 'mind' }).ok);
  (smith as any).owners.set('repeated:dig_at > step', { skill: 'only-cand', version: '1', at: Date.now(), kind: 'repeated', headline: 'x' });
  assert.equal(smith.ownerOf('repeated:dig_at > step'), null, '候选不算覆盖，读取旧记录也拒绝');
});

test('事后观测按真实执行阶段描述：版本、触发以来的净掉血、执行中/做完后的死亡', () => {
  const directory = tmp(), adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(null, directory);
  const engine = new BehaviorEngine(book, adapter, null, bus, senses0, path.join(directory, 'stats.json'));
  const after: { data: any; msg: string }[] = [];
  bus.on('event', (ev: any) => { if (ev.type === 'skill_aftermath') after.push(ev); });
  assert.ok(engine.write({ name: 'guard-skill', description: '举盾应对', when: { hostile: { within: 8 } }, code: 'return {worked:true};', verify: 'const s = await api.state(); return true;' }).ok);
  const b = engine.get('guard-skill')!;
  adapter.hp = 15;
  (engine as any).aftermath.set('guard-skill', { taskId: 't1', behavior: b, hp: 20, at: Date.now() - 13_000, context: '血少又有怪' });
  (engine as any).judge('guard-skill', true);
  const ev = after[0];
  assert.ok(/v1/.test(ev.msg), '消息带版本');
  assert.ok(/执行期间就死了/.test(ev.msg), '没有 summary 说明执行期间死亡');
  assert.ok(/从触发到现在净掉了 5 点血/.test(ev.msg), '净掉血是从触发以来，不是“做完后”');
  assert.ok(/触发时：血少又有怪/.test(ev.msg), '消息带上触发处境');
  adapter.hp = 20;
  (engine as any).aftermath.set('guard-skill', { taskId: 't2', behavior: b, hp: 20, at: Date.now() - 13_000, context: '', summary: '举盾' });
  (engine as any).judge('guard-skill', true);
  assert.ok(/做完后不久就死了/.test(after[1].msg), '有 summary 说明做完后死亡');
  engine.dispose();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('整理模型能看到技能最近的事后观测事实', (t) => {
  const w = curatorSetup(t);
  assert.ok(w.engine.write({ name: 'guard-skill', description: '举盾应对', when: { hostile: { within: 8 } }, code: 'return {worked:true};', verify: 'const s = await api.state(); return true;' }).ok);
  (w.curator as any).breakObservation({ type: 'skill_aftermath', data: { name: 'guard-skill', version: 1, died: true, lost: 5, still: null, context: '血少又有怪' } });
  const user = JSON.parse(w.curator.messages(false)[1].content);
  const entry = user.skills.find((s: any) => s.name === 'guard-skill');
  assert.ok(entry.aftermath, '整理模型能看到事后观测事实');
  assert.equal(entry.aftermath[0].died, true);
  assert.equal(entry.aftermath[0].lost, 5);
});

test('事后观测事实按版本归属：v1 的观测不挂到候选 v2，跨版本明确标注', (t) => {
  const w = curatorSetup(t);
  assert.ok(w.engine.write({ name: 'guard-skill', description: '举盾应对', when: { hostile: { within: 8 } }, code: 'return {worked:true};', verify: 'const s = await api.state(); return true;' }).ok);
  assert.ok(w.engine.write({ name: 'guard-skill', description: '举盾应对改版', when: { hostile: { within: 8 } }, code: 'return {worked:true};', verify: 'const s = await api.state(); return true;' }, { by: 'mind' }).ok);
  (w.curator as any).breakObservation({ type: 'skill_aftermath', data: { name: 'guard-skill', version: 1, died: true, lost: 5, still: null, context: '血少又有怪' } });
  const user = JSON.parse(w.curator.messages(false)[1].content);
  const stable = user.skills.find((s: any) => s.name === 'guard-skill' && s.target === 'skill');
  const candidate = user.skills.find((s: any) => s.name === 'guard-skill' && s.target === 'candidate');
  assert.ok(stable.aftermath, '稳定版当前版本（v1）能看到观测');
  assert.equal(stable.aftermath[0].version, 1);
  assert.equal(stable.aftermath_other_versions, undefined, '稳定版没有别的版本的观测');
  assert.equal(candidate.aftermath, undefined, '候选 v2 不被挂上 v1 的经历');
  assert.ok(candidate.aftermath_other_versions, '候选明确标注别的版本的观测');
  assert.equal(candidate.aftermath_other_versions[0].version, 1);
});

test('替代候选只成功 1 次、未晋升：subsumed_by 仍不能收起来源', async (t) => {
  const directory = tmp(), adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(null, directory);
  const engine = new BehaviorEngine(book, adapter, null, bus, senses0, path.join(directory, 'stats.json'));
  t.after(() => { engine.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  for (const name of ['skill-a', 'skill-b']) assert.ok(engine.write(codeSkill(name)).ok);
  for (let i = 0; i < 3; i++) engine.recordInvocation('skill-b', { status: 'succeeded', summary: '实际做成', data: { version: 1, verified: true } });
  let round = 0;
  const planner = { autonomous: true, noteInvalid() {}, complete: async () => {
    const text = round++ === 0
      ? JSON.stringify({ merge: [{ from: ['skill-a', 'skill-b'], skill: { name: 'skill-a', description: '合并 AB', code: 'return {worked:true};', verify: 'const s = await api.state(); return true;' } }] })
      : JSON.stringify({ retire: [{ name: 'skill-b', target: 'skill', version: 1, why: '已并入', subsumed_by: 'skill-a' }] });
    return { text, latencyMs: 0 };
  } };
  const curator = new SkillCurator(planner, engine, book, bus);
  await curator.check(Date.now(), { force: true }); // 第一轮：生成替代候选 skill-a v2
  engine.recordInvocation('skill-a', { status: 'succeeded', summary: '做成一次', data: { version: 2, verified: true } }); // 替代候选只成 1 次，未晋升
  const result = await curator.check(Date.now(), { force: true });
  assert.equal(engine.inactive('skill-b'), false, '替代候选只成 1 次、未晋升，不能按替代收起来源');
  assert.match(result!, /未完成/);
});

test('独立放弃不看 why 关键词；subsumed_by 零成功仍被拦', async (t) => {
  const directory = tmp(), adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(null, directory);
  const engine = new BehaviorEngine(book, adapter, null, bus, senses0, path.join(directory, 'stats.json'));
  t.after(() => { engine.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  for (const name of ['skill-a', 'skill-b', 'skill-c']) assert.ok(engine.write(codeSkill(name)).ok);
  for (const name of ['skill-b', 'skill-c']) for (let i = 0; i < 3; i++) engine.recordInvocation(name, { status: 'succeeded', summary: '实际做成', data: { version: 1, verified: true } });
  let round = 0;
  const planner = { autonomous: true, noteInvalid() {}, complete: async () => {
    const text = round++ === 0
      ? JSON.stringify({ merge: [{ from: ['skill-a', 'skill-b', 'skill-c'], skill: { name: 'skill-a', description: '合并 ABC', code: 'return {worked:true};', verify: 'const s = await api.state(); return true;' } }] })
      : JSON.stringify({ retire: [
        { name: 'skill-b', target: 'skill', version: 1, why: '已完整覆盖这份做法', subsumed_by: 'skill-a' },
        { name: 'skill-c', target: 'skill', version: 1, why: '已并入 skill-a' },
      ] });
    return { text, latencyMs: 0 };
  } };
  const curator = new SkillCurator(planner, engine, book, bus);
  await curator.check(Date.now(), { force: true }); // 第一轮：合并生成替代候选（零成功）
  const result = await curator.check(Date.now(), { force: true });
  assert.equal(engine.inactive('skill-b'), false, 'subsumed_by 且替代零成功，无论 why 怎么写都不能收起');
  assert.equal(engine.inactive('skill-c'), true, '不带 subsumed_by 的 retire 是独立放弃，不看 why 关键词，照常收起');
  assert.match(result!, /未完成/);
});

test('重建整理器后替代关系仍持久化：零成功替代请求仍不能收起', async (t) => {
  const directory = tmp(), adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(null, directory);
  const engine = new BehaviorEngine(book, adapter, null, bus, senses0, path.join(directory, 'stats.json'));
  t.after(() => { engine.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  for (const name of ['skill-a', 'skill-b']) assert.ok(engine.write(codeSkill(name)).ok);
  for (let i = 0; i < 3; i++) engine.recordInvocation('skill-b', { status: 'succeeded', summary: '实际做成', data: { version: 1, verified: true } });
  let calls = 0;
  const planner = { autonomous: true, noteInvalid() {}, complete: async () => {
    const text = calls++ === 0
      ? JSON.stringify({ merge: [{ from: ['skill-a', 'skill-b'], skill: { name: 'skill-a', description: '合并 AB', code: 'return {worked:true};', verify: 'const s = await api.state(); return true;' } }] })
      : JSON.stringify({ retire: [{ name: 'skill-b', target: 'skill', version: 1, why: '已并入', subsumed_by: 'skill-a' }] });
    return { text, latencyMs: 0 };
  } };
  const clockFile = path.join(directory, 'clock.json');
  const lifetimeFile = path.join(directory, 'lifetimes.json');
  const first = new SkillCurator(planner, engine, book, bus, {}, new ObservedGameClock(clockFile), lifetimeFile);
  await first.check(Date.now(), { force: true }); // 生成替代候选并落盘
  const second = new SkillCurator(planner, engine, book, bus, {}, new ObservedGameClock(clockFile), lifetimeFile); // 重建整理器
  const result = await second.check(Date.now(), { force: true });
  assert.equal(engine.inactive('skill-b'), false, '重建整理器后，零成功替代请求仍不能收起来源');
  assert.match(result!, /未完成/);
});

test('文字合并目标名被行为技能占用时，来源仍受保护，不能同轮收起', async (t) => {
  const directory = tmp(), adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(null, directory);
  const engine = new BehaviorEngine(book, adapter, null, bus, senses0, path.join(directory, 'stats.json'));
  t.after(() => { engine.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  assert.ok(engine.write({ name: 'target-skill', description: '已有执行版本', code: 'return {worked:true};', verify: 'const s = await api.state(); return true;' }).ok);
  assert.ok(book.write('note-a', '做法 A 的说明', '做法 A 的内容，至少要二十个字才能写下来').ok);
  assert.ok(book.write('note-b', '做法 B 的说明', '做法 B 的内容，至少要二十个字才能写下来').ok);
  const planner = { autonomous: true, noteInvalid() {}, complete: async () => ({ text: JSON.stringify({
    merge: [{ from: ['note-a', 'note-b'], skill: { name: 'target-skill', description: '合并成已有技能名', body: '合并后的正文，至少要二十个字才能写下来' } }],
    retire: [{ name: 'note-b', target: 'note', why: '已并入 target-skill' }],
  }), latencyMs: 0 }) };
  const curator = new SkillCurator(planner, engine, book, bus);
  const result = await curator.check(Date.now(), { force: true });
  assert.equal(engine.inactive('note-b'), false, '文字合并目标名被占用，来源仍受保护，不能同轮收起');
  assert.match(result!, /未完成/);
});

test('已完成候选（reflex 验收）后死亡，事后观测报“做完后”，不报“执行期间”', (t) => {
  const w = runtime(t);
  assert.ok(w.engine.write({ name: 'guard-candidate', description: '举盾应对', when: { hostile: { within: 8 } }, code: 'return {worked:true};', verify: 'const s = await api.state(); return true;' }, { by: 'mind' }).ok);
  const after: { data: any; msg: string }[] = [];
  w.bus.on('event', (ev: any) => { if (ev.type === 'skill_aftermath') after.push(ev); });
  const candidate = w.engine.get('guard-candidate', true)!;
  (w.engine as any).aftermath.set('guard-candidate', { taskId: 't9', behavior: candidate, hp: 20, at: Date.now() - 1000, context: '' });
  w.adapter.hp = 10;
  const outcome: TaskOutcome = { task: { id: 't9', planVersion: 1, skill: 'use_skill', args: { name: 'guard-candidate', trial: true }, source: 'reflex', startedAt: Date.now(), deadline: Date.now() + 1000, progress: 1, note: '', movement: false }, result: { status: 'succeeded', summary: '举盾', data: { version: 1, verified: true } } as SkillResult, durationMs: 1 };
  w.arbiter.emit('done', outcome);
  (w.engine as any).judge('guard-candidate', true);
  assert.equal(after.length, 1);
  assert.match(after[0].msg, /做完后不久就死了/, '已完成候选报做完后死亡');
  assert.doesNotMatch(after[0].msg, /执行期间就死了/);
});

test('替代技能不能按 subsumed_by 收起自己（同名旧版并入新版）', async (t) => {
  const directory = tmp(), adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(null, directory);
  const engine = new BehaviorEngine(book, adapter, null, bus, senses0, path.join(directory, 'stats.json'));
  t.after(() => { engine.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  for (const name of ['skill-a', 'skill-b']) assert.ok(engine.write(codeSkill(name)).ok);
  for (let i = 0; i < 3; i++) engine.recordInvocation('skill-b', { status: 'succeeded', summary: '实际做成', data: { version: 1, verified: true } });
  let round = 0;
  const planner = { autonomous: true, noteInvalid() {}, complete: async () => {
    const text = round++ === 0
      ? JSON.stringify({ merge: [{ from: ['skill-a', 'skill-b'], skill: { name: 'skill-a', description: '合并 AB', code: 'return {worked:true};', verify: 'const s = await api.state(); return true;' } }] })
      : JSON.stringify({ retire: [{ name: 'skill-a', target: 'skill', version: 2, why: '已并入', subsumed_by: 'skill-a' }] });
    return { text, latencyMs: 0 };
  } };
  const curator = new SkillCurator(planner, engine, book, bus);
  await curator.check(Date.now(), { force: true }); // 第一轮：生成替代候选 skill-a v2
  for (let i = 0; i < 3; i++) engine.recordInvocation('skill-a', { status: 'succeeded', summary: '实际做成', data: { version: 2, verified: true } }); // 验收晋升 skill-a v2
  const result = await curator.check(Date.now(), { force: true });
  assert.equal(engine.inactive('skill-a'), false, '同名旧版并入新版后，当前版本就是替代结果，不能按替代收起它自己');
  assert.match(result!, /未完成/);
});

test('来源并入后又独立改版，旧替代关系不能收起新版', async (t) => {
  const directory = tmp(), adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(null, directory);
  const engine = new BehaviorEngine(book, adapter, null, bus, senses0, path.join(directory, 'stats.json'));
  t.after(() => { engine.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  for (const name of ['skill-a', 'skill-b']) assert.ok(engine.write(codeSkill(name)).ok);
  for (let i = 0; i < 3; i++) engine.recordInvocation('skill-b', { status: 'succeeded', summary: '实际做成', data: { version: 1, verified: true } });
  let round = 0;
  const planner = { autonomous: true, noteInvalid() {}, complete: async () => {
    const text = round++ === 0
      ? JSON.stringify({ merge: [{ from: ['skill-a', 'skill-b'], skill: { name: 'skill-a', description: '合并 AB', code: 'return {worked:true};', verify: 'const s = await api.state(); return true;' } }] })
      : JSON.stringify({ retire: [{ name: 'skill-b', target: 'skill', version: 2, why: '已并入', subsumed_by: 'skill-a' }] });
    return { text, latencyMs: 0 };
  } };
  const curator = new SkillCurator(planner, engine, book, bus);
  await curator.check(Date.now(), { force: true }); // 第一轮：B1 并入 A（记录 B v1 → A v2）
  for (let i = 0; i < 3; i++) engine.recordInvocation('skill-a', { status: 'succeeded', summary: '实际做成', data: { version: 2, verified: true } }); // 验收晋升 A v2
  assert.ok(engine.write({ name: 'skill-b', description: 'skill-b 用途扩展的做法', code: 'return {worked:true};', verify: 'const s = await api.state(); return true;' }, { by: 'mind' }).ok); // B 独立改版为 B2
  for (let i = 0; i < 3; i++) engine.recordInvocation('skill-b', { status: 'succeeded', summary: '实际做成', data: { version: 2, verified: true } }); // 验收晋升 B v2
  const result = await curator.check(Date.now(), { force: true });
  assert.equal(engine.inactive('skill-b'), false, 'B 并入 A 后又独立改版为 v2，旧关系只覆盖 B1，不能收起 B2');
  assert.match(result!, /未完成/);
});

test('文字合并失败后，下一轮仍不能按 subsumed_by 收起来源记录', async (t) => {
  const directory = tmp(), adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(null, directory);
  const engine = new BehaviorEngine(book, adapter, null, bus, senses0, path.join(directory, 'stats.json'));
  t.after(() => { engine.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  assert.ok(engine.write({ name: 'target-skill', description: '已有执行版本', code: 'return {worked:true};', verify: 'const s = await api.state(); return true;' }).ok);
  assert.ok(book.write('note-a', '做法 A 的说明', '做法 A 的内容，至少要二十个字才能写下来').ok);
  assert.ok(book.write('note-b', '做法 B 的说明', '做法 B 的内容，至少要二十个字才能写下来').ok);
  let round = 0;
  const planner = { autonomous: true, noteInvalid() {}, complete: async () => {
    const text = round++ === 0
      ? JSON.stringify({ merge: [{ from: ['note-a', 'note-b'], skill: { name: 'target-skill', description: '合并成已有技能名', body: '合并后的正文，至少要二十个字才能写下来' } }] })
      : JSON.stringify({ retire: [{ name: 'note-b', target: 'note', why: '已并入', subsumed_by: 'target-skill' }] });
    return { text, latencyMs: 0 };
  } };
  const curator = new SkillCurator(planner, engine, book, bus);
  await curator.check(Date.now(), { force: true }); // 第一轮：文字合并目标名被行为技能占用，失败
  const result = await curator.check(Date.now(), { force: true }); // 第二轮：仍声明 subsumed_by
  assert.equal(engine.inactive('note-b'), false, '文字合并失败后，下一轮仍不能按 subsumed_by 收起来源记录');
  assert.match(result!, /未完成/);
});

test('文字合并成功后，按 subsumed_by 收起来源记录才允许', async (t) => {
  const directory = tmp(), adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(null, directory);
  const engine = new BehaviorEngine(book, adapter, null, bus, senses0, path.join(directory, 'stats.json'));
  t.after(() => { engine.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  assert.ok(book.write('note-a', '做法 A 的说明', '做法 A 的内容，至少要二十个字才能写下来').ok);
  assert.ok(book.write('note-b', '做法 B 的说明', '做法 B 的内容，至少要二十个字才能写下来').ok);
  let round = 0;
  const planner = { autonomous: true, noteInvalid() {}, complete: async () => {
    const text = round++ === 0
      ? JSON.stringify({ merge: [{ from: ['note-a', 'note-b'], skill: { name: 'note-a', description: '合并 A 和 B 的做法', body: '合并后的做法正文，至少要二十个字才能写下来' } }] })
      : JSON.stringify({ retire: [{ name: 'note-b', target: 'note', why: '已并入', subsumed_by: 'note-a' }] });
    return { text, latencyMs: 0 };
  } };
  const curator = new SkillCurator(planner, engine, book, bus);
  await curator.check(Date.now(), { force: true }); // 第一轮：文字合并成功
  const result = await curator.check(Date.now(), { force: true }); // 第二轮：按替代收起
  assert.equal(engine.inactive('note-b'), true, '文字合并成功后，按 subsumed_by 收起来源记录才允许');
});
