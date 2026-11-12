import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventBus } from '../src/events.ts';
import { KNOW_HOW_LESSON_KEY_PREFIX, WorldMemory } from '../src/memory/store.ts';
import { buildMindMessages, buildReflectionMessages } from '../src/mind/prompt.ts';
import { RECALL_LABEL, recallLocal } from '../src/mind/recall.ts';
import { SelfModel } from '../src/mind/self.ts';
import { Thinker } from '../src/mind/thinker.ts';
import type { KnowledgeBase } from '../src/knowledge/library.ts';
import type { Planner } from '../src/planner/planner.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import type { ActivityRecord } from '../src/mind/types.ts';
import { FakeAdapter } from './fake-adapter.ts';

const record = (patch: Partial<ActivityRecord> & Pick<ActivityRecord, 'id' | 'outcome' | 'summary'>): ActivityRecord => ({
  what: '在矿道里找路', kind: 'explore', durationSec: 30, gained: {}, lost: {}, at: Date.now(), signature: 'travel_to', failures: 0, ...patch,
});

test('显式应用只把反馈记到对应窍门，不把同签名的其他动作算进来', () => {
  const self = new SelfModel(null);
  const applied = self.learn('卡在矿道里时先朝开阔方向开巷', { source: 'reflection' })!;
  const other = self.learn('天黑先回屋', { source: 'reflection', signature: 'travel_to' })!;
  self.record(record({ id: 'a1', applying: applied.id, applyingText: applied.text, outcome: 'stuck', signature: 'travel_to', summary: '开巷时下一级支撑是空的' }));
  assert.equal(applied.losses, 1);
  assert.equal(other.losses, 0, '显式应用时不能靠相同签名把结果算给别的经验');
  assert.equal(applied.applications?.length, 1);
  assert.equal(applied.unverified, true, '程序记录应用反馈，但不自动把未验证结论改成已验证');

  self.record(record({ id: 'a2', applying: applied.id, applyingText: applied.text, outcome: 'done', signature: 'travel_to', summary: '这次开巷走通了' }));
  assert.equal(applied.wins, 1);
  assert.equal(applied.applications?.length, 2);
  assert.equal(applied.unverified, true);
  assert.equal(other.wins, 0);
});

test('语义改写清空旧应用证据，旧结论的成功次数不能继承', () => {
  const self = new SelfModel(null);
  const old = self.learn('卡住时就自己开巷', { source: 'reflection', signature: 'dig', outcome: 'done' })!;
  self.record(record({ id: 'a1', applying: old.id, applyingText: old.text, outcome: 'done', summary: '开巷走通了' }));
  assert.equal(old.wins, 2, '建立时的一次成功 + 这次明确应用');
  assert.equal(old.applications?.length, 1);

  const revised = self.learn('卡住时先确认支撑完整，再朝开阔方向开巷', { source: 'reflection', revise: old.id, signature: 'dig' })!;
  assert.equal(revised.signature, undefined);
  assert.equal(revised.wins, 0);
  assert.equal(revised.applications, undefined);
  assert.equal(revised.unverified, true);
});

test('旧的无签名未验证窍门仍可召回，但排在有应用证据的条目之后', () => {
  const self = new SelfModel(null);
  const stale = self.learn('卡住时自己开巷', { source: 'reflection', kind: 'explore', tags: ['stuck'] })!;
  const evidenced = self.learn('卡住时先看清支撑再开巷', { source: 'reflection', kind: 'explore', tags: ['stuck'] })!;
  self.record(record({ id: 'a1', what: '按窍门开巷', applying: evidenced.id, applyingText: evidenced.text, outcome: 'done', summary: '看清支撑后走通' }));
  const picked = self.relevantKnowHow('卡住 开巷 stuck', 'explore', 2);
  assert.equal(picked[0]?.id, evidenced.id);
  assert.ok(picked.some((k) => k.id === stale.id), '仍可因高度相关被想起，不自动删除');
});

