import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { AgentState, GameAdapter, Optics } from '../src/adapter/types.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { MethodLibrary } from '../src/methods/learning.ts';
import { Vision, DEFAULT_VISION } from '../src/perception/vision.ts';
import { evaluateCondition, validateCondition } from '../src/projects/conditions.ts';
import { SKILLS } from '../src/skills/index.ts';
import { inspectBlock } from '../src/skills/observation.ts';
import { ok, type SkillCtx } from '../src/skills/types.ts';

// Fixed sight lines and synchronous state changes only; no world simulation or game connection.
function fixture(t: TestContext) {
  const state: AgentState = { connected: true, alive: true, observationReady: true, worldId: 'observations', sessionId: 's', observationId: 1,
    username: 'test', pos: { x: .5, y: 64, z: .5 }, dim: 'overworld', hp: 20, food: 20, oxygen: 20, timeOfDay: 1000, isDay: true,
    biome: null, onGround: true, inWater: false, inLava: false, inventory: [], emptySlots: 36, held: null, riding: null, equipment: [] };
  const pos = { x: 0, y: 65, z: -2 };
  let barrier = false, open = false, loaded = true, yaw = 0, reads = 0;
  let shapes: Optics['shapes'];
  const adapter = {
    state: () => ({ ...structuredClone(state), observationId: ++state.observationId }),
    isKnownItem: (name: string) => ['shield', 'iron_helmet'].includes(name),
    resolveBlockNames: (name: string) => [name],
    eye: () => ({ x: .5, y: 65.62, z: .5, yaw, pitch: 0 }),
    lightAt: () => ({ block: 15, sky: 15 }),
    blockOptics: (x: number, y: number, z: number) => {
      if (x === pos.x && y === pos.y && z === pos.z) return loaded ? { name: 'oak_door', kind: 'solid', ...(shapes ? { shapes } : {}) } : null;
      return barrier && x === 0 && y === 65 && z === -1 ? { name: 'stone', kind: 'solid' } : { name: 'air', kind: 'clear' };
    },
    blockStateAt: () => { reads++; return loaded ? { name: 'oak_door', properties: { open, half: 'lower' } } : null; },
  } as unknown as GameAdapter;
  const memory = new WorldMemory(null); memory.setWorld(state.worldId);
  const bus = new EventBus(), library = new MethodLibrary(null, adapter, memory, bus);
  const vision = new Vision(adapter, { ...DEFAULT_VISION, range: 16 });
  const ctx: SkillCtx = { adapter, memory, bus, senses: vision, signal: new AbortController().signal, deadline: Date.now() + 10000, taskId: 'observation', progress() {} };
  t.after(() => { library.dispose(); memory.close(); });
  return { state, pos, adapter, memory, library, vision, ctx, reads: () => reads,
    barrier: (v: boolean) => { barrier = v; }, open: (v: boolean) => { open = v; }, loaded: (v: boolean) => { loaded = v; }, yaw: (v: number) => { yaw = v; }, shapes: (v: Optics['shapes']) => { shapes = v; } };
}

test('block inspection reads state only after a fresh visible ray; walls, facing and unloaded targets stay unknown', async (t) => {
  const w = fixture(t), raw = { type: 'block_state', dimension: 'overworld', pos: w.pos, name: 'oak_door', properties: { open: false } };
  const state = w.adapter.state(), condition = validateCondition(raw, w.adapter, w.memory, state);
  const receipts = w.vision.observeBlocks([w.pos]);
  assert.equal(evaluateCondition(condition, state, state.worldId, receipts).status, 'satisfied');
  const reads = w.reads();
  w.barrier(true);
  assert.deepEqual(w.vision.observeBlocks([w.pos]), []);
  assert.equal(w.reads(), reads, 'an occluded coordinate must not reach blockStateAt');
  assert.equal(evaluateCondition(condition, w.adapter.state(), state.worldId, receipts).status, 'unknown', 'old receipts cannot certify a new snapshot');
  const inspected = await inspectBlock.run({ ...w.ctx, senses: { ...w.ctx.senses, refresh() {}, observeBlocks: (p) => w.vision.observeBlocks(p) } }, { target: w.pos });
  assert.equal(inspected.status, 'failed');
  w.barrier(false); w.yaw(Math.PI);
  assert.deepEqual(w.vision.observeBlocks([w.pos]), []);
  assert.equal(w.reads(), reads);
  w.yaw(0); w.loaded(false);
  assert.deepEqual(w.vision.observeBlocks([w.pos]), []);
  w.loaded(true); w.shapes([]);
  assert.deepEqual(w.vision.observeBlocks([w.pos]), [], 'a grid cell without a visible solid shape is not evidence of an opaque object');
  w.shapes([[0, 0, 0, .1875, 1, 1]]);
  assert.equal(w.vision.observeBlocks([w.pos]).length, 1, 'a real thin surface can be inspected');
});

