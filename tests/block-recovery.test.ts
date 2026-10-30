import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MoveOpts, MoveTarget, Vec3Like } from '../src/adapter/types.ts';
import { dig } from '../src/skills/body.ts';
import { throwIfAborted } from '../src/util.ts';
import { makeCtx, TestWorld } from './survival-helpers.ts';

// Immediate acknowledgements and inventory updates only; no game simulation.
class RecoveryWorld extends TestWorld {
  digs: Vec3Like[] = [];
  moves: MoveTarget[] = [];
  collected = 0;
  acknowledgeOnly = false;
  loseDrop = false;
  pendingDrop = '';
  afterMove?: () => void;
  afterDig?: () => void;
  constructor() { super(); this.pos = { x: 0.5, y: 64, z: 0.5 }; }
  override async moveTo(target: MoveTarget, opts: MoveOpts) {
    throwIfAborted(opts.signal);
    assert.equal(opts.constructionSafe, true);
    assert.notEqual(opts.allowTerrainChanges, true);
    this.moves.push(target);
    if (target.kind === 'reach_block') this.pos = { x: target.pos.x - 1, y: target.pos.y, z: target.pos.z + 0.5 };
    if (target.kind === 'xyz') this.pos = { x: target.x + 0.5, y: target.y, z: target.z + 0.5 };
    this.afterMove?.();
  }
  override async dig(pos: Vec3Like, signal: AbortSignal) {
    throwIfAborted(signal);
    this.digs.push({ ...pos });
    this.pendingDrop = this.blockAt(pos);
    if (!this.acknowledgeOnly) this.setBlock(pos, 'air');
    this.afterDig?.();
    return { ok: true };
  }
  override async collectNearbyDrops() {
    this.collected++;
    if (!this.loseDrop && this.pendingDrop) this.inv.set(this.pendingDrop, (this.inv.get(this.pendingDrop) ?? 0) + 1);
    return 99; // This untrusted count must never become the reported inventory gain.
  }
}

test('dig target resolves a perceived block, breaks only that cell and reports actual inventory gain', async (t) => {
  const w = new RecoveryWorld(), ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const bed = { x: 2, y: 64, z: 0 }, wall = { ...bed, y: 65 };
  w.setBlock(bed, 'white_bed'); w.setBlock(wall, 'birch_planks'); w.inv.set('white_bed', 2);
  const parsed = dig.validate({ target: 'white_bed' }, w);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(dig.validate(parsed.args, w), parsed, 'plan validation and arbiter validation must accept the same normalized target');
  const result = await dig.run(ctx, parsed.args);
  assert.equal(result.status, 'succeeded', result.summary);
  assert.deepEqual(w.digs, [bed]); assert.equal(w.blockAt(wall), 'birch_planks');
  assert.deepEqual(result.data?.gained, [{ name: 'white_bed', count: 1 }]);
  assert.equal(w.collected, 1); assert.deepEqual(w.moves, []);
});

test('dig accepts exact coordinates and scoped landmark IDs but rejects malformed or mixed excavation args', async (t) => {
  const w = new RecoveryWorld(), ctx = makeCtx(w);
  t.after(() => ctx.memory.close()); ctx.memory.setWorld(w.worldId);
  const pos = { x: 12, y: 64, z: 0 };
  w.setBlock(pos, 'crafting_table');
  const landmark = ctx.memory.addLandmark('discovery', '我的工作台', w.dim, pos, 0)!;
  const parsed = dig.validate({ target: landmark.id, block: 'crafting_table' }, w);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal((await dig.run(ctx, parsed.args)).status, 'succeeded');
  assert.deepEqual(w.digs, [pos]); assert.equal(w.moves[0].kind, 'reach_block');
  const coordinate = dig.validate({ target: '2,64,0', block: 'white_bed' }, w);
  assert.equal(coordinate.ok, true);
  if (coordinate.ok) assert.deepEqual(coordinate.args.target, { x: 2, y: 64, z: 0 });
  for (const raw of [{ target: 'white_bed', dir: 'E' }, { target: '1,NaN,2' }, { target: { x: 1, y: null, z: 2 } }]) assert.equal(dig.validate(raw, w).ok, false);
});

test('a named target replaced during approach never authorizes breaking the replacement wall', async (t) => {
  const w = new RecoveryWorld(), ctx = makeCtx(w), pos = { x: 12, y: 64, z: 0 };
  t.after(() => ctx.memory.close()); w.setBlock(pos, 'white_bed');
  w.afterMove = () => w.setBlock(pos, 'birch_planks');
  const result = await dig.run(ctx, { target: 'white_bed' });
  assert.equal(result.failureCode, 'TARGET_GONE'); assert.deepEqual(w.digs, []);
});

test('床这类低方块站在上面拆不用先离开，就地拆掉', async (t) => {
  const w = new RecoveryWorld(), ctx = makeCtx(w), foot = { x: 1, y: 64, z: 0 };
  t.after(() => ctx.memory.close());
  w.pos = { x: 0.5, y: 64.5625, z: 0.5 };
  w.setBlock(foot, 'white_bed'); w.setBlock({ ...foot, x: 0 }, 'white_bed');
  w.blockProperties.set('1,64,0', { part: 'foot', facing: 'west' });
  const result = await dig.run(ctx, { target: foot, block: 'white_bed' });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.deepEqual(w.digs, [foot]);
  assert.equal(w.moves.length, 0, '床是低方块，站在上面拆只落下不到一格，不用先离开');
});

test('acknowledged digs and collection counters cannot claim a block was recovered without world and inventory confirmation', async (t) => {
  for (const acknowledgeOnly of [true, false]) {
    const w = new RecoveryWorld(), ctx = makeCtx(w), pos = { x: 2, y: 64, z: 0 };
    t.after(() => ctx.memory.close());
    w.setBlock(pos, 'white_bed'); w.acknowledgeOnly = acknowledgeOnly; w.loseDrop = true;
    const result = await dig.run(ctx, { target: pos });
    assert.equal(result.status, 'failed');
    assert.equal(result.data?.broken, !acknowledgeOnly);
    if (acknowledgeOnly) assert.equal(w.collected, 0); else assert.ok(w.collected >= 1, '实际拆除后会尝试拾取掉落物');
    if (!acknowledgeOnly) assert.match(result.summary, /背包没有新增/);
  }
  const w = new RecoveryWorld(), ctx = makeCtx(w), pos = { x: 2, y: 64, z: 0 };
  t.after(() => ctx.memory.close()); w.setBlock(pos, 'white_bed');
  w.collectNearbyDrops = async () => { w.inv.set('dirt', 1); return 1; };
  const unrelated = await dig.run(ctx, { target: pos });
  assert.equal(unrelated.status, 'failed', 'picking up unrelated dirt must never count as recovering the bed');
  assert.deepEqual(unrelated.data?.gained, [{ name: 'dirt', count: 1 }]);
});

test('cancellation after breaking a target cannot start a late collection action', async (t) => {
  const w = new RecoveryWorld(), controller = new AbortController(), ctx = { ...makeCtx(w), signal: controller.signal };
  t.after(() => ctx.memory.close());
  const pos = { x: 2, y: 64, z: 0 }; w.setBlock(pos, 'white_bed');
  w.afterDig = () => controller.abort('replaced');
  await assert.rejects(dig.run(ctx, { target: pos }), { name: 'AbortedError' });
  assert.equal(w.collected, 0);
});
