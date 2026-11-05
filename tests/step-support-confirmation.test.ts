import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Vision } from '../src/perception/vision.ts';
import { stepTo } from '../src/skills/primitives.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx, observeAllBlocks, TestWorld } from './survival-helpers.ts';

/**
 * 记录里的失败形态：站在格子北缘、先朝东，脚部目标格 [1,1,0] 和它的支撑格都在背后。
 * 旧的补看只看向第一格（脚目标，接近平视），支撑格（脚下约 -58°）留在视锥外，
 * 之后每一步都报“未看清的格子，无法确认支撑”。
 */
function edgeWorld() {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.19 };
  w.yaw = -Math.PI / 2;
  w.pitch = -0.15;
  w.groundY = 63;
  w.light = 15;
  const vision = new Vision(w);
  return { w, vision };
}

const ctxFor = (w: FakeAdapter, vision: Vision) => makeCtx(w, { senses: {
  observeBlocks: (positions) => vision.observeBlocks(positions),
  refresh: () => vision.refresh(),
} });

test('step 不再为上游目标做视线补看，支撑格是空气就直接报缺口', async (t) => {
  const { w, vision } = edgeWorld();
  const ctx = ctxFor(w, vision);
  t.after(() => ctx.memory.close());
  const look = t.mock.method(w, 'look', async () => {});
  const r = await stepTo.run(ctx, { at: [1, 1, 0], facing: 'N' });
  assert.equal(r.status, 'failed');
  assert.match(r.summary, /是 air.*没有可站立支撑/);
  assert.doesNotMatch(r.summary, /未看清的格子/);
  assert.equal(r.data?.movementNotAttempted, true);
  assert.equal(look.mock.callCount(), 0, '迈步不再转头补看');
});

test('step 没有 fill 时不耗材料：世界和背包都不变', async (t) => {
  const { w, vision } = edgeWorld();
  w.inv.set('cobblestone', 3);
  const ctx = ctxFor(w, vision);
  t.after(() => ctx.memory.close());
  const r = await stepTo.run(ctx, { at: [1, 1, 0], facing: 'N' });
  assert.equal(r.status, 'failed');
  assert.equal(w.blockAt({ x: 0, y: 64, z: -1 }), 'air');
  assert.equal(w.inv.get('cobblestone'), 3);
});

test('step 显式 fill 后先把支撑格补实再迈，并报告实际消耗', async (t) => {
  const { w, vision } = edgeWorld();
  w.inv.set('cobblestone', 3);
  const ctx = ctxFor(w, vision);
  t.after(() => ctx.memory.close());
  const r = await stepTo.run(ctx, { at: [1, 1, 0], facing: 'N', fill: 'cobblestone' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.deepEqual(r.data?.fills, [{ pos: { x: 0, y: 64, z: -1 }, at: [1, 0, 0], item: 'cobblestone' }]);
  assert.equal(w.blockAt({ x: 0, y: 64, z: -1 }), 'cobblestone', '补的是目标脚格正下方这一格');
  assert.equal(w.inv.get('cobblestone'), 2);
  assert.equal(Math.floor(w.pos.y), 65);
});

test('相对迈步前先等身体落地：不在半空位置算 [前,上,右]', async (t) => {
  // 起跳/下落途中读到 y=65，若直接按它算，[1,0,0] 会指到悬空格；落地后（y=64）才是真正的相邻格。
  class LandingWorld extends TestWorld {
    private landedAt = Date.now() + 120;
    private pending = true;
    override state() {
      if (this.pending && Date.now() >= this.landedAt) {
        this.pending = false;
        this.pos = { x: 0.5, y: 64, z: 0.5 };
        this.onGround = true;
      }
      return super.state();
    }
  }
  const w = new LandingWorld();
  w.pos = { x: 0.5, y: 65, z: 0.5 };
  w.onGround = false;
  const ctx = makeCtx(w, { senses: { observeBlocks: observeAllBlocks(w) } });
  t.after(() => ctx.memory.close());
  const r = await stepTo.run(ctx, { at: [1, 0, 0], facing: 'N' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(Math.floor(w.pos.y), 64, '按落地后的脚格走');
});

test('fill 只认已知方块名，不能拿船来补支撑', () => {
  const w = new FakeAdapter();
  const a = stepTo.validate({ at: [1, 1, 0], fill: 'oak_boat' }, w);
  assert.equal(a.ok, false);
  const b = stepTo.validate({ at: [1, 1, 0], fill: 'Not A Block' }, w);
  assert.equal(b.ok, false);
  const c = stepTo.validate({ at: [1, 1, 0], fill: 'cobblestone' }, w);
  assert.ok(c.ok && c.args.fill === 'cobblestone');
});
