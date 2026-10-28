import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeBridge } from '../src/codeskills/bridge.ts';
import { runSandboxed } from '../src/codeskills/sandbox.ts';
import { makeCtx, TestWorld } from './survival-helpers.ts';

test('code skills can verify mounted state and read structured success and failure feedback', async (t) => {
  const w = new TestWorld(), ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  for (let x = 0; x <= 40; x++) for (let z = -3; z <= 3; z++) w.blocks.push({ name: 'water', pos: { x, y: 63, z } });
  w.entities = [{ id: 41, name: 'boat', kind: 'other', perception: 'seen', pos: { x: 2.5, y: 64, z: 0.5 }, dist: 2, height: 0.6 }];
  w.ride = async () => { w.pos = { ...w.pos, x: w.pos.x + 6 }; return { ok: false, reason: 'TIMEOUT', arrived: false, moved: 6 }; };
  const result = await runSandboxed(`
    const before = await api.state();
    const mounted = await api.act('interact', { entity: 41 });
    const after = await api.state();
    const failed = await api.act('ride', { to: '30,0' });
    return { before: before.riding, after: after.riding,
      entityId: mounted.data.entityId, mounted: mounted.data.mounted, position: mounted.data.pos,
      failedOk: failed.ok, failure: failed.code, moved: failed.data.moved, stillRiding: failed.data.riding };
  `, {}, makeBridge(ctx), { signal: ctx.signal, deadline: ctx.deadline });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.result, { before: null, after: 'boat', entityId: 41, mounted: 'boat', position: { x: 2.5, y: 64, z: 0.5 },
    failedOk: false, failure: 'TIMEOUT', moved: 6, stillRiding: 'boat' });
});