test('失败、条件收工和中止应用不会仅因新增记录或更新时间提高窍门排序', () => {
  for (const feedback of [
    { outcome: 'stuck' },
    { outcome: 'done', completion: 'condition' },
    { outcome: 'interrupted' },
    { outcome: 'abandoned' },
  ] as const) {
    const self = new SelfModel(null);
    const neutral = self.learn('follow northern passage', { source: 'reflection', kind: 'explore' })!;
    const applied = self.learn('follow southern passage', { source: 'reflection', kind: 'explore' })!;
    const old = Date.now() - 60 * 60_000;
    neutral.createdAt = neutral.updatedAt = old;
    applied.createdAt = applied.updatedAt = old;
    const picked = () => self.relevantKnowHow('follow passage', 'explore', 2);
    assert.deepEqual(picked().map((k) => k.id), [neutral.id, applied.id], '起初相关性和证据相同');
    Array.from({ length: feedback.outcome === 'stuck' ? 5 : 1 }).forEach((_, index) => self.record(record({
      id: `recent-application-${index}`, applying: applied.id, applyingText: applied.text,
      summary: '应用后没有确认目标完成', ...feedback,
    })));
    assert.equal(picked()[0]?.id, neutral.id, `${feedback.outcome} 不应把未验证结论提升到中性条目前`);
    assert.ok(picked().some((k) => k.id === applied.id), '失败条目仍可因相关性召回供反思');
    assert.equal(applied.unverified, true);
    assert.equal(applied.wins, 0, '条件收工不记成功');
    assert.equal(applied.createdAt, old, '保留结论原始时间');
    assert.ok(applied.updatedAt > old, '仍如实记录应用更新时间，检索不拿它当支持证据');
    assert.equal(applied.applications?.[0]?.outcome, feedback.outcome);
  }
});

test('非成功反馈不能靠更新时间提升已有签名的窍门；真实成功仍提高同等相关条目的排序', () => {
  const self = new SelfModel(null);
  const neutral = self.learn('follow northern passage', { source: 'reflection', kind: 'explore', signature: 'navigate_to' })!;
  const applied = self.learn('follow southern passage', { source: 'reflection', kind: 'explore', signature: 'travel_to' })!;
  const old = Date.now() - 60 * 60_000;
  neutral.createdAt = neutral.updatedAt = old;
  applied.createdAt = applied.updatedAt = old;
  // 签名兼容记录没有显式应用列表，失败更新也不能换成“最近可用”的优先权。
  self.record(record({ id: 'condition-only', outcome: 'done', completion: 'condition', summary: '仅收工条件成立' }));
  assert.equal(self.relevantKnowHow('follow passage', 'explore', 2)[0]?.id, neutral.id);
  assert.equal(applied.wins, 0);
  assert.equal(applied.applications, undefined);
  self.record(record({ id: 'actual-success', outcome: 'done', summary: '实际完成移动目标' }));
  assert.equal(applied.wins, 1, '保持旧签名反馈关联');
  assert.equal(neutral.wins, 0);
  assert.equal(self.relevantKnowHow('follow passage', 'explore', 2)[0]?.id, applied.id, '相同相关性下成功反馈仍提高排序');
  assert.equal(applied.unverified, true, '一次应用不自动判定规则已验证');
});

test('反思输入保留来源、未验证、应用证据和失败动作的真实参数', () => {
  const memory = new WorldMemory(null), self = new SelfModel(null);
  const k = self.learn('在矿道里卡住时先朝上坡方向开巷', { source: 'reflection', kind: 'explore' })!;
  self.record(record({
    id: 'a1', applying: k.id, applyingText: k.text, outcome: 'stuck', failures: 1,
    summary: '按这条窍门开巷，但下一级支撑是空的',
    failure: { skill: 'travel_to', args: { to: { heading: 'W', distance: 96 }, allowDig: false, allowPlace: false }, code: 'PATH_NOT_FOUND', summary: '没授权挖时找不到路线', at: Date.now() - 5000, worldId: 'w', dim: 'overworld', pos: { x: 3, y: 40, z: -2 } },
  }));
  const payload = JSON.parse(buildReflectionMessages(self, 'P', [], [], memory)[1].content.split('\n')[0]);
  const entry = payload.know_how.find((x: { id: string }) => x.id === k.id);
  assert.equal(entry.source, 'reflection');
  assert.equal(entry.unverified, true);
  assert.equal(entry.kind, 'explore');
  assert.equal(entry.applications.length, 1);
  assert.equal(entry.applications[0].outcome, 'stuck');
  assert.equal(entry.applications[0].activity_id, 'a1');
  assert.equal(entry.applications[0].failure.args.allowDig, false);
  assert.equal(entry.applications[0].failure.code, 'PATH_NOT_FOUND');
  assert.deepEqual(entry.applications[0].failure.pos, { x: 3, y: 40, z: -2 });
  assert.equal(entry.applications[0].failure.world_id, 'w');
  assert.equal(entry.applications[0].failure.dim, 'overworld');

  const recent = payload.recent.at(-1);
  assert.equal(recent.applying, k.id);
  assert.equal(recent.failed_action.args.allowDig, false);
  assert.equal(recent.failed_action.code, 'PATH_NOT_FOUND');
  assert.deepEqual(recent.failed_action.pos, { x: 3, y: 40, z: -2 });
  memory.close();
});

