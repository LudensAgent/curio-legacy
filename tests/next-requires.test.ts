import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BlockObservation } from '../src/adapter/types.ts';
import type { Condition } from '../src/projects/types.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Mind } from '../src/mind/mind.ts';
import { parseDecision } from '../src/mind/thinker.ts';
import type { NextDraft } from '../src/mind/types.ts';
import { FakeAdapter } from './fake-adapter.ts';

type PerceptionStub = { snapshot(): unknown; observeBlocks?(positions: { x: number; y: number; z: number }[]): BlockObservation[] };

/** 只用 act() 消费 next 这截所需的结构；不与 Mind 的私有成员取交集。 */
type Harness = {
  activity: Mind['activity'];
  queuedNext: Mind['queuedNext'];
  decisionEpoch: number;
  pendingReason?: { reason: string };
};

function harness(adapter: FakeAdapter, perception: PerceptionStub = { snapshot: () => undefined }) {
  const bus = new EventBus();
  const started: string[] = [];
  let idle = 0;
  const mind = Object.create(Mind.prototype) as Harness;
  Object.assign(mind, {
    activity: null,
    queuedNext: null,
    decisionEpoch: 1,
    pendingReason: undefined,
    d: { adapter, bus, arbiter: { info: () => null }, perception },
    beginActivity: (draft: { what: string }) => { started.push(draft.what); },
    idle: () => { idle++; },
  });
  return { mind, bus, started, idle: () => idle };
}

function queueDraft(mind: Harness, adapter: FakeAdapter, draft: NextDraft, scope?: { worldId: string; dim: string; sessionId: string }) {
  const s = adapter.state();
  mind.queuedNext = {
    draft, monologue: '', at: Date.now(), epoch: mind.decisionEpoch,
    scope: scope ?? { worldId: s.worldId, dim: s.dim, sessionId: s.sessionId },
  };
}

function queueNext(mind: Harness, adapter: FakeAdapter, requires?: Condition, scope?: { worldId: string; dim: string; sessionId: string }) {
  queueDraft(mind, adapter, {
    what: '挖铁', why: '', kind: 'gather', repeat: 1, steps: [{ skill: 'look_around', args: { seconds: 2 } }],
    ...(requires !== undefined ? { requires } : {}),
  }, scope);
}

const act = (mind: Harness) => (Mind.prototype as unknown as { act(this: Harness): void }).act.call(mind);

const nextOf = (requires?: unknown) => ({
  what: '挖铁', steps: [{ skill: 'look_around', args: { seconds: 2 } }],
  ...(requires !== undefined ? { requires } : {}),
});

test('next.requires 在解析边界校验一次；null 是无效值，不能当成没写', () => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null);
  try {
    const bad = parseDecision({ decision: 'continue', next: nextOf({ type: 'inventory_min', item: 'raw_iron', count: 0 }) }, adapter, memory, true, '寻找铁矿', ['explore']);
    assert.ok('error' in bad);
    assert.match(bad.error, /next\.requires 无效/);
    assert.match(bad.error, /删掉 requires/);

    const nulled = parseDecision({ decision: 'continue', next: nextOf(null) }, adapter, memory, true, '寻找铁矿', ['explore']);
    assert.ok('error' in nulled, 'requires:null 必须校验失败，不能静默变成无守卫 next');
    assert.match(nulled.error, /next\.requires 无效/);

    const idleNull = parseDecision({ decision: 'continue', next: nextOf(null) }, adapter, memory, false);
    assert.ok('error' in idleNull, '手上没活时 requires:null 也不能提升成无守卫新活动');
    assert.match(idleNull.error, /next\.requires 无效/);

    const good = parseDecision({ decision: 'continue', next: nextOf({ type: 'inventory_min', item: 'raw_iron', count: 3 }) }, adapter, memory, true, '寻找铁矿', ['explore']);
    assert.ok(!('error' in good));
    assert.deepEqual(good.next?.requires, { type: 'inventory_min', item: 'raw_iron', count: 3 });
    // 只读的 next 步骤不会因为 requires 需要物品而被 doneWhenGap 拒绝：下一段可以先去准备。
    assert.equal(good.next?.what, '挖铁');
  } finally { memory.close(); }
});

