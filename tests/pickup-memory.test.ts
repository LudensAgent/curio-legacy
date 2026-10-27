import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickupItems } from '../src/skills/survival.ts';

/** 掉落物刚才看见过、转身后不在视野里：pickup_items 应该走回记得的地方，并且按背包变化报告 */
function ctxWith(opts: { picks: boolean }) {
  const inv = [{ name: 'dirt', count: 3 }];
  const forgot: number[] = [];
  const moves: any[] = [];
  const ctx: any = {
    signal: new AbortController().signal, deadline: Date.now() + 30_000, taskId: 't', progress() {},
    adapter: {
      state: () => ({ pos: { x: 0, y: 64, z: 0 }, inventory: inv.map((i) => ({ ...i })) }),
      eye: () => ({ x: 0, y: 65.6, z: 0, yaw: 0, pitch: 0 }),
      look: async () => {},
      moveTo: async (goal: any) => { moves.push(goal); if (opts.picks) inv.push({ name: 'white_bed', count: 1 }); },
      forgetDiscarded() {},
    },
    senses: {
      refresh() {}, perceivedEntities: () => [], knownBlocks: () => [], markSweep() {},
      recentDrops: () => forgot.includes(7) ? [] : [{ id: 7, name: 'white_bed', pos: { x: 3, y: 64, z: -3 }, ageMs: 4000 }],
      forgetDrop: (id: number) => forgot.push(id),
    },
  };
  return { ctx, moves, forgot };
}

test('pickup_items：眼前没有但刚看见过 → 走回去捡，背包真多了才算捡到', async () => {
  const a = ctxWith({ picks: true });
  const r = await pickupItems.run(a.ctx, { radius: 12, item: 'white_bed' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.match(r.summary, /white_bed×1/);
  assert.equal(a.moves[0]?.pos?.x, 3);

  const b = ctxWith({ picks: false });
  const r2 = await pickupItems.run(b.ctx, { radius: 12, item: 'white_bed' });
  assert.equal(r2.status, 'failed', r2.summary);
  assert.match(r2.summary, /没有捡到/);
  assert.deepEqual(b.forgot, [7], '到跟前没看见就忘掉，不再反复跑回去');
});
