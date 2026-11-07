import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BlockObservation } from '../src/adapter/types.ts';
import { makeBridge, visibleActionSenses } from '../src/codeskills/bridge.ts';
import { localMap } from '../src/perception/local.ts';
import { Vision } from '../src/perception/vision.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

test('delegated primitives cannot turn remembered ores into current unseen block queries', (t) => {
  const adapter = new FakeAdapter(), pos = { x: 6, y: 64, z: 0 };
  const remembered = [{ name: 'diamond_ore', pos, dist: 6 }];
  let visible = false;
  const ctx = makeCtx(adapter, { senses: {
    knownBlocks: () => remembered,
    observeBlocks: () => visible ? [{ name: 'diamond_ore', pos, properties: {}, worldId: 'w', sessionId: 's', dimension: 'overworld', observationId: 1, observedAt: Date.now(), source: 'vision' }] : [],
  } });
  t.after(() => ctx.memory.close());
  const senses = visibleActionSenses(ctx.senses);
  assert.deepEqual(senses.knownBlocks(['diamond_ore'], 32), []);
  visible = true;
  assert.deepEqual(senses.knownBlocks(['diamond_ore'], 32), remembered);
  assert.deepEqual(ctx.senses.knownBlocks(['diamond_ore'], 32), remembered, '历史记忆仍保留，当前视觉与记忆不同');
});

test('blockAt and region share visual observations; hidden names and geometry remain unknown', async (t) => {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  const visible = new Map([['0,64,6', 'iron_ore'], ['0,70,6', 'air']]);
  const batches: number[] = [];
  const ctx = makeCtx(adapter, { senses: {
    recognizedAt: () => 'diamond_ore',
    observeBlocks(positions) {
      batches.push(positions.length);
      const state = adapter.state();
      return positions.flatMap((pos): BlockObservation[] => {
        const name = visible.get(`${pos.x},${pos.y},${pos.z}`);
        return name ? [{ name, pos, properties: {}, worldId: state.worldId, sessionId: state.sessionId,
          dimension: state.dim, observationId: state.observationId, observedAt: Date.now(), source: 'vision' }] : [];
      });
    },
  } });
  t.after(() => ctx.memory.close());
  t.mock.method(adapter, 'blockAt', () => { throw new Error('Bridge must not read the raw world map'); });
  const api = makeBridge(ctx);
  assert.deepEqual(await api('blockAt', [0, 64, 6]), { name: 'iron_ore', kind: 'solid' });
  assert.deepEqual(await api('blockAt', [0, 64, 7]), { name: null, kind: 'unknown' });
  assert.deepEqual(await api('blockAt', [0, 64, 1]), { name: null, kind: 'unknown' }, 'nearby hidden cells have no touch-radius bypass');
  assert.deepEqual(await api('blockAt', [0, 70, 6]), { name: 'air', kind: 'open' });
  const region = await api('region', [-2, 64, 0, 2, 70, 8]) as { palette: string[]; kinds: string[]; data: number[]; size: number[] };
  assert.ok(region.palette.includes('iron_ore'));
  assert.ok(!region.palette.includes('diamond_ore'));
  assert.equal(region.kinds[region.palette.indexOf('?')], 'unknown');
  assert.equal(region.data.length, region.size.reduce((n, size) => n * size, 1));
  assert.ok(batches.every((n) => n <= 32));
  await assert.rejects(api('region', [-40, 64, -1, 1, 64, 40]), /48 格/);
  await assert.rejects(api('region', [0, 64, 0, 1, 64]), /数字/);
});

test('a missing observation backend cannot fall back to memory or raw block reads', async (t) => {
  const adapter = new FakeAdapter();
  const ctx = makeCtx(adapter, { senses: { recognizedAt: () => 'diamond_ore' } });
  t.after(() => ctx.memory.close());
  assert.deepEqual(await makeBridge(ctx)('blockAt', [0, 63, 0]), { name: null, kind: 'unknown' });
});

