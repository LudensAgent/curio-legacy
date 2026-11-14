import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BlockObservation } from '../src/adapter/types.ts';
import { DIM, FixtureClock, WORLD, withSharedSession } from './fixtures/shared-session.ts';

test('checkpoint 成功后调用 afterCheckpoint 一次；关停的最终保存不额外调用', async () => {
  const clock = new FixtureClock(1000);
  let calls = 0;
  await withSharedSession(clock.now, async (session) => {
    session.setAfterCheckpoint(async () => { calls += 1; });
    const observation: BlockObservation = {
      worldId: WORLD, dimension: DIM, sessionId: 's1', observationId: 1, observedAt: clock.now(),
      source: 'vision', stateComplete: true, name: 'minecraft:stone', properties: {}, pos: { x: 0, y: 64, z: 0 },
    };
    session.observe([observation]);
    await session.checkpoint();
    assert.equal(calls, 1);
  });
  assert.equal(calls, 1, 'shutdown 走库的最终保存，不经过包装器钩子');
});

test('钩子失败（含同步抛出）不会把成功的 checkpoint 变成拒绝', async () => {
  const clock = new FixtureClock(1000);
  await withSharedSession(clock.now, async (session) => {
    session.setAfterCheckpoint(() => { throw new Error('retention failed'); });
    await session.checkpoint();
    session.setAfterCheckpoint(async () => { throw new Error('retention failed'); });
    await session.checkpoint();
  });
});
