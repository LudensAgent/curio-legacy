import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory, type PassageRecord } from '../src/memory/store.ts';
import type { MindContext } from '../src/mind/prompt.ts';
import { SelfModel } from '../src/mind/self.ts';
import { Thinker } from '../src/mind/thinker.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import type { ChatMessage } from '../src/planner/llm.ts';
import { Planner } from '../src/planner/planner.ts';
import { FakeAdapter } from './fake-adapter.ts';

const decision = { decision: 'new', activity: { what: '观察身边', steps: [{ skill: 'look_around', args: { seconds: 1 } }] } };

function passage(overrides: Partial<PassageRecord> = {}): PassageRecord {
  return { id: 'shaft', worldId: 'fake-world', dim: 'overworld', entrances: [{ x: 0, y: 64, z: 0 }],
    path: [{ x: 0, y: 64, z: 0 }, { x: 0, y: 57, z: 0 }, { x: 0, y: 50, z: 0 }],
    deepestY: 50, dug: 14, ores: { iron_ore: 2 }, createdAt: 1000, lastUsedAt: 5000, uses: 1, ...overrides };
}

function fixture(t: TestContext, replies: object[], records: PassageRecord[] = [passage()], tier: MindContext['tier'] = 'deliberate') {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus(), self = new SelfModel(null);
  memory.setWorld(adapter.worldId);
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const percept = perception.update();
  records.forEach((record) => memory.savePassage(record));
  const calls: ChatMessage[][] = [];
  const cfg = { ...config, llm: { ...config.llm, provider: 'openai' as const, maxCallsPerHour: 1000, maxPromptTokens: 60000 } };
  const planner = new Planner(cfg, { name: 'passage-query-test', complete: async (messages) => {
    calls.push(structuredClone(messages));
    const reply = replies[calls.length - 1];
    assert.ok(reply, 'unexpected additional model call');
    return { text: JSON.stringify(reply), latencyMs: 1 };
  } }, adapter, memory, bus, null);
  const thinker = new Thinker(planner, adapter, memory, bus);
  const ctx: MindContext = { tier, reason: '查看挖过的通道', percept, state: adapter.state(), self, memory,
    activity: null, suspended: [], lastRecord: null, noticed: [], changes: [], userSuggestion: null, audience: null, notes: [], mySkills: [], persona: '你是 Curio。' };
  t.after(() => memory.close());
  return { adapter, memory, self, calls, planner, ctx, think: () => thinker.think(ctx, new AbortController().signal) };
}

function queryResult(calls: ChatMessage[][], index: number): Record<string, unknown> {
  const content = calls[index].at(-1)!.content;
  const prefix = '查询结果（只读，不是现场事实）：';
  assert.ok(content.startsWith(prefix));
  return JSON.parse(content.slice(prefix.length, content.lastIndexOf('\n剩余查询'))) as Record<string, unknown>;
}