test('real vision hides ores, liquids and empty cavities behind a wall from both map APIs', async (t) => {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.pitch = 0;
  for (let y = 63; y <= 68; y++) for (let z = -2; z <= 2; z++) adapter.blocks.push({ name: 'stone', pos: { x: 2, y, z } });
  adapter.blocks.push({ name: 'diamond_ore', pos: { x: 3, y: 65, z: 0 } }, { name: 'water', pos: { x: 3, y: 64, z: 0 } });
  const ctx = makeCtx(adapter);
  ctx.senses = new Vision(adapter);
  t.after(() => ctx.memory.close());
  const api = makeBridge(ctx);
  assert.deepEqual(await api('blockAt', [2, 65, 0]), { name: 'stone', kind: 'solid' });
  for (const y of [64, 65, 66]) assert.deepEqual(await api('blockAt', [3, y, 0]), { name: null, kind: 'unknown' });
  assert.deepEqual(await api('region', [3, 64, 0, 3, 66, 0]), {
    min: { x: 3, y: 64, z: 0 }, size: [1, 3, 1], palette: ['?'], kinds: ['unknown'], data: [0, 0, 0],
  });
});

test('the local map uses actual vision and leaves cells behind a wall unknown', () => {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  for (let y = 63; y <= 67; y++) for (let z = -2; z <= 2; z++) adapter.blocks.push({ name: 'stone', pos: { x: 1, y, z } });
  adapter.blocks.push({ name: 'diamond_ore', pos: { x: 2, y: 65, z: 0 } });
  const vision = new Vision(adapter);
  const map = localMap(adapter, adapter.pos, 'E', vision.observeBlocks.bind(vision));
  assert.equal(map.layers['u+1'][2][4], '?');
  assert.ok(!Object.values(map.legend).includes('diamond_ore'));
});

test('hearing gives rough cues without exact targets; direct and delegated entity actions require sight', async (t) => {
  const adapter = new FakeAdapter();
  adapter.entities = [{ id: 71, name: 'zombie', kind: 'hostile', perception: 'heard', pos: { x: 3.31, y: 64.18, z: 1.27 }, dist: 3.55,
    velocity: { x: 0.1, y: 0, z: 0 }, hp: 18, height: 1.8 }];
  const ctx = makeCtx(adapter);
  t.after(() => ctx.memory.close());
  const api = makeBridge(ctx);
  const heard = await api('entities', [16]) as Record<string, unknown>[];
  assert.equal(heard[0].how, 'heard');
  assert.equal(heard[0].name, 'zombie', '听到时保留能辨认的实体种类');
  assert.equal(heard[0].kind, 'hostile');
  assert.equal(heard[0].dist, 4);
  for (const key of ['id', 'pos', 'velocity', 'hp', 'height']) assert.equal(key in heard[0], false, key);
  for (const [method, args] of [['attack', [71]], ['shoot', [71]], ['move', [{ forward: true }, 200, { face: 71 }]], ['act', ['interact', { entity: 71 }]]] as const) {
    const result = await api(method, [...args]) as { ok: boolean };
    assert.equal(result.ok, false, method);
  }
  assert.deepEqual(adapter.actions, []);
  await assert.rejects(api('act', ['wander', {}]), /没有/);
  await assert.rejects(api('act', ['use_skill', { name: 'test' }]), /不能再调用/);
});

test('act preserves physical feedback while omitting raw local and surroundings maps', async (t) => {
  const adapter = new FakeAdapter(), ctx = makeCtx(adapter);
  t.after(() => ctx.memory.close());
  const result = await makeBridge(ctx)('act', ['mine_cell', { at: [0, 0, 0] }]) as { data: Record<string, unknown> };
  assert.equal('local' in result.data, false);
  assert.equal('around' in result.data, false);
  assert.deepEqual(result.data.position, adapter.pos);
  assert.deepEqual(result.data.targetCell, { x: 0, y: 64, z: 0 });
});