test('应用证据在 recent 窗口淘汰后仍保留授权、位置、时间和作用域', () => {
  const memory = new WorldMemory(null), self = new SelfModel(null);
  const k = self.learn('在矿道里卡住时先朝上坡方向开巷', { source: 'reflection' })!;
  const failedAt = Date.now() - 60_000;
  self.record(record({
    id: 'applied', applying: k.id, applyingText: k.text, outcome: 'stuck', failures: 1, summary: '应用这条窍门时卡住了',
    failure: { skill: 'travel_to', args: { to: { heading: 'W', distance: 96 }, allowDig: false, allowPlace: false }, code: 'PATH_NOT_FOUND', summary: '没有授权挖/放时找不到路线',
      at: failedAt, worldId: 'w', dim: 'the_nether', pos: { x: -2, y: 52, z: 7 } },
  }));
  for (let i = 0; i < 21; i++) self.record(record({ id: `later-${i}`, what: `后来的活动 ${i}`, outcome: 'done', summary: '无关活动' }));
  const payload = JSON.parse(buildReflectionMessages(self, 'P', [], [], memory)[1].content.split('\n')[0]);
  assert.ok(!payload.recent.some((r: { applying?: string }) => r.applying === k.id), '原活动已不在 recent 窗口');
  const entry = payload.know_how.find((x: { id: string }) => x.id === k.id);
  const application = entry.applications[0];
  assert.equal(application.activity_id, 'applied');
  assert.equal(application.failure.at, new Date(failedAt).toISOString(), '动作失败时间不是活动结束时间');
  assert.equal(application.failure.args.allowDig, false);
  assert.equal(application.failure.args.allowPlace, false);
  assert.equal(application.failure.dim, 'the_nether');
  assert.equal(application.failure.world_id, 'w');
  assert.deepEqual(application.failure.pos, { x: -2, y: 52, z: 7 });
  memory.close();
});

test('活动期间同一 id 被改写后，旧活动不能给新结论记应用或成功', () => {
  const self = new SelfModel(null);
  const rule = self.learn('卡住时向上开巷', { source: 'reflection' })!;
  const startedText = rule.text;
  const other = self.learn('另一个做法', { source: 'reflection', signature: 'dig' })!;
  self.learn('卡住时向下开巷', { source: 'reflection', revise: rule.id });
  self.record(record({ id: 'old-activity', applying: rule.id, applyingText: startedText, signature: 'dig', outcome: 'done', summary: '按开工时的说法做成了' }));
  assert.equal(rule.wins, 0, '新结论不能继承旧活动的成功');
  assert.equal(rule.applications, undefined, '旧活动的应用证据不能记到改写过的新结论');
  assert.equal(other.wins, 0, '显式 id 失效时不能退回签名误记给别的条目');
});

