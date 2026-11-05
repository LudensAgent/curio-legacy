import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActionResult } from '../src/adapter/types.ts';
import { placeAt, stepTo } from '../src/skills/primitives.ts';
import { makeCtx, observeAllBlocks, TestWorld } from './survival-helpers.ts';

test('step 拒绝空腔时给出下一落点和支撑格的世界坐标', async (t) => {
  const w = new TestWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.setBlock({ x: 0, y: 64, z: -1 }, 'air'); // [1,1,0] 的支撑格：空
  const c = makeCtx(w, { senses: { observeBlocks: observeAllBlocks(w) } });
  t.after(() => c.memory.close());
  const r = await stepTo.run(c, { at: [1, 1, 0], facing: 'N' });
  assert.equal(r.status, 'failed', r.summary);
  assert.match(r.summary, /目标格脚下 \(0,64,-1\) 是 air/);
  assert.match(r.summary, /支撑格 \[1,0,0\]/);
  const support = r.data?.landingSupport as { pos: unknown; at: unknown; observed: unknown } | undefined;
  assert.deepEqual(support?.pos, { x: 0, y: 64, z: -1 });
  assert.deepEqual(support?.at, [1, 0, 0]);
  assert.equal(support?.observed, 'air');
});

class NoReferenceWorld extends TestWorld {
  override async placeBlockAt(): Promise<ActionResult> {
    return { ok: false, reason: 'NO_REFERENCE', detail: '(-48,84,-41) 四周没有相邻实心方块（悬空），从当前站位没有可贴的面' };
  }
}

test('place_at 保留适配器的放置失败细节，区分悬空与视线被挡', async (t) => {
  const w = new NoReferenceWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.inv.set('cobblestone', 3);
  w.setBlock({ x: 0, y: 64, z: -1 }, 'air');
  w.setBlock({ x: 1, y: 64, z: -1 }, 'stone');
  const c = makeCtx(w);
  t.after(() => c.memory.close());
  const r = await placeAt.run(c, { at: [1, 0, 0], facing: 'N', item: 'cobblestone' });
  assert.equal(r.status, 'failed', r.summary);
  assert.equal(r.failureCode, 'PATH_NOT_FOUND');
  assert.match(r.summary, /\(-48,84,-41\) 四周没有相邻实心方块（悬空）/);
  assert.doesNotMatch(r.summary, /或者看不见那个面/);
});