test('nearestLand verifies visible support and headroom before asserting a remembered landing', async (t) => {
  const adapter = new FakeAdapter(), pos = { x: 6, y: 63, z: 0 };
  const visible = new Map([['6,63,0', 'stone'], ['6,64,0', 'air'], ['6,65,0', 'air']]);
  const ctx = makeCtx(adapter, { senses: {
    nearestLand: () => ({ pos, dir: 'E', dist: 6 }),
    observeBlocks: (positions) => positions.flatMap((p) => {
      const name = visible.get(`${p.x},${p.y},${p.z}`), state = adapter.state();
      return name ? [{ name, pos: p, properties: {}, worldId: state.worldId, sessionId: state.sessionId,
        dimension: state.dim, observationId: state.observationId, observedAt: Date.now(), source: 'vision' as const }] : [];
    }),
  } });
  t.after(() => ctx.memory.close());
  const api = makeBridge(ctx);
  assert.deepEqual(await api('nearestLand', []), { stand: { x: 6, y: 64, z: 0 }, dir: 'E', dist: 6, dy: 0 });
  visible.delete('6,65,0');
  assert.equal(await api('nearestLand', []), null, 'unobserved headroom is unknown');
  visible.set('6,65,0', 'air');
  visible.set('6,64,0', 'water');
  assert.equal(await api('nearestLand', []), null, 'visible water is not dry ground');
});

test('failed blind digging cannot identify hidden ore through its error summary', async (t) => {
  const adapter = new FakeAdapter();
  adapter.blocks.push({ name: 'diamond_ore', pos: { x: 2, y: 65, z: 0 } });
  const ctx = makeCtx(adapter, { senses: { observeBlocks: () => [] } });
  t.after(() => ctx.memory.close());
  const result = await makeBridge(ctx)('act', ['mine_cell', { at: [0, 1, 2], facing: 'N' }]) as { ok: boolean; summary: string; data: Record<string, unknown> };
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.summary, /diamond_ore/);
  assert.deepEqual(result.data.targetCell, { x: 2, y: 65, z: 0 });
});

test('failed step and placement expose absolute recovery targets without map feedback', async (t) => {
  const adapter = new FakeAdapter();
  adapter.blocks.push({ name: 'stone', pos: { x: 1, y: 64, z: 0 } }, { name: 'stone', pos: { x: 1, y: 65, z: 0 } });
  const ctx = makeCtx(adapter);
  t.after(() => ctx.memory.close());
  for (const [skill, args] of [['move_step', { to: [1, 0, 0], facing: 'E' }], ['place_cell', { at: [1, 0, 0], facing: 'E', item: 'dirt' }]] as const) {
    const result = await makeBridge(ctx)('act', [skill, args]) as { ok: boolean; data: Record<string, unknown> };
    assert.equal(result.ok, false);
    assert.deepEqual(result.data.targetCell, { x: 1, y: 64, z: 0 });
    assert.equal('local' in result.data, false);
    assert.equal('around' in result.data, false);
  }
});

test('step, occupied placement and climb summaries cannot identify unobserved neighboring ore', async (t) => {
  const adapter = new FakeAdapter();
  adapter.blocks.push({ name: 'diamond_ore', pos: { x: 1, y: 64, z: 0 } }, { name: 'diamond_ore', pos: { x: 1, y: 65, z: 0 } });
  adapter.inv.set('dirt', 2);
  const ctx = makeCtx(adapter, { senses: { observeBlocks: () => [] } });
  t.after(() => ctx.memory.close());
  for (const [skill, args] of [['move_step', { to: [1, 0, 0], facing: 'E' }], ['place_cell', { at: [1, 0, 0], facing: 'E', item: 'dirt' }],
    ['pillar_one', {}]] as const) {
    // Fresh bridge per skill: this test checks feedback disclosure, not the
    // intentional stance dependency between a failed move and a relative at.
    const result = await makeBridge(ctx)('act', [skill, args]);
    assert.doesNotMatch(JSON.stringify(result), /diamond_ore/, skill);
  }
  assert.deepEqual(adapter.actions, [], 'feedback reads must not perform extra actions');
});
