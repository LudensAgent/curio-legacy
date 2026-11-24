import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { buildMindMessages, decisionBrief, type MindContext } from '../src/mind/prompt.ts';
import { SelfModel } from '../src/mind/self.ts';
import { parseConsolidation, parseDecision } from '../src/mind/thinker.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { FakeAdapter } from './fake-adapter.ts';

function fixture(t: { after: (fn: () => void) => void }) {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), self = new SelfModel(null);
  memory.setWorld(adapter.state().worldId);
  const bus = new EventBus();
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const ctx: MindContext = { tier: 'deliberate', reason: '测试', percept: perception.update(), state: adapter.state(), self, memory,
    activity: null, suspended: [], lastRecord: null, noticed: [], changes: [], userSuggestion: null, notes: [], mySkills: [], persona: '' };
  t.after(() => { self.close(); memory.close(); });
  return { adapter, memory, self, ctx };
}

test('议程项可以带短来源；重复的同一问题保留最初来源、不再记一条', (t) => {
  const { self } = fixture(t);
  const a = self.addAgenda('给麦田找水源', 'question', 'today', { note: '连续几次耕地干回泥土' })!;
  assert.equal(a.note, '连续几次耕地干回泥土');
  const again = self.addAgenda('给麦田找水源', 'question', 'today', { note: '这次是看到耕地变回泥土' })!;
  assert.equal(again.id, a.id);
  assert.equal(again.note, '连续几次耕地干回泥土', '重复项保留最初的来源，不被后来的措辞覆盖');
  assert.equal(self.agenda().length, 1);
});

test('决策里的 agenda.add 能写入 note；旧协议不带 note 时保持为空', (t) => {
  const { adapter, memory } = fixture(t);
  const withNote = parseDecision({ decision: 'new', monologue: '先记下这个问题。', activity: { what: '观察', steps: [{ skill: 'look_around', args: { seconds: 2 } }] },
    agenda: { add: [{ text: '弄清水源怎么引', kind: 'question', horizon: 'today', note: '耕地缺水' }] } }, adapter, memory, false);
  assert.ok(!('error' in withNote));
  assert.equal(withNote.agenda?.add[0]?.note, '耕地缺水');
  const without = parseDecision({ decision: 'new', monologue: '先记下这个问题。', activity: { what: '观察', steps: [{ skill: 'look_around', args: { seconds: 2 } }] },
    agenda: { add: [{ text: '弄清水源怎么引', kind: 'question', horizon: 'today' }] } }, adapter, memory, false);
  assert.ok(!('error' in without));
  assert.equal(without.agenda?.add[0]?.note, undefined);
});

test('实验记录来源；仍在进行的旧实验不会因只显示最近几条而消失', (t) => {
  const { self, ctx } = fixture(t);
  const running = self.startExperiment('石锄能翻带草的草方块', 'act_old', '屋前翻地被草挡住');
  assert.equal(running.source, '屋前翻地被草挡住');
  for (let i = 0; i < 6; i++) {
    const e = self.startExperiment(`后来的实验 ${i}`, `act_${i}`);
    self.concludeExperiment(e.id, 'supported', '做成了');
  }
  const lines = decisionBrief(ctx);
  assert.ok(lines.some((line) => /待验证：石锄能翻带草的草方块/.test(line)), lines.join('\n'));
});

test('User Prompt 投影议程与实验的来源', (t) => {
  const { self, ctx } = fixture(t);
  self.addAgenda('弄清水源怎么引', 'question', 'today', { note: '耕地缺水' });
  self.startExperiment('石锄能翻带草的草方块', 'act_x', '屋前翻地被草挡住');
  const [, user] = buildMindMessages(ctx);
  assert.match(user.content, /"source":"耕地缺水"/);
  assert.match(user.content, /"from_activity":"屋前翻地被草挡住"/);
});

test('旧的进行中实验可以按 id 结束；解析保留 id/结论/证据', (t) => {
  const { adapter, memory, self, ctx } = fixture(t);
  const old = self.startExperiment('石锄能翻带草的草方块', 'act_old', '屋前翻地被草挡住');
  const parsed = parseDecision({ decision: 'new', monologue: '旧实验该收尾了。', activity: { what: '观察', steps: [{ skill: 'look_around', args: { seconds: 2 } }] },
    experiment_result: { id: old.id, status: 'supported', evidence: '后来用石锄翻成了' } }, adapter, memory, false);
  assert.ok(!('error' in parsed));
  assert.deepEqual(parsed.experimentSettlement, { id: old.id, status: 'supported', evidence: '后来用石锄翻成了' });
  self.concludeExperiment(parsed.experimentSettlement!.id, parsed.experimentSettlement!.status, parsed.experimentSettlement!.evidence);
  assert.equal(self.experiment(old.id)?.status, 'supported');
  assert.equal(decisionBrief(ctx).some((line) => /待验证/.test(line)), false);
});

test('回想整理也能带来源；note 超长在存储边界截断', (t) => {
  const { self } = fixture(t);
  const parsed = parseConsolidation({ agenda_add: [{ text: '弄清水源怎么引', kind: 'idea', note: '连续几次耕地缺水' }] }, new Set(), new Set());
  assert.equal(parsed.agendaAdd?.[0]?.note, '连续几次耕地缺水');
  const long = 'x'.repeat(120);
  const item = self.addAgenda('一个很长来源的问题', 'question', 'today', { note: long })!;
  assert.equal(item.note?.length, 80);
});
