import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import type { MoveOpts } from '../src/adapter/types.ts';
import { hitEntity } from '../src/skills/actions.ts';
import { SKILLS } from '../src/skills/index.ts';
import { makeCtx, TestWorld } from './survival-helpers.ts';

const flush = async () => { await setImmediate(); };
const target = () => ({ id: 41, name: 'boat', kind: 'other' as const, perception: 'seen' as const, pos: { x: 2.5, y: 64, z: 0.5 }, dist: 2, height: 0.6, hp: 10 });

// Direct action acknowledgements and observations only; no game simulation.
test('hit_entity is a bounded registered primitive and reports observed effects without claiming dropped items were recovered', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  const w = new TestWorld(), ctx = makeCtx(w), attacked: number[] = [];
  t.after(() => ctx.memory.close()); w.pos = { x: 0.5, y: 64, z: 0.5 }; w.entities = [target()];
  w.attack = async (id) => {
    attacked.push(id);
    if (attacked.length === 1) w.entities = [{ ...target(), hp: 9 }];
    else w.entities = [{ id: 90, name: 'item:oak_boat', kind: 'item', perception: 'seen', pos: { x: 2.5, y: 64, z: 0.5 }, dist: 2, height: 0.25 }];
    return true;
  };
  assert.equal(SKILLS.hit_entity, hitEntity);
  assert.equal(hitEntity.validate({ entity: 'boat', hits: 9 }, w).ok, false);
  assert.equal(hitEntity.validate({ entityId: 41, hits: 2 }, w).ok, true);
  const result = hitEntity.run(ctx, { entity: 'boat', hits: 8 });
  await flush();
  for (let i = 0; i < 2; i++) { t.mock.timers.tick(650); await flush(); }
  const outcome = await result;
  assert.equal(outcome.status, 'succeeded', outcome.summary);
  assert.deepEqual(attacked, [41, 41], 'stop when this exact target leaves the view');
  assert.equal(outcome.data?.healthDrops, 1);
  assert.deepEqual(outcome.data?.drops, [{ id: 90, name: 'oak_boat', count: 1 }]);
  assert.deepEqual(outcome.data?.gained, []);
  assert.equal(outcome.data?.defeatVerified, false);
  assert.equal(w.inv.get('oak_boat') ?? 0, 0);
  assert.match(outcome.summary, /尚不确定/);
});

test('hit_entity rejects heard, obstructed and still-out-of-reach targets and cannot continue after cancellation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  for (const mode of ['heard', 'glass', 'far', 'cancelled']) {
    const w = new TestWorld(), controller = new AbortController(), ctx = { ...makeCtx(w), signal: controller.signal };
    t.after(() => ctx.memory.close()); w.pos = { x: 0.5, y: 64, z: 0.5 }; w.entities = [target()];
    let calls = 0;
    w.attack = async () => { calls++; controller.abort('replaced'); return true; };
    if (mode === 'heard') w.entities = [{ ...target(), perception: 'heard' }];
    if (mode === 'glass') for (const y of [64, 65]) w.setBlock({ x: 1, y, z: 0 }, 'glass');
    if (mode === 'far') {
      w.entities = [{ ...target(), pos: { x: 10.5, y: 64, z: 0.5 }, dist: 10 }];
      w.moveTo = async (_target, opts: MoveOpts) => { assert.equal(opts.allowSwimming, false); }; // nominal arrival without actual proximity
    }
    const pending = hitEntity.run(ctx, { entity: 41, hits: 8 });
    if (mode === 'cancelled') {
      await assert.rejects(pending, { name: 'AbortedError' });
      assert.equal(calls, 1);
    } else {
      await flush(); t.mock.timers.tick(200); await flush();
      const result = await pending;
      assert.equal(result.status, 'failed', mode);
      assert.equal(calls, 0, mode);
    }
  }
});
