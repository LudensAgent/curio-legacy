import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorldMemory } from '../src/memory/store.ts';
import { recallLocal } from '../src/mind/recall.ts';
import { SelfModel } from '../src/mind/self.ts';
import type { ActivityRecord } from '../src/mind/types.ts';

const record = (patch: Partial<ActivityRecord> & Pick<ActivityRecord, 'id' | 'outcome' | 'summary'>): ActivityRecord => ({
  what: '走远找树', kind: 'explore', durationSec: 30, gained: {}, lost: {}, at: Date.now(), signature: 'travel_to', failures: 0,
  exploration: { start: { x: 0, y: 64, z: 0 }, end: { x: 10, y: 64, z: 0 }, maxHorizontal: 10, visitedCells: 10, newChunks: 0, searchIntent: true, localOnly: false, found: [], blocked: false },
  ...patch,
});

test('有界尝试和只在原地的搜索成功，都不给策略记成功', () => {
  const self = new SelfModel(null);
  const k = self.learn('走远找树时沿北开巷', { source: 'reflection' })!;
  const apply = (patch: Partial<ActivityRecord>) => self.record(record({
    id: `a${Math.random()}`, applying: k.id, applyingText: k.text, outcome: 'done', summary: '步骤做完了', ...patch,
  }));
  apply({ completion: 'attempt' });
  assert.equal(k.wins, 0, '有界尝试只说明操作结束，不证明目标达成');
  apply({ completion: 'steps', exploration: { start: { x: 0, y: 64, z: 0 }, end: { x: 0.5, y: 64, z: 0 }, maxHorizontal: 0.5, visitedCells: 2, newChunks: 0, searchIntent: true, localOnly: true, found: [], blocked: false } });
  assert.equal(k.wins, 0, '只在原地/附近观察，不能证明“走远找”的策略正确');
  apply({ completion: 'steps', exploration: { start: { x: 0, y: 64, z: 0 }, end: { x: 10, y: 64, z: 0 }, maxHorizontal: 10, visitedCells: 10, newChunks: 1, searchIntent: true, localOnly: false, found: ['oak_log'], blocked: false } });
  assert.equal(k.wins, 1, '真正走出覆盖范围的成功才记成功');
});

test('明确应用失败留下反例；改写说法不删除反例', () => {
  const self = new SelfModel(null);
  const k = self.learn('走远找树时沿北开巷', { source: 'reflection' })!;
  self.record(record({
    id: 'a1', applying: k.id, applyingText: k.text, outcome: 'stuck', summary: '同一站位搜索与复验矛盾',
    stop: { reason: 'CONFLICT', detail: '边界 X 复验 OPEN，搜索仍不足' },
  }));
  assert.equal(k.losses, 1);
  assert.equal(k.counterexamples?.length, 1);
  assert.equal(k.counterexamples?.[0]?.reason, 'CONFLICT');
  assert.equal(k.counterexamples?.[0]?.summary, '同一站位搜索与复验矛盾');

  const revised = self.learn('走远找树前先核对边界证据，再决定是否开巷', { source: 'reflection', revise: k.id })!;
  assert.equal(revised.wins, 0);
  assert.equal(revised.applications, undefined);
  assert.deepEqual(revised.counterexamples, k.counterexamples, '换措辞不能洗掉旧反例');
});

test('合并近似经验时保留各条反例与适用边界；最近失败会降低默认注入排序', () => {
  const self = new SelfModel(null);
  const a = self.learn('矿道受阻时朝开阔方向开巷', { source: 'reflection', kind: 'explore' })!;
  const b = self.learn('遇到阻挡先看两侧支撑再开巷', { source: 'reflection', kind: 'explore' })!;
  a.limits = ['只适用于有两格高净空的巷道'];
  self.record(record({ id: 'a1', applying: a.id, applyingText: a.text, outcome: 'stuck', summary: '开巷后仍无落脚点', stop: { reason: 'UNKNOWN_BOUNDARY' } }));
  self.consolidate({ rewrite: [], merge: [{ ids: [a.id, b.id], text: '矿道受阻时先核对两侧支撑与净空，再朝开阔方向开巷' }], drop: [], add: [], agendaDrop: [] });
  const merged = self.data.knowHow.find((k) => k.text.includes('先核对两侧支撑'))!;
  assert.equal(merged.counterexamples?.length, 1);
  assert.deepEqual(merged.limits, ['只适用于有两格高净空的巷道']);
  assert.equal(merged.wins, 0);

  const before = self.relevantKnowHow('矿道 阻挡 开巷', 'explore', 5).findIndex((k) => k.id === merged.id);
  const rival = self.learn('矿道阻挡时开巷不如换一条已观测的支路', { source: 'reflection', kind: 'explore' })!;
  self.record(record({ id: 'a2', applying: rival.id, applyingText: rival.text, outcome: 'done', summary: '换支路走通', exploration: { start: { x: 0, y: 64, z: 0 }, end: { x: 20, y: 64, z: 0 }, maxHorizontal: 20, visitedCells: 20, newChunks: 1, searchIntent: true, localOnly: false, found: ['oak_log'], blocked: false } }));
  const after = self.relevantKnowHow('矿道 阻挡 开巷', 'explore', 5);
  assert.ok(after.findIndex((k) => k.id === merged.id) >= 0, '有反例的经验仍可按需召回');
  assert.ok(after.findIndex((k) => k.id === rival.id) < after.findIndex((k) => k.id === merged.id), '有成功证据的经验排在有反例的经验之前');
  assert.ok(before >= 0);
});

