import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { SkillCurator } from '../src/codeskills/curator.ts';
import { EventBus } from '../src/events.ts';
import { SkillBook } from '../src/knowledge/skillbook.ts';
import { BehaviorEngine } from '../src/mind/behaviors.ts';
import { FakeAdapter } from './fake-adapter.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'curio-substitution-'));

function setup(t: TestContext) {
  const directory = tmp();
  const book = new SkillBook(null, directory);
  const adapter = new FakeAdapter();
  const bus = new EventBus();
  const engine = new BehaviorEngine(book, adapter, null, bus, { perceivedEntities: () => [] }, path.join(directory, 'stats.json'));
  const lifetimeFile = path.join(directory, 'lifetimes.json');
  t.after(() => { engine.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, book, adapter, bus, engine, lifetimeFile };
}

/** 依次返回一组整理回复；用完复用最后一个。 */
function plannerOf(responses: unknown[]) {
  let i = 0;
  return { autonomous: true, noteInvalid() {}, async complete() {
    const response = responses[Math.min(i, responses.length - 1)];
    i++;
    return { text: JSON.stringify(response), latencyMs: 0 };
  } };
}

const noteA = { name: 'note-a', description: '观察记录甲的用途', body: '记录甲：观察了目标方块和真实背包变化，目前还没有验收这套做法。' };
const noteB = { name: 'note-b', description: '观察记录乙的用途', body: '记录乙：观察了目标方块和真实背包变化，目前还没有验收这套做法。' };
const mergedBody = '记录甲和乙：观察了目标方块和真实背包变化，目前还没有验收这套做法。';
const mergeAB = { merge: [{ from: ['note-a', 'note-b'], skill: { name: 'note-a', description: '合并两次观察留下的事实', body: mergedBody } }] };
const retireB = { retire: [{ name: 'note-b', target: 'note', why: '已并入 note-a', subsumed_by: 'note-a' }] };

test('文字来源在合并后又加料，旧合并关系不能按替代收起', async (t) => {
  const w = setup(t);
  assert.ok(w.book.write(noteA.name, noteA.description, noteA.body).ok);
  assert.ok(w.book.write(noteB.name, noteB.description, noteB.body).ok);
  const curator = new SkillCurator(plannerOf([mergeAB, retireB]), w.engine, w.book, w.bus, {}, undefined, w.lifetimeFile);
  assert.match((await curator.check(Date.now(), { force: true }))!, /文字记录 note-a/);
  // 合并后又给来源 note-b 增加尚未合并的新事实
  assert.ok(w.book.write(noteB.name, noteB.description, '记录乙：观察了目标方块和真实背包变化，并新增了尚未合并的事实。').ok);
  const result = await curator.check(Date.now(), { force: true });
  assert.match(result!, /又改了内容/);
  assert.equal(w.engine.inactive(noteB.name), false, '来源改写后保留，不按旧关系收起');
});

test('文字目标在合并后改写移除原合并内容，旧关系不能授权收起来源', async (t) => {
  const w = setup(t);
  assert.ok(w.book.write(noteA.name, noteA.description, noteA.body).ok);
  assert.ok(w.book.write(noteB.name, noteB.description, noteB.body).ok);
  const curator = new SkillCurator(plannerOf([mergeAB, retireB]), w.engine, w.book, w.bus, {}, undefined, w.lifetimeFile);
  assert.match((await curator.check(Date.now(), { force: true }))!, /文字记录 note-a/);
  // 改写目标 note-a，移除原先合并进来的 note-b 内容
  assert.ok(w.book.write(noteA.name, noteA.description, '记录甲：只剩原本甲的内容，合并进来的乙内容已移除。').ok);
  const result = await curator.check(Date.now(), { force: true });
  assert.match(result!, /已改写/);
  assert.equal(w.engine.inactive(noteB.name), false, '目标改写后保留来源');
});

test('文字未改写按替代正常收起，持久化重载后仍可', async (t) => {
  const w = setup(t);
  assert.ok(w.book.write(noteA.name, noteA.description, noteA.body).ok);
  assert.ok(w.book.write(noteB.name, noteB.description, noteB.body).ok);
  const curator = new SkillCurator(plannerOf([mergeAB, retireB]), w.engine, w.book, w.bus, {}, undefined, w.lifetimeFile);
  assert.match((await curator.check(Date.now(), { force: true }))!, /文字记录 note-a/);
  const substitutionsFile = w.lifetimeFile.replace(/(\.json)?$/, '') + '-substitutions.json';
  const persisted = JSON.parse(fs.readFileSync(substitutionsFile, 'utf8'));
  assert.equal(typeof persisted['note-b']?.sourceText, 'string', '合并关系持久化了来源内容标识');
  assert.equal(typeof persisted['note-b']?.targetText, 'string', '合并关系持久化了目标内容标识');
  // 重建整理器（重载持久化的替代关系），内容未变化时正常收起
  const reloaded = new SkillCurator(plannerOf([retireB]), w.engine, w.book, w.bus, {}, undefined, w.lifetimeFile);
  assert.match((await reloaded.check(Date.now(), { force: true }))!, /收起文字记录 note-b/);
  assert.equal(w.engine.inactive(noteB.name), true, '未改写时正常收起');
});

test('旧持久化文字关系缺少内容标识，不能猜它覆盖当前内容', async (t) => {
  const w = setup(t);
  assert.ok(w.book.write(noteA.name, noteA.description, noteA.body).ok);
  assert.ok(w.book.write(noteB.name, noteB.description, noteB.body).ok);
  const substitutionsFile = w.lifetimeFile.replace(/(\.json)?$/, '') + '-substitutions.json';
  fs.writeFileSync(substitutionsFile, JSON.stringify({ 'note-b': { into: 'note-a', version: 0, fromVersion: 0, at: 1 } }));
  const curator = new SkillCurator(plannerOf([retireB]), w.engine, w.book, w.bus, {}, undefined, w.lifetimeFile);
  const result = await curator.check(Date.now(), { force: true });
  assert.match(result!, /缺少内容标识/);
  assert.equal(w.engine.inactive(noteB.name), false, '缺少内容标识的旧关系不能授权收起');
});

test('应急来源按已验证替代收起：目标未验收拒绝、验收晋升后放行', async (t) => {
  const w = setup(t);
  const def = (name: string) => ({ name, description: '血少时按处境做应急动作并核对结果', body: '只执行指定动作，返回观测结果。',
    code: 'return {worked:true};', verify: 'const s = await api.state(); return true;', when: { hp_below: 8 } });
  assert.ok(w.engine.write(def('rescue-a')).ok);
  assert.ok(w.engine.write(def('rescue-b')).ok);
  for (let i = 0; i < 3; i++) w.engine.recordInvocation('rescue-b', { status: 'succeeded', summary: '观测确认危险解除', data: { version: 1, verified: true } });
  assert.deepEqual(w.engine.currentStats('rescue-b'), { ok: 3, fail: 0 });
  const merge = { merge: [{ from: ['rescue-a', 'rescue-b'], skill: { ...def('rescue-a'), description: '合并后的应急做法' } }] };
  const retire = { retire: [{ name: 'rescue-b', target: 'skill', version: 1, why: '已并入 rescue-a', subsumed_by: 'rescue-a' }] };
  const curator = new SkillCurator(plannerOf([merge, retire]), w.engine, w.book, w.bus, {}, undefined, w.lifetimeFile);
  assert.match((await curator.check(Date.now(), { force: true }))!, /候选 rescue-a/);
  assert.equal(w.engine.get('rescue-a', true)?.version, 2, '合并生成候选 rescue-a v2');
  assert.equal(w.engine.get('rescue-b')?.version, 1, '来源 rescue-b 仍是稳定 v1');
  // 目标尚未验收晋升：按替代收起被拒绝，继续保护应急来源
  const rejected = await curator.check(Date.now(), { force: true });
  assert.match(rejected!, /还没验收晋升/);
  assert.equal(w.engine.inactive('rescue-b'), false, '目标未验收时保护应急来源');
  // 候选 rescue-a v2 获得三次 verified 晋升为稳定可执行版
  for (let i = 0; i < 3; i++) w.engine.recordInvocation('rescue-a', { status: 'succeeded', summary: '观测确认危险解除', data: { version: 2, verified: true } });
  assert.equal(w.engine.get('rescue-a')?.version, 2, 'rescue-a v2 已晋升稳定');
  assert.equal(w.engine.handlesNow('rescue-a'), null, 'rescue-a v2 当前可执行');
  // 验收后按替代收起：放行冗余应急来源
  const allowed = await curator.check(Date.now(), { force: true });
  assert.match(allowed!, /收起 rescue-b/);
  assert.equal(w.engine.inactive('rescue-b'), true, '已验证替代收起冗余应急来源');
});