test('显式 id 被删除或缺少开工快照时不冒认给签名相同的其他条目', () => {
  const self = new SelfModel(null);
  const rule = self.learn('卡住时向上开巷', { source: 'reflection' })!;
  const other = self.learn('另一个做法', { source: 'reflection', signature: 'dig' })!;
  self.data.knowHow = self.data.knowHow.filter((k) => k.id !== rule.id);
  self.record(record({ id: 'deleted', applying: rule.id, applyingText: rule.text, signature: 'dig', outcome: 'done', summary: '旧活动完成' }));
  assert.equal(other.wins, 0, '删除后的显式 id 不能退回签名');
  self.record(record({ id: 'no-snapshot', applying: other.id, signature: 'dig', outcome: 'done', summary: '旧记录缺少开工快照' }));
  assert.equal(other.wins, 0, '缺少开工快照的旧数据不能冒认');
  assert.equal(other.applications, undefined);

  const mergedA = self.learn('卡住时向上开巷', { source: 'reflection', signature: 'dig' })!;
  const mergedB = self.learn('天黑先回屋', { source: 'reflection', signature: 'dig' })!;
  const mergedText = mergedB.text;
  self.consolidate({ merge: [{ ids: [mergedA.id, mergedB.id], text: '合并后的新结论' }], rewrite: [], drop: [], add: [], agendaDrop: [] });
  self.record(record({ id: 'merged-away', applying: mergedB.id, applyingText: mergedText, signature: 'dig', outcome: 'done', summary: '合并后旧活动完成' }));
  assert.equal(mergedA.wins, 0, '合并删除的旧 id 不能回退签名记给保留条目');
  assert.equal(mergedA.applications, undefined);
});

test('同文合并不会因一次应用成功把未验证结论变成已验证', () => {
  const self = new SelfModel(null);
  const rule = self.learn('卡住时先开巷', { source: 'reflection' })!;
  self.data.knowHow.push({ ...rule, id: 'k_same_text' });
  self.record(record({ id: 'applied', applying: rule.id, applyingText: rule.text, outcome: 'done', summary: '按这条窍门走通了' }));
  assert.equal(rule.wins, 1);
  self.consolidate({ merge: [{ ids: [rule.id, 'k_same_text'], text: rule.text }], rewrite: [], drop: [], add: [], agendaDrop: [] });
  assert.equal(rule.wins, 1);
  assert.equal(rule.unverified, true, '应用成功不能经合并自动变成已验证');
  assert.equal(rule.applications?.length, 1);
});

test('亲历观察被反思改写成新说法后来源变为反思，观察时间不改写成现在', () => {
  const self = new SelfModel(null);
  const observed = self.learn('河对岸有露天铁矿', { source: 'observed' })!;
  const createdAt = observed.createdAt;
  self.consolidate({ merge: [], rewrite: [{ id: observed.id, text: '河对岸有露天铁矿，过去前先确认岸边能站' }], drop: [], add: [], agendaDrop: [] });
  assert.equal(observed.source, 'reflection');
  assert.equal(observed.createdAt, createdAt, '旧观察时间不被改成新结论时间');
  assert.ok(observed.updatedAt >= createdAt);

  const observedMerge = self.learn('山顶有煤', { source: 'observed' })!;
  const mergeCreatedAt = observedMerge.createdAt;
  const guess = self.learn('山顶的煤可以烧', { source: 'reflection' })!;
  self.consolidate({ merge: [{ ids: [observedMerge.id, guess.id], text: '山顶有煤，可以烧' }], rewrite: [], drop: [], add: [], agendaDrop: [] });
  assert.equal(observedMerge.source, 'reflection');
  assert.equal(observedMerge.createdAt, mergeCreatedAt, '合并产生新结论也不改原始观察时间');

  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  self.addAgenda('河对岸有露天铁矿', 'question', 'today');
  const [, user] = buildMindMessages({ tier: 'glance', reason: '测试', percept: perception.update(), state: adapter.state(), self, memory,
    activity: null, suspended: [], lastRecord: null, noticed: [], changes: [], userSuggestion: null, audience: null, notes: [], mySkills: [], persona: '' });
  const me = JSON.parse(user.content.split('\n').find((line) => line.startsWith('【我】'))!.slice('【我】'.length));
  assert.equal(me.know_how.find((x: { id: string }) => x.id === observed.id)?.source, 'reflection', '主提示词不能把改写后的新推断标成亲历观察');
  memory.close();
});

