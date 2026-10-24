import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import type { BlockObservation } from '../src/adapter/types.ts';
import { interactBlock } from '../src/skills/block-interaction.ts';
import { SKILLS } from '../src/skills/index.ts';
import { makeCtx, TestWorld } from './survival-helpers.ts';

const flush = async () => { await setImmediate(); };

// Fresh observation receipts and immediate operation stubs; no game simulation.
function fixture(far = false) {
  const world = new TestWorld(), controller = new AbortController();
  world.pos = { x: .5, y: 64, z: .5 };
  const pos = { x: far ? 12 : 2, y: 65, z: 0 };
  world.setBlock(pos, 'oak_door'); world.blockProperties.set(`${pos.x},${pos.y},${pos.z}`, { open: false, half: 'lower' });
  let visible = true, reads = 0, calls = 0;
  const ctx = { ...makeCtx(world, { senses: {
    observeBlocks(positions) {
      reads++;
      if (!visible) return [];
      const state = world.state();
      return positions.filter((p) => p.x === pos.x && p.y === pos.y && p.z === pos.z).map((p): BlockObservation => ({ ...world.blockStateAt(p), pos: { ...p }, worldId: state.worldId,
        sessionId: state.sessionId, dimension: state.dim, observationId: state.observationId, observedAt: Date.now(), source: 'vision' }));
    },
  } }), signal: controller.signal };
  world.useBlockAt = async () => { calls++; return { ok: true }; };
  return { world, ctx, pos, controller, visible: (v: boolean) => { visible = v; }, reads: () => reads, calls: () => calls };
}

test('interact_block exposes empty-hand and specified-item right-clicks with exact visible position and actual state feedback', async (t) => {
  assert.equal(SKILLS.interact_block, interactBlock);
  for (const item of ['', 'wooden_hoe']) {
    const w = fixture(); t.after(() => w.ctx.memory.close());
    if (item) { w.world.setBlock(w.pos, 'grass_block'); w.world.inv.set(item, 1); }
    w.world.useBlockAt = async (pos, held) => {
      assert.deepEqual(pos, w.pos); assert.equal(held, item);
      if (item) w.world.setBlock(pos, 'farmland');
      else w.world.blockProperties.set(`${pos.x},${pos.y},${pos.z}`, { open: true, half: 'lower' });
      return { ok: true }; // Return value alone is insufficient; the visible state actually changed.
    };
    const parsed = interactBlock.validate({ target: item ? w.pos : 'oak_door', ...(item ? { item } : {}) }, w.world);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) continue;
    assert.deepEqual(interactBlock.validate(parsed.args, w.world), parsed);
    const result = await interactBlock.run(w.ctx, parsed.args);
    assert.equal(result.status, 'succeeded', result.summary);
    assert.deepEqual(result.data?.pos, w.pos);
    assert.equal((result.data?.effectEvidence as any)?.changed, true);
  }
});

test('interact_block refuses occluded or distant targets, nominal success without changes, and post-cancellation continuation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  for (const mode of ['occluded', 'glass', 'far', 'lost_after_move', 'no_effect', 'cancelled']) {
    const w = fixture(mode === 'far' || mode === 'lost_after_move'); t.after(() => w.ctx.memory.close());
    if (mode === 'occluded') w.visible(false);
    if (mode === 'glass') w.world.setBlock({ x: 1, y: 65, z: 0 }, 'glass');
    if (mode === 'far' || mode === 'lost_after_move') w.world.moveTo = async (_target, opts) => {
      assert.equal(opts.constructionSafe, true); assert.equal(opts.allowSwimming, false);
      if (mode === 'lost_after_move') { w.world.pos.x = 10.5; w.visible(false); }
    };
    let readsAtAbort = -1;
    if (mode === 'cancelled') w.world.useBlockAt = async () => { readsAtAbort = w.reads(); w.controller.abort('replaced'); return { ok: true }; };
    const pending = interactBlock.run(w.ctx, { target: w.pos });
    if (mode === 'cancelled') {
      await assert.rejects(pending, { name: 'AbortedError' });
      assert.equal(w.reads(), readsAtAbort, 'no effect reads or further actions may continue after cancellation');
    } else {
      await flush(); t.mock.timers.tick(200); await flush();
      const result = await pending;
      assert.equal(result.status, 'failed', mode);
      assert.equal(w.calls(), mode === 'no_effect' ? 1 : 0, mode);
      assert.notEqual((result.data?.effectEvidence as any)?.changed, true);
    }
  }
});