test('passages lists only this world and dimension, sorts by nearest historical point and has no execution or memory side effects', async (t) => {
  const nearby = passage({ id: 'nearby', entrances: [{ x: 100, y: 64, z: 0 }], path: [{ x: 100, y: 64, z: 0 }, { x: 1, y: 64, z: 0 }] });
  const farther = passage({ id: 'farther', entrances: [{ x: 0, y: 64, z: 0 }], path: [{ x: 10, y: 64, z: 0 }] });
  const w = fixture(t, [{ kind: 'passages' }, { kind: 'passages', id: 'other-world' }, { kind: 'passages', id: 'other-dimension' }, decision],
    [farther, passage({ id: 'other-world', worldId: 'elsewhere' }), passage({ id: 'other-dimension', dim: 'the_nether' }), nearby]);
  const before = structuredClone({ passages: w.memory.passages(), personal: w.self.data, pos: w.adapter.pos });
  const save = t.mock.method(w.memory, 'savePassage'), forget = t.mock.method(w.memory, 'forgetPassage'), world = t.mock.method(w.memory, 'setWorld');
  const result = await w.think();
  assert.equal(result.activity?.steps[0].skill, 'look_around');
  const listed = queryResult(w.calls, 1);
  assert.equal(listed.action, 'list');
  assert.equal(listed.worldId, w.adapter.worldId);
  assert.equal(listed.dim, w.adapter.dim);
  assert.equal(listed.historical, true);
  assert.equal(listed.connectivity, 'unknown');
  const records = listed.records as Array<Record<string, unknown>>;
  assert.deepEqual(records.map((record) => record.id), ['nearby', 'farther'], 'sort by path proximity, not surface reference');
  assert.deepEqual(records[0], { id: nearby.id, kind: 'dug', surfaceReferences: nearby.entrances, deepestY: nearby.deepestY,
    createdAt: nearby.createdAt, lastUsedAt: nearby.lastUsedAt, dug: nearby.dug, ores: nearby.ores, pointCount: 2, nearestPointIndex: 1, distance: 1 });
  assert.equal(queryResult(w.calls, 2).error, '当前世界和维度没有这个矿道记录');
  assert.equal(queryResult(w.calls, 3).error, '当前世界和维度没有这个矿道记录');
  assert.deepEqual({ passages: w.memory.passages(), personal: w.self.data, pos: w.adapter.pos }, before);
  assert.deepEqual([save.mock.calls.length, forget.mock.calls.length, world.mock.calls.length], [0, 0, 0]);
  assert.deepEqual(w.adapter.actions, []);
});

test('passages lists archived records with an archive marker and reads their stored path', async (t) => {
  const old = passage({ id: 'old', path: [{ x: 4, y: 50, z: 0 }, { x: 5, y: 50, z: 0 }], deepestY: 50 });
  const w = fixture(t, [{ kind: 'passages' }, { kind: 'passages', id: 'old' }, decision]);
  w.memory.archivePassage(old);
  await w.think();
  const listed = queryResult(w.calls, 1);
  const records = listed.records as Array<Record<string, unknown>>;
  assert.equal(records.find((record) => record.id === 'old')?.archived, true);
  assert.equal(records.find((record) => record.id === 'shaft')?.archived, undefined, 'live records keep the existing shape');
  const read = queryResult(w.calls, 2);
  assert.equal(read.id, 'old');
  assert.equal(read.archived, true);
  assert.deepEqual(read.path, old.path);
  assert.deepEqual(w.memory.passages(), [passage()], 'read-only query leaves live memory unchanged');
});

test('passages reads every original point across pages, with record timestamps and a global nearest point index', async (t) => {
  const path = Array.from({ length: 70 }, (_, index) => ({ x: 69 - index, y: 64, z: index % 3 }));
  const record = passage({ path });
  const w = fixture(t, [{ kind: 'passages', id: ' shaft ' }, { kind: 'passages', id: 'shaft', offset: 32 },
    { kind: 'passages', id: 'shaft', offset: 64 }, decision], [record]);
  await w.think();
  const pages = [1, 2, 3].map((index) => queryResult(w.calls, index));
  assert.deepEqual(pages.map((page) => (page.path as PassageRecord['path']).length), [32, 32, 6]);
  assert.deepEqual(pages.map((page) => page.offset), [0, 32, 64]);
  assert.deepEqual(pages.map((page) => page.nextOffset), [32, 64, null]);
  assert.deepEqual(pages.flatMap((page) => page.path as PassageRecord['path']), path);
  for (const page of pages) {
    assert.equal(page.action, 'read');
    assert.equal(page.id, 'shaft');
    assert.equal(page.total, 70);
    assert.equal(page.pointCount, 70);
    assert.equal(page.nearestPointIndex, 69);
    assert.equal(page.createdAt, record.createdAt);
    assert.equal(page.lastUsedAt, record.lastUsedAt);
    assert.deepEqual(page.surfaceReferences, record.entrances);
  }
  assert.deepEqual(w.memory.passages()[0], record);
  assert.deepEqual(w.adapter.actions, []);
});