test('回想保留窍门的来源和未验证状态；know_how 副本不再作为独立教训出现', () => {
  const memory = new WorldMemory(null), self = new SelfModel(null), adapter = new FakeAdapter();
  memory.setWorld(adapter.worldId);
  const k = self.learn('在矿道里卡住时先朝上坡方向开巷', { source: 'reflection' })!;
  memory.addLesson(k.text, { source: 'model', key: `${KNOW_HOW_LESSON_KEY_PREFIX}${k.id}` });
  memory.addLesson('河对岸有露天铁矿', { source: 'observed' });
  memory.addLesson('旧记录里的推断做法', { source: 'model' });
  const query = '在矿道里卡住时先朝上坡方向开巷 河对岸 铁矿 旧记录里的推断做法';

  const first = recallLocal(query, { self, memory }, { n: 10 });
  const own = first.find((r) => r.kind === 'know_how' && r.ref === k.id);
  assert.ok(own);
  assert.match(own.text, /未验证/);
  assert.match(own.text, /来源反思/);
  const observed = first.find((r) => r.kind === 'lesson' && /河对岸有露天铁矿/.test(r.text));
  assert.ok(observed);
  assert.match(observed.text, /^亲历观察：/);
  const inference = first.find((r) => r.kind === 'lesson' && /旧记录里的推断做法/.test(r.text));
  assert.ok(inference);
  assert.match(inference.text, /^模型推断（来源\/验证状态未记录）：/, '无 key 的旧模型教训在最终文本里保留推断来源');
  assert.doesNotMatch(inference.text, /亲历观察|已验证/);
  assert.ok(!first.some((r) => r.kind === 'lesson' && /在矿道里卡住/.test(r.text)), '主窍门的镜像副本不能换教训通道重复出现');
  const explicit = first.map((r) => `[${RECALL_LABEL[r.kind]}] ${r.text}`).join('\n');
  assert.match(explicit, /\[教训[^\]]*\] 模型推断（来源\/验证状态未记录）：旧记录里的推断做法/);

  const bus = new EventBus();
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const [, user] = buildMindMessages({ tier: 'glance', reason: '测试', percept: perception.update(), state: adapter.state(), self, memory,
    activity: null, suspended: [], lastRecord: null, noticed: [], changes: [], userSuggestion: null, audience: null, notes: [], mySkills: [], persona: '', recalled: first });
  assert.match(user.content, /\[教训[^\]]*\] 模型推断（来源\/验证状态未记录）：旧记录里的推断做法/);
  assert.match(user.content, /\[教训[^\]]*\] 亲历观察：河对岸有露天铁矿/);

  self.data.knowHow = [];
  const afterDrop = recallLocal(query, { self, memory }, { n: 10 });
  assert.ok(!afterDrop.some((r) => /在矿道里卡住/.test(r.text)), '主窍门删除后，旧副本也不能重新作为权威经验出现');
  assert.ok(afterDrop.some((r) => r.kind === 'lesson' && /河对岸有露天铁矿/.test(r.text)), '独立真实观察保留');
  memory.close();
});

test('主提示词的窍门条目保留来源、未验证和应用证据计数', () => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus(), self = new SelfModel(null);
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  self.addAgenda('在矿道里卡住时怎么办', 'question', 'today');
  const k = self.learn('在矿道里卡住时先朝上坡方向开巷', { source: 'reflection' })!;
  self.record(record({ id: 'a1', applying: k.id, applyingText: k.text, outcome: 'stuck', summary: '下一级支撑是空的' }));
  const [system, user] = buildMindMessages({ tier: 'glance', reason: '测试', percept: perception.update(), state: adapter.state(), self, memory,
    activity: null, suspended: [], lastRecord: null, noticed: [], changes: [], userSuggestion: null, audience: null, notes: [], mySkills: [], persona: '' });
  const selfLine = user.content.split('\n').find((line) => line.startsWith('【我】'))!;
  const me = JSON.parse(selfLine.slice('【我】'.length));
  const entry = me.know_how.find((x: { id: string }) => x.id === k.id);
  assert.equal(entry.source, 'reflection');
  assert.equal(entry.unverified, true);
  assert.deepEqual(entry.applications, { count: 1, done: 0, stuck: 1 });
  assert.match(me.know_how_note, /不等于自动证明结论正确/);
  assert.match(system.content, /applying/);
  memory.close();
});

