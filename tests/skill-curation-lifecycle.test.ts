import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { SkillCurator } from '../src/codeskills/curator.ts';
import { CodeImprover } from '../src/codeskills/improver.ts';
import { EventBus } from '../src/events.ts';
import { SkillBook } from '../src/knowledge/skillbook.ts';
import { BehaviorEngine } from '../src/mind/behaviors.ts';
import { Mind } from '../src/mind/mind.ts';
import { FakeAdapter } from './fake-adapter.ts';

const hour = 3_600_000;
const definition = { name: 'measured-craft', description: '按点名物品合成并核对背包变化', body: '输入点名物品；只完成指定合成，按实际背包变化确认结果。',
  code: 'return {worked:true};', verify: 'return true;' };

function setup(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-curation-'));
  const book = new SkillBook(null, directory), adapter = new FakeAdapter(), bus = new EventBus();
  const statsFile = path.join(directory, 'stats.json');
  const engine = new BehaviorEngine(book, adapter, null, bus, { perceivedEntities: () => [] }, statsFile);
  t.after(() => { engine.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  const planner = { autonomous: true, noteInvalid() {}, async complete() { return { text: '{"ok":true}', latencyMs: 0 }; } };
  return { directory, statsFile, book, adapter, bus, engine, planner };
}

test('闲置候选独立收起，稳定版的实际使用不刷新候选，重载仍可读收起版本', async (t) => {
  const w = setup(t), start = Date.now();
  let now = start;
  t.mock.method(Date, 'now', () => now);
  assert.ok(w.engine.write(definition).ok);
  assert.ok(w.engine.write(definition, { by: 'mind' }).ok);
  const curator = new SkillCurator(w.planner, w.engine, w.book, w.bus);
  now = start + 2 * hour;
  w.engine.recordInvocation(definition.name, { status: 'succeeded', summary: '实际完成指定合成', data: { version: 1, verified: true } });
  now = start + 3 * hour;
  assert.deepEqual(curator.retireUnused(now), [definition.name]);
  assert.equal(w.engine.executionError(definition.name), null);
  assert.match(w.engine.executionError(definition.name, true)!, /候选 v2 已收起/);
  assert.equal(w.engine.hidden(definition.name), false);
  assert.deepEqual(w.engine.currentStats(definition.name), { ok: 1, fail: 0 });
  w.book.reload();
  const reloaded = new BehaviorEngine(w.book, w.adapter, null, w.bus, { perceivedEntities: () => [] }, w.statsFile);
  t.after(() => reloaded.dispose());
  assert.equal(reloaded.candidateRetirement(definition.name)?.version, 2);
  assert.equal(w.book.candidate(definition.name)?.body.includes(definition.body), true);
  assert.ok(w.book.write('report-note', '保存真实观察的文字记录', '已经看见的结果保存在这里，尚未得到足够证据的推断仍然只是待检验假设。').ok);
  now += 3 * hour;
  assert.match((await curator.check(now, { force: true }))!, /已收起.*不用整理/, '自动收起结果不会被模型的无需整理回复抹掉');
  assert.ok(w.bus.recent().some((event) => event.type === 'skill_curated'));
});

test('候选收起阻止旧后台结果和迟到验收晋升，心智显式新修订可再试', (t) => {
  const w = setup(t);
  assert.ok(w.engine.write(definition, { by: 'mind' }).ok);
  const token = w.engine.editToken(definition.name);
  assert.equal(w.engine.retireCandidate(definition.name, 1, '当前做法无效'), true);
  assert.equal(w.engine.hidden(definition.name), true);
  assert.equal(w.engine.write(definition, { by: 'improve', expectedToken: token }).ok, false);
  assert.equal(w.engine.write(definition, { by: 'forge' }).ok, false);
  assert.match(new CodeImprover(w.planner, w.engine, w.bus).consider(definition.name, 'requested')!, /候选已收起/);
  for (let i = 0; i < 3; i++) w.engine.recordInvocation(definition.name, { status: 'succeeded', summary: '旧执行迟到的结果', data: { version: 1, verified: true } });
  assert.equal(w.engine.get(definition.name)?.candidate, true);
  assert.equal(w.bus.recent().some((event) => event.type === 'skill_promoted'), false);
  assert.ok(w.engine.write(definition, { by: 'mind' }).ok);
  assert.equal(w.engine.get(definition.name, true)?.version, 2);
  assert.equal(w.engine.executionError(definition.name, true), null);
  assert.equal(w.engine.hidden(definition.name), false);
  assert.ok(w.book.definitionVersion(definition.name, 1));
  assert.ok(w.engine.retire(definition.name, '名称曾被收起'));
  assert.ok(w.engine.write(definition, { by: 'mind' }).ok);
  const catalog = JSON.parse(new SkillCurator(w.planner, w.engine, w.book, w.bus).messages()[1].content);
  assert.ok(catalog.skills.some((entry: { name: string; version: number }) => entry.name === definition.name && entry.version === 3), '明确允许再试的候选仍接受整理');
});

test('停用正式技能和纯文字进入模型整理，文字不按执行次数淘汰并可由心智恢复', async (t) => {
  const w = setup(t);
  assert.ok(w.engine.write(definition).ok);
  for (let i = 0; i < 4; i++) w.engine.recordInvocation(definition.name, { status: 'failed', summary: '指定合成未完成', data: { version: 1 } });
  assert.equal(w.engine.statsOf(definition.name)?.disabled, true);
  assert.ok(w.book.write('working-notes', '背包变化的观察记录', '这份文字记录说明了已见到的背包变化，以及尚未验证的假设。').ok);
  const planner = { ...w.planner, async complete() { return { text: JSON.stringify({ retire: [
    { name: definition.name, target: 'skill', version: 1, why: '当前版本连续失败' },
    { name: 'working-notes', target: 'note', why: '已被新的观察记录完整覆盖' },
  ] }), latencyMs: 0 }; } };
  const curator = new SkillCurator(planner, w.engine, w.book, w.bus);
  const payload = JSON.parse(curator.messages()[1].content);
  assert.equal(payload.skills[0].disabled, true);
  assert.equal(payload.notes[0].name, 'working-notes');
  assert.deepEqual(curator.retireLowValue(Date.now() + 2 * hour), [], '四次失败由停用和模型评估处理；文字不参与运行低价值阈值');
  assert.match((await curator.check(Date.now(), { force: true }))!, /收起文字记录/);
  assert.equal(w.engine.hidden('working-notes'), true);
  assert.ok(w.book.get('working-notes'));
  const mind = Object.create(Mind.prototype) as Mind;
  Object.defineProperty(mind, 'd', { value: { behaviors: w.engine, self: { think() {} } } });
  Reflect.apply(Mind.prototype['applySkill'], mind, [{ skill: { name: 'working-notes', restore: true }, notes: [] }]);
  assert.equal(w.engine.hidden('working-notes'), false);
  assert.equal(w.engine.statsOf('working-notes')?.ok, 0);
});

test('文字可按内容合并和恢复，自动闲置与容量规则不淘汰文字', async (t) => {
  const w = setup(t);
  const body = '记录甲：观察了目标方块和真实背包变化，目前还没有验收这套做法。';
  assert.ok(w.book.write('first-note', '观察记录甲的用途', body).ok);
  assert.ok(w.book.write('second-note', '观察记录乙的用途', body).ok);
  assert.ok(w.engine.retire('second-note', '暂时收起'));
  const curator = new SkillCurator({ ...w.planner, async complete() { return { text: JSON.stringify({
    merge: [{ from: ['first-note', 'second-note'], skill: { name: 'combined-note', description: '合并两次观察留下的事实', body } }],
    restore: [{ name: 'second-note', why: '这次仍有用' }],
  }), latencyMs: 0 }; } }, w.engine, w.book, w.bus, { maxActive: 0, unusedMs: 1 });
  assert.deepEqual(curator.retireUnused(Date.now() + 10 * hour), []);
  assert.deepEqual(curator.retireLowValue(Date.now() + 10 * hour), []);
  assert.match((await curator.check(Date.now(), { force: true }))!, /文字记录 combined-note/);
  assert.equal(w.book.get('combined-note')?.behavior, undefined);
  assert.equal(w.engine.hidden('second-note'), false);
});

test('强制整理绕过自动门槛，保留忙碌和候选证据保护并报告空库或无模型', async (t) => {
  const w = setup(t);
  const empty = new SkillCurator(w.planner, w.engine, w.book, w.bus);
  assert.match((await empty.check(Date.now(), { force: true }))!, /没有可整理/);
  const offline = new SkillCurator({ ...w.planner, autonomous: false }, w.engine, w.book, w.bus);
  assert.match((await offline.check(Date.now(), { force: true }))!, /没有自主模型/);
  assert.ok(w.engine.write(definition, { by: 'mind' }).ok);
  let count = 0;
  const curator = new SkillCurator({ ...w.planner, async complete() { count++; return { text: '{"ok":true}', latencyMs: 0 }; } }, w.engine, w.book, w.bus, { minSkills: 20, gapMs: 10 * hour });
  assert.equal(await curator.check(), null);
  assert.equal(await curator.check(Date.now(), { force: true }), '不用整理');
  assert.equal(await curator.check(Date.now(), { force: true }), '不用整理');
  assert.equal(count, 2, '同一签名和间隔限制不拦手动整理');
  curator.busy = true;
  assert.match((await curator.check(Date.now(), { force: true }))!, /正在整理/);
  assert.equal(count, 2);
  const protectedCurator = new SkillCurator({ ...w.planner, async complete() { return { text: JSON.stringify({ retire: [{ name: definition.name, target: 'candidate', version: 1, why: '还未试用' }] }), latencyMs: 0 }; } }, w.engine, w.book, w.bus);
  assert.match((await protectedCurator.check(Date.now(), { force: true }))!, /证据还少/);
  assert.equal(w.engine.candidateRetirement(definition.name), undefined);
  const broken = new SkillCurator({ ...w.planner, async complete() { throw new Error('模型暂时不可用'); } }, w.engine, w.book, w.bus);
  assert.equal(await broken.check(Date.now(), { force: true }), null, '模型错误不能伪装成成功的手动整理');
  assert.equal(broken.busy, false);
  assert.match(broken.history.at(-1)!.result, /整理出错：模型暂时不可用/);
});

test('同名稳定加候选不重复占容量，模型不能省略版本误收稳定版', async (t) => {
  const w = setup(t);
  assert.ok(w.engine.write(definition).ok);
  assert.ok(w.engine.write(definition, { by: 'mind' }).ok);
  const curator = new SkillCurator({ ...w.planner, async complete() { return { text: JSON.stringify({ retire: [{ name: definition.name, why: '候选不好用' }] }), latencyMs: 0 }; } }, w.engine, w.book, w.bus, { maxActive: 1 });
  assert.deepEqual(curator.retireLowValue(Date.now() + 2 * hour), []);
  assert.match((await curator.check(Date.now(), { force: true }))!, /目标不明确/);
  assert.equal(w.engine.executionError(definition.name), null);
  assert.equal(w.engine.executionError(definition.name, true), null);
  assert.ok(w.book.write('noted-candidate', '带笔记的候选行为', '这份笔记保存了前后观测依据，还未说明该候选已经实际验证成功。').ok);
  assert.ok(w.engine.write({ ...definition, name: 'noted-candidate' }, { by: 'mind' }).ok);
  const requested: string[] = [];
  w.engine.improve = (name) => { requested.push(name); };
  const improve = new SkillCurator({ ...w.planner, async complete() { return { text: '{"improve":[{"name":"noted-candidate","why":"按已有失败证据修订"}]}', latencyMs: 0 }; } }, w.engine, w.book, w.bus);
  assert.match((await improve.check(Date.now(), { force: true }))!, /改进 noted-candidate/);
  assert.deepEqual(requested, ['noted-candidate']);
});