test('activity.requires 被明确拒绝，指示改用 next.requires', () => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null);
  try {
    const misplaced = parseDecision({ decision: 'new', activity: {
      what: '挖铁', steps: [{ skill: 'look_around', args: { seconds: 2 } }],
      requires: { type: 'inventory_min', item: 'raw_iron', count: 3 },
    } }, adapter, memory, false);
    assert.ok('error' in misplaced);
    assert.match(misplaced.error, /activity\.requires/);
    assert.match(misplaced.error, /next\.requires/);
  } finally { memory.close(); }
});

test('next.requires 拒绝任何嵌套的 exploration（依赖上一段活动回执）', () => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null);
  try {
    const rejected = parseDecision({ decision: 'continue', next: nextOf({
      type: 'all_of',
      conditions: [{ type: 'exploration', min_distance: 4 }, { type: 'inventory_min', item: 'raw_iron', count: 3 }],
    }) }, adapter, memory, true, '寻找铁矿', ['explore']);
    assert.ok('error' in rejected);
    assert.match(rejected.error, /exploration/);
    assert.match(rejected.error, /当前状态条件/);
  } finally { memory.close(); }
});

test('idle continue 的 guarded next 真实解析后只排队；未满足不启动，满足后由 act 消费一次', () => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null);
  try {
    const parsed = parseDecision({ decision: 'continue', next: nextOf({ type: 'inventory_min', item: 'raw_iron', count: 3 }) }, adapter, memory, false);
    assert.ok(!('error' in parsed));
    assert.equal(parsed.kind, 'continue');
    assert.equal(parsed.activity, undefined, '不能把带守卫的 next 提升成当前活动');
    assert.equal(parsed.next?.requires?.type, 'inventory_min');
    const draft = parsed.next;
    assert.ok(draft);

    const { mind, started } = harness(adapter);
    adapter.inv.set('raw_iron', 2);
    queueDraft(mind, adapter, draft);
    act(mind);
    assert.deepEqual(started, [], '铁不足时 guarded next 不启动');
    assert.equal(mind.queuedNext, null);
    assert.match(mind.pendingReason?.reason ?? '', /没有启动/);

    adapter.inv.set('raw_iron', 3);
    queueDraft(mind, adapter, draft);
    act(mind);
    assert.deepEqual(started, ['挖铁'], '同一份解析结果在条件满足后由同一个消费路径启动');
    assert.equal(mind.queuedNext, null);
  } finally { memory.close(); }
});

test('不带 requires 的 idle continue+next 仍按旧行为提升为新活动', () => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null);
  try {
    const plain = parseDecision({ decision: 'continue', next: nextOf() }, adapter, memory, false);
    assert.ok(!('error' in plain));
    assert.equal(plain.kind, 'new');
    assert.equal(plain.activity?.what, '挖铁');
    assert.equal(plain.next, undefined);
  } finally { memory.close(); }
});

test('前置条件满足时下一段只启动一次；没有 requires 的 next 仍然无条件接上', () => {
  const adapter = new FakeAdapter();
  const first = harness(adapter);
  adapter.inv.set('raw_iron', 3);
  queueNext(first.mind, adapter, { type: 'inventory_min', item: 'raw_iron', count: 3 });
  act(first.mind);
  assert.deepEqual(first.started, ['挖铁']);
  assert.equal(first.mind.queuedNext, null);
  act(first.mind);
  assert.deepEqual(first.started, ['挖铁'], '同一段预排不会启动第二次');

  const second = harness(adapter);
  queueNext(second.mind, adapter);
  act(second.mind);
  assert.deepEqual(second.started, ['挖铁'], '不写 requires 时保持原来的无条件接上');
});

