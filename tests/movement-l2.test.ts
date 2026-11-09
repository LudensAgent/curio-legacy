import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boatPath, descendTo, swimPath } from '../src/skills/movement/index.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

test('descend_to 只接受明确的有限落点', () => {
  const w = new FakeAdapter();
  const good = descendTo.validate({ target: { x: 1, y: 63, z: 0 } }, w);
  assert.ok(good.ok, !good.ok ? good.error : '');
  assert.equal(descendTo.name, 'descend_to');
  const bad = descendTo.validate({ target: { x: 1, y: Number.NaN, z: 0 } }, w);
  assert.equal(bad.ok, false);
  const mode = descendTo.validate({ mode: 'nearest' }, w);
  assert.equal(mode.ok, false);
  assert.match(!mode.ok ? mode.error : '', /mode\/nearest.*assess_landings|assess_landings.*mode\/nearest/);
  const empty = descendTo.validate({}, w);
  assert.equal(empty.ok, false);
  assert.match(!empty.ok ? empty.error : '', /assess_landings.*options\[\]\.target/);
});

test('swim_path surface 走有界上浮并如实报告', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 63, z: 0.5 };
  w.inWater = true;
  w.swimTo = async () => {
    w.inWater = false;
    return { ok: true, landed: true, surfaced: true, oxygen: 20 };
  };
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const r = await swimPath.run(ctx, { mode: 'surface' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(swimPath.validate({ mode: 'surface', xyz: { x: 1, y: 63, z: 0 } }, w).ok, false);
});

test('swim_path 的 mode 与实际水面/干岸不一致时拒绝', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.blocks.push({ name: 'water', pos: { x: 1, y: 63, z: 0 } });
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const wrong = await swimPath.run(ctx, { mode: 'dry_shore', xyz: { x: 1, y: 63, z: 0 } });
  assert.equal(wrong.status, 'failed');
  assert.equal(wrong.failureCode, 'BAD_ARGS');
  assert.match(wrong.summary, /水中/);

  // 反向：目标是干方块却要求 water_point，同样显式拒绝。
  const wrongPoint = await swimPath.run(ctx, { mode: 'water_point', xyz: { x: 2, y: 63, z: 0 } });
  assert.equal(wrongPoint.status, 'failed');
  assert.equal(wrongPoint.failureCode, 'BAD_ARGS');
  assert.match(wrongPoint.summary, /不是水中点/);
});

test('swim_path 拒绝不可查询目标（blockAt 返回 null），不进入游泳控制器', async (t) => {
  for (const mode of ['water_point', 'dry_shore'] as const) await t.test(mode, async (t) => {
    const w = new FakeAdapter();
    w.pos = { x: 0.5, y: 64, z: 0.5 };
    let entered = false;
    w.swimTo = async () => { entered = true; return { ok: true, landed: true, surfaced: true, oxygen: 20 }; };
    // FakeAdapter 的返回类型收窄为 string；这里显式模拟目标格不可查询（生产适配器对未加载区块返回 null）。
    w.blockAt = (() => null) as unknown as typeof w.blockAt;
    const ctx = makeCtx(w);
    t.after(() => ctx.memory.close());
    const r = await swimPath.run(ctx, { mode, xyz: { x: 1, y: 63, z: 0 } });
    assert.equal(r.status, 'failed');
    assert.equal(r.failureCode, 'BAD_ARGS');
    assert.deepEqual(r.data?.target, { x: 1, y: 63, z: 0 });
    assert.equal(r.data?.blockKnown, false);
    assert.equal(r.data?.mode, mode);
    assert.equal(entered, false, '目标不可查询时不得进入 swimTo 的干岸回退');
  });
});

test('boat_path 只驾驶已乘坐载具', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  assert.equal(boatPath.validate({ to: { x: 10, z: 10 }, distance: 48 }, w).ok, true);
  assert.equal(boatPath.validate({ distance: 48 }, w).ok, false);
  const r = await boatPath.run(ctx, { to: { x: 10, z: 10 }, distance: 48 });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'BAD_ARGS');
  assert.match(r.summary, /没有在乘坐/);
});

test('swim_path 把整数 x/z 当方块坐标取格心，带小数的脚坐标原样保留，再校验不变', () => {
  const w = new FakeAdapter();
  const v = swimPath.validate({ mode: 'dry_shore', xyz: { x: -502, y: 63, z: -210 } }, w);
  assert.ok(v.ok);
  assert.deepEqual(v.args.xyz, { x: -501.5, y: 63, z: -209.5 }, '整数 x/z 在方块边界上，身体会卡在两列之间');
  assert.deepEqual(swimPath.validate(v.args, w), v);
  const exact = swimPath.validate({ mode: 'water_point', xyz: [3.2, 62, -7.8] }, w);
  assert.ok(exact.ok);
  assert.deepEqual(exact.args.xyz, { x: 3.2, y: 62, z: -7.8 });
});
