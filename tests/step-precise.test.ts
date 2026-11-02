import assert from 'node:assert/strict';
import { test } from 'node:test';
import { placeAt, primitiveSkills, stepTo } from '../src/skills/primitives.ts';
import { makeBridge } from '../src/codeskills/bridge.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

test('a downward step reports the selected support cell without revealing an unseen block', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.removed.add('1,63,0');
  w.removed.add('1,62,0');
  let seeFloor = false;
  const ctx = makeCtx(w, { senses: { observeBlocks: (positions) => positions.filter((pos) => seeFloor || pos.y !== 62).map((pos) => ({
    name: w.blockAt(pos), pos, properties: {}, worldId: w.worldId, sessionId: w.sessionId,
    dimension: w.dim, observationId: 1, observedAt: Date.now(), source: 'vision' as const,
  })) } });
  t.after(() => ctx.memory.close());
  const move = t.mock.method(w, 'moveTo', async () => {});
  const bridge = makeBridge(ctx);
  const hidden = await bridge('stepTo', [1, 63, 0]) as { ok: boolean; summary: string; data: { landingSupport: { pos: unknown; observed: string | null } } };
  assert.equal(hidden.ok, false);
  assert.match(hidden.summary, /脚下 \(1,62,0\) 是 未看清的格子/);
  assert.deepEqual(hidden.data.landingSupport, { pos: { x: 1, y: 62, z: 0 }, at: [0, -2, 1], placeAtInRange: false, observed: null });
  assert.match(hidden.summary, /支撑格 \[0,-2,1\] 超出 place_at 上下 -1\.\.3 范围/);
  assert.match(hidden.summary, /脚部目标格 \[0,-1,1\] 须留空/);
  assert.equal(move.mock.callCount(), 0);

  seeFloor = true;
  const visible = await stepTo.run(ctx, { at: [1, -1, 0], facing: 'E' });
  assert.match(visible.summary, /脚下 \(1,62,0\) 是 air/);
  assert.deepEqual(visible.data?.landingSupport, { pos: { x: 1, y: 62, z: 0 }, at: [1, -2, 0], placeAtInRange: false, observed: 'air' });
  assert.match(visible.summary, /支撑格 \[1,-2,0\] 超出 place_at 上下 -1\.\.3 范围/);
  assert.equal(placeAt.validate({ at: [1, -2, 0], facing: 'E', item: 'cobblestone' }, w).ok, false);
  assert.equal(primitiveSkills.find((skill) => skill.name === 'place_at')!.validate({ xyz: [1, 62, 0], item: 'cobblestone' }, w).ok, false,
    'the reported placement range also applies to absolute targets');
  assert.equal(move.mock.callCount(), 0);
});

test('support feedback identifies the floor to fill while keeping the selected foot cell empty', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.speed = 100000;
  w.removed.add('0,63,-1');
  w.removed.add('0,62,-1');
  w.inv.set('cobblestone', 1);
  const ctx = makeCtx(w, { senses: { observeBlocks: (positions) => positions.map((pos) => ({
    name: w.blockAt(pos), pos, properties: {}, worldId: w.worldId, sessionId: w.sessionId,
    dimension: w.dim, observationId: 1, observedAt: Date.now(), source: 'vision' as const,
  })) } });
  t.after(() => ctx.memory.close());
  const blocked = await stepTo.run(ctx, { at: [1, 0, 0], facing: 'N' });
  assert.equal(blocked.status, 'failed');
  assert.deepEqual(blocked.data?.landingSupport, { pos: { x: 0, y: 63, z: -1 }, at: [1, -1, 0], placeAtInRange: true, observed: 'air' });
  assert.match(blocked.summary, /支撑格 \[1,-1,0\]；脚部目标格 \[1,0,0\] 须留空/);
  assert.deepEqual(w.actions, [], 'reporting a missing floor does not move or spend blocks');
  assert.equal(w.inv.get('cobblestone'), 1);
  const placed = await placeAt.run(ctx, { at: [1, -1, 0], facing: 'N', item: 'cobblestone' });
  assert.equal(placed.status, 'succeeded', placed.summary);
  const wrongHeight = await stepTo.run(ctx, { at: [1, -1, 0], facing: 'N' });
  assert.equal(wrongHeight.status, 'failed');
  assert.match(wrongHeight.summary, /目标格是 cobblestone/);
  const entered = await stepTo.run(ctx, { at: [1, 0, 0], facing: 'N' });
  assert.equal(entered.status, 'succeeded', entered.summary);
  assert.deepEqual(w.pos, { x: 0.5, y: 64, z: -0.5 });
});

test('step auto-fills a shallow air gap and steps across it', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.speed = 100000;
  w.removed.add('0,63,-1'); // 浅坑：目标格脚下是空气、再下面一格是实心
  w.inv.set('cobblestone', 1);
  const ctx = makeCtx(w, { senses: { observeBlocks: (positions) => positions.map((pos) => ({
    name: w.blockAt(pos), pos, properties: {}, worldId: w.worldId, sessionId: w.sessionId,
    dimension: w.dim, observationId: 1, observedAt: Date.now(), source: 'vision' as const,
  })) } });
  t.after(() => ctx.memory.close());
  const stepped = await stepTo.run(ctx, { at: [1, 0, 0], facing: 'N' });
  assert.equal(stepped.status, 'succeeded', stepped.summary);
  assert.deepEqual(w.pos, { x: 0.5, y: 64, z: -0.5 });
  assert.equal(w.inv.get('cobblestone'), 0, 'auto-fill spends the scaffold block');
});