test('reading a descended shaft preserves sparse raw points and does not claim a continuous or reversible route', async (t) => {
  const record = passage();
  const w = fixture(t, [{ kind: 'passages', id: record.id }, { kind: 'passages', id: record.id, offset: 50 }, decision], [record]);
  await w.think();
  const data = queryResult(w.calls, 1);
  assert.deepEqual(data.path, record.path);
  assert.equal(data.historical, true);
  assert.equal(data.connectivity, 'unknown');
  assert.match(String(data.note), /稀疏.*去重.*合并.*不代表连续顺序或双向可走.*地表参考点.*不保证现在是入口/);
  assert.equal('route' in data, false);
  assert.equal('reversible' in data, false);
  assert.equal('steps' in data, false);
  assert.deepEqual(queryResult(w.calls, 2).path, []);
  assert.equal(queryResult(w.calls, 2).nextOffset, null);
  assert.equal(queryResult(w.calls, 2).total, record.path.length);
  assert.deepEqual(w.adapter.actions, []);
});

for (const tier of ['glance', 'deliberate'] as const) {
  test(`passages is discoverable in ${tier}, and facility summaries supply a readable ID`, async (t) => {
    const w = fixture(t, [{ kind: 'passages' }, { kind: 'passages', id: 'shaft' }, decision], [passage()], tier);
    const result = await w.think();
    assert.match(w.calls[0][0].content, /"kind":"passages"/);
    assert.match(w.calls[0][0].content, /"id":"记录ID","offset":0/);
    assert.match(w.calls[1].map((message) => message.content).join('\n'), /记录 shaft（passages 查询可读历史脚点）/);
    assert.equal(queryResult(w.calls, 2).id, 'shaft');
    assert.equal(result.tier, 'deliberate');
    assert.deepEqual(w.planner.stats.tiers, tier === 'glance' ? { light: 1, full: 2, escalated: 1 } : { light: 0, full: 3, escalated: 0 });
  });
}

test('an embedded passages query upgrades light thinking and never becomes an executable step', async (t) => {
  const w = fixture(t, [{ decision: 'new', activity: { what: '查我挖的矿道', steps: [{ skill: 'passages', args: { id: 'shaft' } }] } }, decision], [passage()], 'glance');
  const result = await w.think();
  assert.equal(result.tier, 'deliberate');
  assert.equal(result.activity?.steps[0].skill, 'look_around');
  assert.match(w.calls[1].at(-1)!.content, /passages 是思考时的查询.*"action":"read".*"id":"shaft"/);
  assert.deepEqual(w.planner.stats.tiers, { light: 1, full: 1, escalated: 1 });
  assert.deepEqual(w.adapter.actions, []);
});

test('passages rejects invalid IDs and offsets at the query boundary', async (t) => {
  const cases = [
    { args: { id: 42 }, error: /id 需要非空/ },
    { args: { id: '' }, error: /id 需要非空/ },
    { args: { id: '   ' }, error: /id 需要非空/ },
    { args: { id: null }, error: /id 需要非空/ },
    { args: { id: 'shaft', offset: '1' }, error: /offset 需要非负整数/ },
    { args: { id: 'shaft', offset: -1 }, error: /offset 需要非负整数/ },
    { args: { id: 'shaft', offset: 0.5 }, error: /offset 需要非负整数/ },
    { args: { id: 'shaft', offset: Number.MAX_SAFE_INTEGER + 1 }, error: /offset 需要非负整数/ },
    { args: { id: 'shaft', offset: null }, error: /offset 需要非负整数/ },
    { args: { offset: 0 }, error: /offset 需要与 id 一起/ },
  ];
  for (const { args, error } of cases) {
    const w = fixture(t, [{ kind: 'passages', ...args }, decision]);
    await w.think();
    assert.match(w.calls[1].at(-1)!.content, error);
    assert.deepEqual(w.adapter.actions, []);
  }
});