test('召回候选只给用途与验证状态，不催当场试用', (t) => {
  const self = new SelfModel(null), memory = new WorldMemory(null);
  t.after(() => memory.close());
  const book = {
    list: () => [{ name: 'lane-push', description: '沿矿道开巷推进', body: '开巷前先看支撑' }],
    candidate: () => ({ name: 'lane-push' }),
  } as any;
  const hits = recallLocal('lane-push 开巷 推进', { self, memory, book }, { n: 4 });
  const skill = hits.find((hit) => hit.kind === 'skill');
  assert.ok(skill);
  assert.doesNotMatch(skill.text, /别手写|直接用|催/);
  assert.match(skill.text, /候选/);
  assert.match(skill.text, /是否试用由你决定/);
  assert.match(skill.text, /触发条件/);
});

test('走了十几格但没确认目标，不能给“找要塞”的策略记成功，并留下反例', () => {
  const self = new SelfModel(null);
  const k = self.learn('沿北向开巷能找到下界要塞', { source: 'reflection', kind: 'explore' })!;
  const backlogBefore = self.reflectionBacklog();
  self.record(record({
    id: 'a1', applying: k.id, applyingText: k.text, outcome: 'done', completion: 'steps',
    summary: '开了 16 格，没看见要塞',
    exploration: { start: { x: 0, y: 64, z: 0 }, end: { x: 0, y: 64, z: -16 }, maxHorizontal: 16, visitedCells: 16, newChunks: 1, searchIntent: true, localOnly: false, found: [], blocked: false },
  }));
  assert.equal(k.wins, 0, '动作做完不等于找到目标');
  assert.equal(k.counterexamples?.length, 1);
  assert.equal(k.counterexamples?.[0]?.reason, 'TARGET_NOT_FOUND');
  assert.match(k.counterexamples?.[0]?.summary ?? '', /没有确认目标/);
  assert.ok(self.reflectionBacklog() > backlogBefore, '新反例进入反思待办');
});

test('反思输入带反例和适用边界，反例不会只留在运行账里', async () => {
  const { buildReflectionMessages } = await import('../src/mind/prompt.ts');
  const self = new SelfModel(null);
  const k = self.learn('走远找树时沿北开巷', { source: 'reflection' })!;
  k.limits = ['只适用于两格高净空的巷道'];
  self.record(record({ id: 'a1', applying: k.id, applyingText: k.text, outcome: 'stuck', summary: '同一站位搜索与复验矛盾', stop: { reason: 'CONFLICT' } }));
  const [, user] = buildReflectionMessages(self, '你叫 Curio。');
  assert.match(user.content, /"counterexamples"/);
  assert.match(user.content, /CONFLICT/);
  assert.match(user.content, /两格高净空/);
});

test('召回给每条标注当前目标/执行缺口/历史，不再混成一个相关度', (t) => {
  const self = new SelfModel(null), memory = new WorldMemory(null);
  t.after(() => memory.close());
  self.learn('砍树前先看树顶有没有落脚点', { source: 'reflection' });
  self.learn('卡住时先看支撑再开巷', { source: 'reflection' });
  self.learn('很久以前在河边见过牛群', { source: 'reflection' });
  const hits = recallLocal('砍树前 看树顶 卡住 支撑 开巷 河边 牛群', { self, memory }, { n: 6, goal: '砍树前 看树顶', gap: '卡住 支撑 开巷' });
  assert.ok(hits.some((hit) => hit.match === 'current_goal'), '目标匹配有标注');
  assert.ok(hits.some((hit) => hit.match === 'execution_gap'), '执行缺口匹配有标注');
  assert.ok(hits.some((hit) => hit.match === 'historical'), '历史经历仍是历史');
});