test('self and equipment predicates read actual state; missing fields and foreign-session receipts are unknown', (t) => {
  const w = fixture(t);
  const own = validateCondition({ type: 'all_of', conditions: [
    { type: 'self_state', field: 'riding', equals: 'boat' },
    { type: 'self_state', field: 'onGround', equals: false },
    { type: 'equipment', slot: 'off-hand', item: 'shield' },
  ] }, w.adapter, w.memory, w.adapter.state());
  assert.equal(evaluateCondition(own, w.adapter.state()).status, 'unsatisfied');
  w.state.riding = 'boat'; w.state.onGround = false; w.state.equipment = [{ slot: 'off-hand', name: 'shield' }];
  assert.equal(evaluateCondition(own, w.adapter.state()).status, 'satisfied');
  delete w.state.riding;
  assert.equal(evaluateCondition(own, w.adapter.state()).status, 'unknown');
  const block = validateCondition({ type: 'block_state', dimension: 'overworld', pos: w.pos, properties: { open: false } }, w.adapter, w.memory, w.adapter.state());
  const state = w.adapter.state(), receipt = w.vision.observeBlocks([w.pos])[0];
  assert.equal(evaluateCondition(block, state, state.worldId, [{ ...receipt, sessionId: 'old' }]).status, 'unknown');
  assert.equal(evaluateCondition(block, state, state.worldId, [{ ...receipt, observedAt: Date.now() - 1001 }]).status, 'unknown');
  assert.throws(() => validateCondition({ type: 'self_state', field: 'hp', equals: 'boat' }, w.adapter, w.memory, state));
});

test('position_y validates an explicit height range and evaluates the observed position', (t) => {
  const w = fixture(t);
  const below = validateCondition({ type: 'position_y', max: 30 }, w.adapter, w.memory, w.adapter.state());
  assert.equal(evaluateCondition(below, w.adapter.state()).status, 'unsatisfied');
  w.state.pos.y = 30;
  assert.deepEqual(evaluateCondition(below, w.adapter.state()).actual, { y: 30, max: 30 });
  assert.equal(evaluateCondition(below, w.adapter.state()).status, 'satisfied');
  const band = validateCondition({ type: 'position_y', min: -10, max: 30 }, w.adapter, w.memory, w.adapter.state());
  w.state.pos.y = -11;
  assert.equal(evaluateCondition(band, w.adapter.state()).status, 'unsatisfied');
  assert.throws(() => validateCondition({ type: 'position_y' }, w.adapter, w.memory, w.adapter.state()));
  assert.throws(() => validateCondition({ type: 'position_y', min: 40, max: 30 }, w.adapter, w.memory, w.adapter.state()));
  w.state.observationReady = false;
  assert.equal(evaluateCondition(below, w.adapter.state()).status, 'unknown');
});

test('method branches and postconditions use fresh observations, and an unknown baseline cannot become learning proof', async (t) => {
  const w = fixture(t), previous = SKILLS.observation_toggle;
  SKILLS.observation_toggle = { name: 'observation_toggle', description: 'test receipt', argsDoc: '{}', timeoutMs: 1000, movement: false,
    validate: () => ({ ok: true, args: {} }), run: async () => { w.barrier(false); w.open(true); return ok('packet acknowledged'); } };
  t.after(() => { if (previous) SKILLS.observation_toggle = previous; else delete SKILLS.observation_toggle; });
  const postcondition = { type: 'block_state', dimension: 'overworld', pos: w.pos, name: 'oak_door', properties: { open: true } };
  for (const unknown of [false, true]) {
    w.open(false); w.barrier(unknown);
    const call = { type: 'call', skill: 'observation_toggle', args: {} };
    const result = await w.library.experiment({ name: unknown ? 'unknown_baseline' : 'visible_mechanism', description: '核对当前可见的机制变化',
      program: unknown ? call : { type: 'if', condition: { ...postcondition, properties: { open: false } }, then: call }, postcondition }, {}, w.ctx);
    assert.equal(result.status, 'succeeded', result.summary);
    const trial = w.library.list().find((m) => m.name === (unknown ? 'unknown_baseline' : 'visible_mechanism'))!.trials[0];
    assert.equal(trial.status, unknown ? 'uninformative' : 'verified');
    assert.equal(trial.source, 'adapter.state+vision');
    if (unknown) assert.match(trial.reason, /未知/);
  }
});
