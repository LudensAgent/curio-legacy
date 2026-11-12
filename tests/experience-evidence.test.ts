import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorldMemory } from '../src/memory/store.ts';
import { recallLocal } from '../src/mind/recall.ts';
import { createActivity, recordOf } from '../src/mind/activity.ts';
import { SelfModel } from '../src/mind/self.ts';
import type { AgentState } from '../src/adapter/types.ts';
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

test('合并近似经验时保留各条反例与适用边界；最近失败会降低默认注入排序', (t) => {
  const self = new SelfModel(null), memory = new WorldMemory(null);
  t.after(() => memory.close());
  const a = self.learn('矿道受阻时朝开阔方向开巷', { source: 'reflection', kind: 'explore' })!;
  const b = self.learn('遇到阻挡先看两侧支撑再开巷', { source: 'reflection', kind: 'explore' })!;
  a.limits = ['只适用于有两格高净空的巷道'];
  self.record(record({ id: 'a1', applying: a.id, applyingText: a.text, outcome: 'stuck', summary: '开巷后仍无落脚点', stop: { reason: 'UNKNOWN_BOUNDARY' } }));
  self.consolidate({ rewrite: [], merge: [{ ids: [a.id, b.id], text: '矿道受阻时先核对两侧支撑与净空，再朝开阔方向开巷' }], drop: [], add: [], agendaDrop: [] });
  const merged = self.data.knowHow.find((k) => k.text.includes('先核对两侧支撑'))!;
  assert.equal(merged.counterexamples?.length, 1);
  assert.deepEqual(merged.limits, ['只适用于有两格高净空的巷道']);
  assert.equal(merged.wins, 0);

  const rival = self.learn('矿道阻挡时开巷不如换一条已观测的支路', { source: 'reflection', kind: 'explore' })!;
  self.record(record({ id: 'a2', applying: rival.id, applyingText: rival.text, outcome: 'done', summary: '换支路走通', exploration: { start: { x: 0, y: 64, z: 0 }, end: { x: 20, y: 64, z: 0 }, maxHorizontal: 20, visitedCells: 20, newChunks: 1, searchIntent: true, localOnly: false, found: ['oak_log'], blocked: false } }));
  const recalled = recallLocal('矿道 阻挡 开巷', { self, memory }, { n: 10, goal: '矿道 阻挡 开巷' });
  const mergedScore = recalled.find((hit) => hit.ref === merged.id)?.score;
  const rivalScore = recalled.find((hit) => hit.ref === rival.id)?.score;
  assert.ok(mergedScore !== undefined, '有反例的经验仍可按需召回');
  assert.ok((rivalScore ?? 0) > (mergedScore ?? 0), '有成功证据的经验排在有反例的经验之前');
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
    resource: { intent: true, mode: 'find', targets: ['fortress'], located: false, acquired: null, goalIncomplete: true },
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

test('不同执行记录的反例不因摘要前缀相同而互相覆盖；同一记录重复才去重', () => {
  const self = new SelfModel(null);
  const k = self.learn('走远找树时沿北开巷', { source: 'reflection' })!;
  const apply = (id: string, summary: string, reason: string) => self.record(record({
    id, applying: k.id, applyingText: k.text, outcome: 'stuck', summary, stop: { reason },
  }));
  apply('a1', '同一站位搜索与复验矛盾：东侧边界', 'CONFLICT');
  apply('a2', '同一站位搜索与复验矛盾：西侧边界', 'CONFLICT');
  apply('a3', '开巷后没有落脚点', 'UNKNOWN_BOUNDARY');
  assert.equal(k.counterexamples?.length, 3, '不同经历都保留，不靠摘要前缀合并');
  assert.deepEqual(k.counterexamples?.map((c) => c.claim), [k.text, k.text, k.text], '每条绑定当时的说法');
  apply('a1', '同一站位搜索与复验矛盾：东侧边界（重复回执）', 'CONFLICT');
  assert.equal(k.counterexamples?.length, 3, '同一活动 id 的重复回执只更新，不增加');
  assert.match(k.counterexamples!.find((c) => c.activityId === 'a1')!.summary, /重复回执/);
});

test('没有寻找对象的“向北探索 96 格”不写目标失败反例；点名目标才写', () => {
  const self = new SelfModel(null);
  const k = self.learn('沿北向探索能推进', { source: 'reflection', kind: 'explore' })!;
  const explore = { start: { x: 0, y: 64, z: 0 }, end: { x: 0, y: 64, z: -96 }, maxHorizontal: 96, visitedCells: 96, newChunks: 4, searchIntent: true, localOnly: false, found: [], blocked: false };
  self.record(record({
    id: 'a1', applying: k.id, applyingText: k.text, outcome: 'done', completion: 'steps', summary: '向北走了 96 格',
    exploration: explore, resource: { intent: true, located: false, acquired: null, goalIncomplete: false },
  }));
  assert.equal(k.wins, 0, '没确认找到东西，不能记策略成功');
  assert.equal(k.counterexamples?.length ?? 0, 0, '本来没有寻找对象，不是目标失败');

  self.record(record({
    id: 'a2', applying: k.id, applyingText: k.text, outcome: 'done', completion: 'steps', summary: '向北走了 32 格，没找到橡木',
    exploration: { ...explore, maxHorizontal: 32, end: { x: 0, y: 64, z: -32 } },
    resource: { intent: true, mode: 'find', targets: ['oak_log'], located: false, acquired: null, goalIncomplete: true },
  }));
  assert.equal(k.counterexamples?.length, 1, '点名了橡木且没找到，才写目标反例');
  assert.equal(k.counterexamples?.[0]?.reason, 'TARGET_NOT_FOUND');
});

test('明确未找到目标的经验进入召回降权，而不是仍按成功相关度排', (t) => {
  const self = new SelfModel(null), memory = new WorldMemory(null);
  t.after(() => memory.close());
  const k = self.learn('找下界要塞时沿北开巷', { source: 'reflection', kind: 'explore' })!;
  const score = () => recallLocal('找下界要塞 开巷', { self, memory }, { n: 6, goal: '找下界要塞 开巷' })
    .find((hit) => hit.ref === k.id)?.score ?? 0;
  const before = score();
  self.record(record({
    id: 'a1', applying: k.id, applyingText: k.text, outcome: 'done', completion: 'steps', summary: '开了 16 格，没找到下界要塞',
    exploration: { start: { x: 0, y: 64, z: 0 }, end: { x: 0, y: 64, z: -16 }, maxHorizontal: 16, visitedCells: 16, newChunks: 1, searchIntent: true, localOnly: false, found: [], blocked: false },
    resource: { intent: true, mode: 'find', targets: ['fortress'], located: false, acquired: null, goalIncomplete: true },
  }));
  assert.equal(k.wins, 0);
  assert.equal(k.counterexamples?.length, 1);
  assert.ok(score() < before, 'TARGET_NOT_FOUND 反例应降低默认召回分数');
});


const exploreState = (inventory: { name: string; count: number }[] = []) => ({
  connected: true, alive: true, observationReady: true, observationId: 1, username: 'tester',
  sessionId: 's', worldId: 'w', dim: 'the_nether', pos: { x: 0.5, y: 64, z: 0.5 },
  hp: 20, food: 20, oxygen: 20, timeOfDay: 0,
  inventory, emptySlots: 36 - inventory.length, equipment: [], held: null,
} as unknown as AgentState);

test('显式 until 的搜索意图不依赖标题；混合活动采到别的资源也不给寻找策略记胜', () => {
  const self = new SelfModel(null);
  const k = self.learn('沿北向找下界砖', { source: 'reflection', kind: 'explore' })!;
  const a = createActivity({
    what: '继续向北前进', why: '', kind: 'explore', repeat: 1,
    steps: [{ skill: 'explore_toward', args: { direction: 'N', distance: 96, until: 'nether_bricks' } }],
  }, '', 'llm', exploreState());
  a.results.push({ skill: 'explore_toward', args: {}, status: 'succeeded', summary: '走了 96 格，没找到下界砖', at: Date.now(), durationMs: 100,
    pos: { x: 0.5, y: 64, z: -95.5 }, data: { travelled: 96 } });
  const record = recordOf(a, 'done', '向北走了 96 格', exploreState());
  assert.equal(record.exploration?.searchIntent, true, 'until 契约生成搜索意图');
  self.record({ ...record, applying: k.id, applyingText: k.text });
  assert.equal(k.wins, 0);
  assert.equal(k.counterexamples?.length, 1, '标题不同也留下 TARGET_NOT_FOUND');

  const mixed = createActivity({
    what: '顺路采点地狱岩', why: '', kind: 'explore', repeat: 1,
    steps: [
      { skill: 'explore_toward', args: { direction: 'N', distance: 96, until: 'nether_bricks' } },
      { skill: 'gather', args: { block: 'netherrack', count: 6 } },
    ],
  }, '', 'llm', exploreState());
  mixed.results.push({ skill: 'explore_toward', args: {}, status: 'succeeded', summary: '没找到下界砖', at: Date.now(), durationMs: 100,
    pos: { x: 0.5, y: 64, z: -50.5 }, data: { travelled: 50 } });
  mixed.results.push({ skill: 'gather', args: {}, status: 'succeeded', summary: '采了 6 块地狱岩', at: Date.now(), durationMs: 50,
    pos: { x: 0.5, y: 64, z: -50.5 }, data: { dug: 6, was: 'netherrack' } });
  const mixedRecord = recordOf(mixed, 'done', '采了地狱岩但没找到砖', exploreState([{ name: 'netherrack', count: 6 }]));
  assert.equal(mixedRecord.resource?.goalIncomplete, true);
  assert.deepEqual(mixedRecord.resource?.unmet, ['nether_bricks']);
  const k2 = self.learn('没看到下界砖就不算找到', { source: 'reflection', kind: 'explore' })!;
  self.record({ ...mixedRecord, applying: k2.id, applyingText: k2.text });
  assert.equal(k2.wins, 0, '采到副产物不能给寻找策略记胜');
  assert.equal(k2.counterexamples?.length, 1);
});

test('反向混合：看见寻找目标但没取得采集目标，不算寻找失败', () => {
  const self = new SelfModel(null);
  const k = self.learn('沿北向找到下界砖', { source: 'reflection', kind: 'explore' })!;
  const a = createActivity({
    what: '找到下界砖后采点铁', why: '', kind: 'explore', repeat: 1,
    steps: [
      { skill: 'explore_toward', args: { direction: 'N', distance: 96, until: 'nether_bricks' } },
      { skill: 'gather', args: { block: 'iron_ore', count: 3 } },
    ],
  }, '', 'llm', exploreState());
  a.results.push({ skill: 'explore_toward', args: {}, status: 'succeeded', summary: '看见下界砖', at: Date.now(), durationMs: 100,
    pos: { x: 0.5, y: 64, z: -50.5 }, data: { travelled: 50, found: 'nether_bricks' } });
  a.results.push({ skill: 'gather', args: {}, status: 'failed', failureCode: 'NOT_FOUND', summary: '没找到铁矿', at: Date.now(), durationMs: 20,
    pos: { x: 0.5, y: 64, z: -50.5 } });
  const record = recordOf(a, 'done', '看见下界砖，但没采到铁', exploreState());
  assert.equal(record.resource?.mode, 'mixed');
  assert.equal(record.resource?.located, true);
  assert.deepEqual(record.resource?.unmetSearch, undefined, '寻找目标已完成');
  assert.deepEqual(record.resource?.unmetAcquire, ['iron_ore']);
  assert.equal(record.resource?.goalIncomplete, true);
  self.record({ ...record, applying: k.id, applyingText: k.text });
  assert.equal(k.wins, 1, '寻找目标已找到，不能因取得缺口判寻找失败');
  assert.equal(k.counterexamples?.length ?? 0, 0, '不应写 TARGET_NOT_FOUND');
});