test('前置条件不足或未知时不启动，清掉预排并把条件与实际值交回模型', () => {
  const adapter = new FakeAdapter();
  const short = harness(adapter);
  adapter.inv.set('raw_iron', 2);
  queueNext(short.mind, adapter, { type: 'inventory_min', item: 'raw_iron', count: 3 });
  act(short.mind);
  assert.deepEqual(short.started, []);
  assert.equal(short.mind.queuedNext, null);
  assert.match(short.mind.pendingReason?.reason ?? '', /没有启动/);
  assert.match(short.mind.pendingReason?.reason ?? '', /inventory_min/);
  assert.match(short.mind.pendingReason?.reason ?? '', /"count":2/);

  const unknown = harness(adapter);
  queueNext(unknown.mind, adapter, { type: 'sky_visible', equals: true });
  act(unknown.mind);
  assert.deepEqual(unknown.started, []);
  assert.match(unknown.mind.pendingReason?.reason ?? '', /状态 unknown/);
});

test('当前可见的 block_state 前置条件由 observeCondition 取到实测观测，不再永久 unknown', () => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null);
  try {
    const condition = { type: 'block_state', dimension: adapter.dim, pos: { x: 1, y: 64, z: 0 }, name: 'stone' } as const;
    const parsed = parseDecision({ decision: 'continue', next: nextOf(condition) }, adapter, memory, true, '寻找铁矿', ['explore']);
    assert.ok(!('error' in parsed));
    const draft = parsed.next;
    assert.ok(draft);
    const observation: BlockObservation = {
      pos: { x: 1, y: 64, z: 0 }, name: 'stone', properties: {}, worldId: adapter.worldId,
      sessionId: adapter.sessionId, dimension: adapter.dim, observationId: 1_000_000, observedAt: Date.now(), source: 'vision',
    };
    const { mind, started } = harness(adapter, { snapshot: () => undefined, observeBlocks: () => [observation] });
    queueDraft(mind, adapter, draft);
    act(mind);
    assert.deepEqual(started, ['挖铁'], '有当前可见观测时 block_state 条件可以满足');
  } finally { memory.close(); }
});

test('排队后背包变化会在启动前重新验收', () => {
  const adapter = new FakeAdapter();
  const { mind, started } = harness(adapter);
  adapter.inv.set('raw_iron', 2);
  queueNext(mind, adapter, { type: 'inventory_min', item: 'raw_iron', count: 3 });
  act(mind);
  assert.deepEqual(started, []);
  adapter.inv.set('raw_iron', 3);
  queueNext(mind, adapter, { type: 'inventory_min', item: 'raw_iron', count: 3 });
  act(mind);
  assert.deepEqual(started, ['挖铁']);
});

test('旧世界/维度/会话排的 next：作用域检查先作废，不因 requires 满足而绕过', () => {
  const adapter = new FakeAdapter();
  const { mind, started } = harness(adapter);
  adapter.inv.set('raw_iron', 3);
  queueNext(mind, adapter, { type: 'inventory_min', item: 'raw_iron', count: 3 },
    { worldId: 'old-world', dim: 'the_nether', sessionId: 'old-session' });
  act(mind);
  assert.deepEqual(started, []);
  assert.equal(mind.queuedNext, null);
  assert.match(mind.pendingReason?.reason ?? '', /旧作用域|换地方/);
});

test('上一段因 any_of 的位置分支收工、铁仍不足时，带铁前置的 next 不启动', () => {
  const adapter = new FakeAdapter();
  const { mind, started } = harness(adapter);
  // 身体就在 any_of 里 location_near 那一点，但 next 自己显式要求 raw_iron×12；两者不能互相替代。
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.inv.set('raw_iron', 2);
  queueNext(mind, adapter, { type: 'inventory_min', item: 'raw_iron', count: 12 });
  act(mind);
  assert.deepEqual(started, []);
  assert.equal(mind.queuedNext, null);
  assert.match(mind.pendingReason?.reason ?? '', /前置条件.*raw_iron.*12/);
});