test('改写或合并换了措辞：新说法从零计，旧说法的成败累计到 prior，并送到提示词与回想', () => {
  const self = new SelfModel(null);
  const rule = self.learn('同一格连卡两次就换没试过的方向', { source: 'reflection' })!;
  rule.wins = 0; rule.losses = 13;
  self.consolidate({ merge: [], rewrite: [{ id: rule.id, text: '同一格连卡两次就换方向或横移几格' }], drop: [], add: [], agendaDrop: [] });
  assert.equal(rule.losses, 0);
  assert.deepEqual({ ...rule.prior, lastText: undefined }, { wins: 0, losses: 13, revisions: 1, lastText: undefined });
  rule.losses = 2;
  const other = self.learn('卡住就换方向', { source: 'reflection' })!;
  other.wins = 1;
  self.consolidate({ merge: [{ ids: [rule.id, other.id], text: '卡住就换方向，或横移几格再回主方向' }], rewrite: [], drop: [], add: [], agendaDrop: [] });
  assert.equal(rule.wins, 0);
  assert.equal(rule.prior?.losses, 15, '两次改写累计的失败都留着');
  assert.equal(rule.prior?.wins, 1);
  assert.equal(rule.prior?.revisions, 2);
  const [, user] = buildReflectionMessages(self, 'P');
  assert.match(user.content, /"before_rewrite":\{"wins":1,"losses":15,"revisions":2/);
});

test('反思只带按当前目标/经历检索到的知识摘录，不塞整库目录', async () => {
  const memory = new WorldMemory(null), self = new SelfModel(null);
  self.addAgenda('在下界找要塞', 'goal', 'today');
  self.record(record({ id: 'r1', outcome: 'stuck', summary: '走了很久没看到要塞', what: '朝一个方向找下界要塞' }));
  const calls: unknown[] = [];
  const knowledge = {
    query(args: unknown) {
      calls.push(args);
      return { action: 'search', query: (args as { query: string }).query,
        matches: [{ id: 'blazes-and-fortresses', title: '烈焰人与下界要塞', section: 'generation', sectionTitle: '生成', excerpt: '要塞按 432×432 区域生成' }] };
    },
  } as unknown as KnowledgeBase;
  let sent: { role: string; content: string }[] = [];
  const planner = { autonomous: true, noteInvalid() {}, async complete(messages: { role: string; content: string }[]) {
    sent = messages;
    return { text: '{}', latencyMs: 1 };
  } } as unknown as Planner;
  const thinker = new Thinker(planner, new FakeAdapter(), memory, new EventBus(), null, knowledge);
  await thinker.reflect(self, 'P', new AbortController().signal);
  const query = '在下界找要塞 朝一个方向找下界要塞';
  assert.deepEqual(calls, [{ query, limit: 3 }], '检索词来自议程与最近经历，并限制返回条数');
  assert.match(sent[0].content, /按当前目标\/经历检索出的相关文档\/章节摘录，不是全库目录/, '反思规则注明知识是按相关性摘取的');
  const payload = JSON.parse(sent[1].content.split('\n')[0]);
  assert.equal(payload.knowledge.query, query);
  assert.deepEqual(payload.knowledge.matches, [{ id: 'blazes-and-fortresses', title: '烈焰人与下界要塞', section: 'generation', sectionTitle: '生成', excerpt: '要塞按 432×432 区域生成' }]);
  assert.ok(!('documents' in payload.knowledge) && !('catalog' in payload.knowledge), '只带检索结果，不带整库目录');
  memory.close();
});

test('没有检索到相关事实时反思输入不出现知识字段', () => {
  const memory = new WorldMemory(null), self = new SelfModel(null);
  const payload = JSON.parse(buildReflectionMessages(self, 'P', [], [], memory, { query: '找要塞', matches: [] })[1].content.split('\n')[0]);
  assert.equal('knowledge' in payload, false);
  memory.close();
});