test('step rejects partial diagonal movement and reports actual location', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const move = t.mock.method(w, 'moveTo', async () => { w.pos = { x: 1.5, y: 64, z: 0.5 }; });
  const r = await stepTo.run(ctx, { at: [1, 0, 1], facing: 'E' });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'EFFECT_NOT_CONFIRMED');
  assert.deepEqual(r.data?.targetCell, { x: 1, y: 64, z: 1 });
  assert.deepEqual(r.data?.position, { x: 1.5, y: 64, z: 0.5 });
  assert.equal(move.mock.callCount(), 1);
});

test('step confirms position even when movement resolves or rejects', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const move = t.mock.method(w, 'moveTo', async () => {});
  assert.equal((await stepTo.run(ctx, { at: [1, 0, 0], facing: 'E' })).status, 'failed');
  move.mock.mockImplementation(async () => { throw new Error('No path'); });
  assert.equal((await stepTo.run(ctx, { at: [1, 0, 0], facing: 'E' })).status, 'failed');
  move.mock.mockImplementation(async () => { w.pos = { x: 1.5, y: 64, z: 0.5 }; throw new Error('No path'); });
  assert.equal((await stepTo.run(ctx, { at: [1, 0, 0], facing: 'E' })).status, 'succeeded');
  move.mock.mockImplementation(async () => { throw Object.assign(new Error('cancelled'), { name: 'AbortedError' }); });
  await assert.rejects(stepTo.run(ctx, { at: [1, 0, 0], facing: 'E' }), { name: 'AbortedError' });
});

test('step looks at the selected obstruction without changing the target or digging', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.blocks.push({ name: 'stone', pos: { x: 1, y: 64, z: 0 } });
  let looked = false;
  const ctx = makeCtx(w, { senses: { observeBlocks: (positions) => looked ? positions.map((pos) => ({
    name: w.blockAt(pos), pos, properties: {}, worldId: w.worldId, sessionId: w.sessionId,
    dimension: w.dim, observationId: 1, observedAt: Date.now(), source: 'vision' as const,
  })) : [] } });
  t.after(() => ctx.memory.close());
  const look = t.mock.method(w, 'look', async () => { looked = true; });
  const move = t.mock.method(w, 'moveTo', async () => {});
  const dig = t.mock.method(w, 'dig', async () => ({ ok: true }));
  const r = await stepTo.run(ctx, { at: [1, 0, 0], facing: 'E' });
  assert.equal(r.status, 'failed');
  assert.match(r.summary, /stone/);
  assert.deepEqual(r.data?.targetCell, { x: 1, y: 64, z: 0 });
  assert.equal(look.mock.callCount(), 1);
  assert.equal(move.mock.callCount(), 0);
  assert.equal(dig.mock.callCount(), 0);
});

test('step keeps an obstructed target unknown if looking does not reveal it', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.blocks.push({ name: 'stone', pos: { x: 1, y: 64, z: 0 } });
  const ctx = makeCtx(w, { senses: { observeBlocks: () => [] } });
  t.after(() => ctx.memory.close());
  const look = t.mock.method(w, 'look', async () => {});
  const r = await stepTo.run(ctx, { at: [1, 0, 0], facing: 'E' });
  assert.equal(r.status, 'failed');
  assert.doesNotMatch(r.summary, /stone/);
  assert.equal(look.mock.callCount(), 1);
});

test('ladder step rejects a higher position in a different column', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.blocks.push({ name: 'ladder', pos: { x: 0, y: 64, z: 0 } });
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  t.mock.method(w, 'moveTo', async () => { w.pos = { x: 1.5, y: 65, z: 0.5 }; });
  const r = await stepTo.run(ctx, { at: [0, 1, 0], facing: 'N' });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'EFFECT_NOT_CONFIRMED');
  assert.deepEqual(r.data?.targetCell, { x: 0, y: 65, z: 0 });
});

test('water step does not claim to land on the selected bank when it lands adjacent', async (t) => {
  const w = new FakeAdapter();
  w.groundY = 59;
  w.pos = { x: 0.5, y: 62.4, z: 0.5 };
  w.inWater = true;
  w.blocks.push({ name: 'stone', pos: { x: 1, y: 63, z: 0 } });
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  t.mock.method(w, 'swimTo', async () => { w.pos = { x: 1.5, y: 64, z: 1.5 }; w.inWater = false; return { ok: true, landed: true, oxygen: 20 }; });
  const r = await stepTo.run(ctx, { at: [1, 0, 0], facing: 'E' });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'EFFECT_NOT_CONFIRMED');
  assert.deepEqual(r.data?.targetCell, { x: 1, y: 64, z: 0 });
  assert.deepEqual(r.data?.position, { x: 1.5, y: 64, z: 1.5 });
});
