import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeBridge } from '../src/codeskills/bridge.ts';
import { Vision } from '../src/perception/vision.ts';
import { digAt, primitiveSkills } from '../src/skills/primitives.ts';
import { deliberateSystem, glanceSystem } from '../src/mind/prompt.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

test('digging an unseen empty cell reports an unconfirmed result to the caller', async (t) => {
  const adapter = new FakeAdapter();
  const ctx = makeCtx(adapter, { senses: { observeBlocks: () => [] } });
  t.after(() => ctx.memory.close());
  const args = { at: [1, 0, 0] as [number, number, number], facing: 'E' as const };
  const result = await digAt.run(ctx, args);
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'NOT_FOUND');
  assert.match(result.summary, /没有发生挖掘.*\(1,64,0\).*未在当前视野/);
  assert.match(result.summary, /方块状态未知，未确认是空气还是其他方块/);
  assert.match(result.summary, /尝试看向后仍未在当前视野/);
  assert.doesNotMatch(result.summary, /本来就是空/);
  assert.deepEqual(result.data?.targetCell, { x: 1, y: 64, z: 0 });
  const nested = await makeBridge(ctx)('act', ['dig_at', args]) as { ok: boolean };
  assert.equal(nested.ok, false, 'code skills must receive the unsuccessful result');
  assert.deepEqual(adapter.actions, []);
});

test('an unseen empty target is looked at and confirmed without changing the chosen cell', async (t) => {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.yaw = -Math.PI / 2;
  const ctx = makeCtx(adapter);
  ctx.senses = new Vision(adapter);
  t.after(() => ctx.memory.close());
  const pos = { x: 0, y: 64, z: -1 };
  assert.deepEqual(ctx.senses.observeBlocks!([pos]), [], 'the target starts outside the view');
  const result = await digAt.run(ctx, { at: [1, 0, 0], facing: 'N' });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.noop, true);
  assert.equal(result.data?.was, 'air');
  assert.deepEqual(result.data?.targetCell, pos);
  assert.ok(Math.abs(adapter.yaw) < 0.01, 'turned to the requested cell');
  assert.deepEqual(adapter.actions, [], 'observing empty air must not dig');
});

test('absolute and code-skill coordinates remain fixed when observation changes the view', async (t) => {
  for (const mode of ['absolute', 'bridge'] as const) {
    const adapter = new FakeAdapter();
    adapter.pos = { x: 0.5, y: 64, z: 0.5 };
    adapter.yaw = -Math.PI / 2;
    const ctx = makeCtx(adapter);
    ctx.senses = new Vision(adapter);
    t.after(() => ctx.memory.close());
    const target = { x: 0, y: 64, z: -1 };
    const skill = primitiveSkills.find((s) => s.name === 'dig_at')!;
    const parsed = skill.validate({ xyz: [target.x, target.y, target.z], facing: 'W' }, adapter);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) continue;
    const result = mode === 'absolute' ? await skill.run(ctx, parsed.args) : await makeBridge(ctx)('digAt', [target.x, target.y, target.z]);
    const data = (result as { data: { targetCell: typeof target; noop: boolean; was: string } }).data;
    assert.deepEqual(data.targetCell, target, mode);
    assert.equal(data.noop, true, mode);
    assert.equal(data.was, 'air', mode);
  }
});

test('a visible-after-looking solid target is dug at its original world position', async (t) => {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.yaw = -Math.PI / 2;
  const target = { x: 0, y: 64, z: -1 }, other = { x: 1, y: 64, z: 0 };
  adapter.blocks.push({ name: 'stone', pos: target }, { name: 'stone', pos: other });
  const ctx = makeCtx(adapter);
  ctx.senses = new Vision(adapter);
  t.after(() => ctx.memory.close());
  assert.deepEqual(ctx.senses.observeBlocks!([target]), []);
  const result = await digAt.run(ctx, { at: [1, 0, 0], facing: 'N' });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.deepEqual(result.data?.targetCell, target);
  assert.equal(adapter.blockAt(target), 'air');
  assert.equal(adapter.blockAt(other), 'stone');
  assert.deepEqual(adapter.actions, ['dig:stone']);
});

test('turning toward an occluded target does not reveal or dig hidden air or ore', async (t) => {
  for (const hidden of ['air', 'diamond_ore']) {
    const adapter = new FakeAdapter();
    adapter.pos = { x: 0.5, y: 64, z: 0.5 };
    // An intact two-block-high wall blocks the ray to the exact target.
    for (const y of [64, 65, 66]) for (const z of [-1, 0, 1]) adapter.blocks.push({ name: 'stone', pos: { x: 1, y, z } });
    if (hidden !== 'air') adapter.blocks.push({ name: hidden, pos: { x: 2, y: 65, z: 0 } });
    const ctx = makeCtx(adapter);
    ctx.senses = new Vision(adapter);
    t.after(() => ctx.memory.close());
    const result = await digAt.run(ctx, { at: [2, 1, 0], facing: 'E' });
    assert.equal(result.failureCode, 'NOT_FOUND');
    assert.match(result.summary, /方块状态未知/);
    assert.doesNotMatch(result.summary, /diamond_ore|本来就是空/);
    assert.deepEqual(adapter.actions, []);
  }
});

test('cancelling the look cannot continue to dig or claim an observation', async (t) => {
  const adapter = new FakeAdapter(), controller = new AbortController();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = makeCtx(adapter, { senses: { observeBlocks: () => [] } });
  ctx.signal = controller.signal;
  t.after(() => ctx.memory.close());
  t.mock.method(adapter, 'look', async () => { controller.abort(); throw Object.assign(new Error('cancelled'), { name: 'AbortedError' }); });
  await assert.rejects(digAt.run(ctx, { at: [1, 0, 0], facing: 'N' }), { name: 'AbortedError' });
  assert.deepEqual(adapter.actions, []);
});

test('both thinking tiers distinguish an unseen cell from confirmed air', () => {
  for (const system of [deliberateSystem(''), glanceSystem('', new Set())]) {
    assert.match(system, /未看见的方块状态未知，未挖到不代表那里是空气/);
  }
});

test('a visibly empty cell remains a confirmed no-op', async (t) => {
  const adapter = new FakeAdapter();
  const ctx = makeCtx(adapter, { senses: { observeBlocks: (positions) => positions.map((pos) => ({ pos, name: 'air', properties: {},
    worldId: adapter.worldId, sessionId: adapter.sessionId, dimension: adapter.dim, observationId: 1, observedAt: Date.now(), source: 'vision' })) } });
  t.after(() => ctx.memory.close());
  const result = await digAt.run(ctx, { at: [1, 0, 0], facing: 'E' });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.data?.noop, true);
  assert.equal(result.data?.was, 'air');
  assert.deepEqual(adapter.actions, []);
});

test('an unloaded cell at the player is not reported as confirmed air', async (t) => {
  const adapter = new FakeAdapter();
  const blockAt = adapter.blockAt.bind(adapter);
  t.mock.method(adapter, 'blockAt', (pos) => pos.x === 0 && pos.y === 65 && pos.z === 0 ? null : blockAt(pos));
  const ctx = makeCtx(adapter, { senses: { observeBlocks: () => [] } });
  t.after(() => ctx.memory.close());
  const result = await digAt.run(ctx, { at: [0, 1, 0], facing: 'N' });
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'NOT_FOUND');
  assert.doesNotMatch(result.summary, /本来就空/);
});
