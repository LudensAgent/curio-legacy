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
  assert.match(result!, /内容标识已变化/);
  assert.equal(w.engine.inactive(noteB.name), false, '目标改写后保留来源');
});

test('仅修改目标说明、正文不变：拒绝退役但不声称原内容消失', async (t) => {
  const w = setup(t);
  assert.ok(w.book.write(noteA.name, noteA.description, noteA.body).ok);
  assert.ok(w.book.write(noteB.name, noteB.description, noteB.body).ok);
  const curator = new SkillCurator(plannerOf([mergeAB, retireB]), w.engine, w.book, w.bus, {}, undefined, w.lifetimeFile);
  assert.match((await curator.check(Date.now(), { force: true }))!, /文字记录 note-a/);
  // 只改目标 note-a 的说明，正文保持合并后的内容不变
  assert.ok(w.book.write(noteA.name, '改写的目标说明', mergedBody).ok);
  const result = await curator.check(Date.now(), { force: true });
  assert.match(result!, /内容标识已变化/);
  assert.doesNotMatch(result!, /原合并内容已不在|已不在|原内容/);
  assert.equal(w.engine.inactive(noteB.name), false, '仅说明变化也拒绝退役');
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

/** 暂停在 planner 返回前，让测试在模型“思考”期间改动文字内容。 */
function gatedPlanner() {
  let release!: (text: string) => void;
  let captured: unknown[] = [];
  let signal!: () => void;
  const reply = new Promise<string>((resolve) => { release = resolve; });
  const called = new Promise<void>((resolve) => { signal = resolve; });
  return {
    autonomous: true, noteInvalid() {},
    async complete(messages: unknown[]) { captured = messages; signal(); return { text: await reply, latencyMs: 0 }; },
    release(text: string) { release(text); },
    messages: () => captured,
    called,
  };
}

test('模型等待回复期间来源被改写，过期合并不能建立替代授权', async (t) => {
  const w = setup(t);
  assert.ok(w.book.write(noteA.name, noteA.description, noteA.body).ok);
  assert.ok(w.book.write(noteB.name, noteB.description, noteB.body).ok);
  const planner = gatedPlanner();
  const curator = new SkillCurator(planner, w.engine, w.book, w.bus, {}, undefined, w.lifetimeFile);
  const checking = curator.check(Date.now(), { force: true });
  await planner.called;
  // 模型输入确实不包含等待期间才新增的内容
  const user = JSON.parse((planner.messages()[1] as { content: string }).content);
  assert.equal(user.notes.some((n: { name: string; body: string }) => n.name === 'note-b' && n.body.includes('等待期间新增的事实')), false);
  // 等待期间真实修改来源 note-b
  assert.ok(w.book.write(noteB.name, noteB.description, '记录乙：观察了目标方块和真实背包变化，并新增等待期间新增的事实。').ok);
  planner.release(JSON.stringify(mergeAB));
  const result = await checking;
  assert.match(result!, /整理期间被改写/);
  assert.match(w.book.get(noteB.name)!.body, /等待期间新增的事实/, '来源新内容被保留');
  // 旧结果不能授权收起新版 note-b：下一轮按替代收起被拒绝
  const retire = new SkillCurator(plannerOf([retireB]), w.engine, w.book, w.bus, {}, undefined, w.lifetimeFile);
  assert.match((await retire.check(Date.now(), { force: true }))!, /没有记录成功并入/);
  assert.equal(w.engine.inactive(noteB.name), false, '过期合并不授权收起新版来源');
});

test('模型等待回复期间目标被改写，过期合并不覆盖目标新内容', async (t) => {
  const w = setup(t);
  assert.ok(w.book.write(noteA.name, noteA.description, noteA.body).ok);
  assert.ok(w.book.write(noteB.name, noteB.description, noteB.body).ok);
  const planner = gatedPlanner();
  const curator = new SkillCurator(planner, w.engine, w.book, w.bus, {}, undefined, w.lifetimeFile);
  const checking = curator.check(Date.now(), { force: true });
  await planner.called;
  // 等待期间真实修改目标 note-a
  assert.ok(w.book.write(noteA.name, noteA.description, '记录甲：目标新增的、尚未被模型看到的事实。').ok);
  planner.release(JSON.stringify(mergeAB));
  const result = await checking;
  assert.match(result!, /整理期间被改写/);
  assert.match(w.book.get(noteA.name)!.body, /目标新增的/, '目标新内容被保留，未被旧合并覆盖');
  assert.equal(w.engine.inactive(noteB.name), false);
});

function buildEnv(directory: string) {
  const book = new SkillBook(null, directory);
  const adapter = new FakeAdapter();
  const bus = new EventBus();
  const engine = new BehaviorEngine(book, adapter, null, bus, { perceivedEntities: () => [] }, path.join(directory, 'stats.json'));
  return { book, adapter, bus, engine, lifetimeFile: path.join(directory, 'lifetimes.json') };
}

test('完整重载后说明引号与正文截断边界保持一致，未改内容仍可按替代退役', async (t) => {
  const directory = tmp();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const first = buildEnv(directory);
  t.after(() => first.engine.dispose());
  const src = 'quoted-src', dst = 'quoted-dst';
  assert.ok(first.book.write(src, '"来源说明带引号"', '记录来源：观察了目标方块和真实背包变化，目前还没有验收这套做法。').ok);
  assert.ok(first.book.write(dst, "'目标说明带引号'", '记录目标：观察了目标方块和真实背包变化，目前还没有验收这套做法。').ok);
  const boundarySrc = 'boundary-src', boundaryDst = 'boundary-dst';
  assert.ok(first.book.write(boundarySrc, '截断来源的用途', 'x'.repeat(5999) + ' y').ok);
  assert.ok(first.book.write(boundaryDst, '截断目标的用途', '记录目标：观察了目标方块和真实背包变化，目前还没有验收这套做法。').ok);
  const mergeAll = { merge: [
    { from: [src], skill: { name: dst, description: '合并后的目标说明', body: '记录来源与目标合并后的正文，目前尚未验收这套做法。' } },
    { from: [boundarySrc], skill: { name: boundaryDst, description: '合并后的截断目标说明', body: '记录截断来源与目标合并后的正文，目前尚未验收这套做法。' } },
  ] };
  const curator = new SkillCurator(plannerOf([mergeAll]), first.engine, first.book, first.bus, {}, undefined, first.lifetimeFile);
  const merged = await curator.check(Date.now(), { force: true });
  assert.match(merged!, /文字记录 quoted-dst/);
  assert.match(merged!, /文字记录 boundary-dst/);
  // 记录合并后的内存内容，供重载后对比（说明去引号、正文截断边界都应是稳定的规范形式）
  const before = JSON.stringify([src, dst, boundarySrc, boundaryDst].map((n) => ({ d: first.book.get(n)!.description, b: first.book.get(n)!.body })));
  // 完整重建 SkillBook / BehaviorEngine / SkillCurator（不复用旧内存实例）
  first.engine.dispose();
  const second = buildEnv(directory);
  t.after(() => second.engine.dispose());
  const after = JSON.stringify([src, dst, boundarySrc, boundaryDst].map((n) => ({ d: second.book.get(n)!.description, b: second.book.get(n)!.body })));
  assert.equal(after, before, '完整重载后说明与正文应保持一致');
  const reloaded = new SkillCurator(plannerOf([{ retire: [
    { name: src, target: 'note', why: '已并入 quoted-dst', subsumed_by: dst },
    { name: boundarySrc, target: 'note', why: '已并入 boundary-dst', subsumed_by: boundaryDst },
  ] }]), second.engine, second.book, second.bus, {}, undefined, second.lifetimeFile);
  const result = await reloaded.check(Date.now(), { force: true });
  assert.match(result!, /收起文字记录 quoted-src/);
  assert.match(result!, /收起文字记录 boundary-src/);
  assert.equal(second.engine.inactive(src), true, '未改内容重载后仍按替代收起');
  assert.equal(second.engine.inactive(boundarySrc), true, '截断边界正文重载后仍按替代收起');
});

test('完整重载后真实修改来源仍拒绝旧关系', async (t) => {
  const directory = tmp();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const first = buildEnv(directory);
  t.after(() => first.engine.dispose());
  assert.ok(first.book.write(noteA.name, noteA.description, noteA.body).ok);
  assert.ok(first.book.write(noteB.name, noteB.description, noteB.body).ok);
  const curator = new SkillCurator(plannerOf([mergeAB]), first.engine, first.book, first.bus, {}, undefined, first.lifetimeFile);
  assert.match((await curator.check(Date.now(), { force: true }))!, /文字记录 note-a/);
  // 完整重建后，在新实例上真实修改来源
  first.engine.dispose();
  const second = buildEnv(directory);
  t.after(() => second.engine.dispose());
  assert.ok(second.book.write(noteB.name, noteB.description, '记录乙：观察了目标方块和真实背包变化，并新增重载后的事实。').ok);
  const reloaded = new SkillCurator(plannerOf([retireB]), second.engine, second.book, second.bus, {}, undefined, second.lifetimeFile);
  const result = await reloaded.check(Date.now(), { force: true });
  assert.match(result!, /又改了内容/);
  assert.equal(second.engine.inactive(noteB.name), false, '重载后真实修改仍拒绝旧关系');
});
