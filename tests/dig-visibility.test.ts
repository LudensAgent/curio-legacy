import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeBridge } from '../src/codeskills/bridge.ts';
import { digAt } from '../src/skills/primitives.ts';
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
  assert.match(result.summary, /没有发生挖掘.*未在当前视野/);
  assert.doesNotMatch(result.summary, /本来就是空/);
  assert.deepEqual(result.data?.targetCell, { x: 1, y: 64, z: 0 });
  const nested = await makeBridge(ctx)('act', ['dig_at', args]) as { ok: boolean };
  assert.equal(nested.ok, false, 'code skills must receive the unsuccessful result');
  assert.deepEqual(adapter.actions, []);
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
