import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wait } from '../src/skills/wait.ts';
import { gather } from '../src/skills/work.ts';
import { surface, unstuck } from '../src/skills/movement.ts';
import { swimTo } from '../src/skills/actions.ts';
import { makeCtx, TestWorld } from './survival-helpers.ts';

test('waiting in water does not implicitly swim or change the chosen action', async () => {
  const w = new TestWorld();
  w.inWater = true; w.oxygen = 17;
  const ctx = makeCtx(w);
  try {
    const result = await wait.run(ctx, { seconds: 2, look: false });
    assert.equal(result.status, 'succeeded');
    assert.match(result.summary, /水中，氧气 17\/20/);
    assert.equal(result.data?.inWater, true);
    assert.ok(!w.actions.some((action) => /^(swim|move|dig|place):/.test(action)));
  } finally { ctx.memory.close(); }
});

test('unstuck in water reports the missing action without choosing to swim', async () => {
  const w = new TestWorld();
  w.inWater = true; w.oxygen = 12;
  const ctx = makeCtx(w);
  try {
    const result = await unstuck.run(ctx, {});
    assert.equal(result.status, 'failed');
    assert.match(result.summary, /水中.*没有执行移动.*氧气 12/);
    assert.deepEqual(result.data?.pos, w.pos);
    assert.ok(!w.actions.some((action) => /^(swim|move|dig|place):/.test(action)));
  } finally { ctx.memory.close(); }
});

test('gather reports entering water instead of automatically swimming to shore', async () => {
  const w = new TestWorld();
  w.setBlock({ x: 8, y: 64, z: 0 }, 'oak_log');
  w.moveTo = async () => {
    w.inWater = true; w.oxygen = 13;
    w.setBlock({ x: 0, y: 65, z: 0 }, 'water');
    w.actions.push('entered-water');
  };
  const ctx = makeCtx(w);
  try {
    const result = await gather.run(ctx, { block: 'oak_log', count: 1 });
    assert.equal(result.status, 'failed', result.summary);
    assert.match(result.summary, /进入水中.*已停止采集.*氧气 13/);
    assert.equal(result.data?.inWater, true);
    assert.equal(result.data?.dug, 0);
    assert.equal(w.stopAllCount, 1);
    assert.ok(!w.actions.some((action) => /^(swim|dig|place):/.test(action)));
  } finally { ctx.memory.close(); }
});

test('surface remains available when explicitly requested', async () => {
  const w = new TestWorld();
  w.inWater = false;
  const ctx = makeCtx(w);
  try {
    const result = await surface.run(ctx, {});
    assert.equal(result.status, 'succeeded');
    assert.equal(result.data?.landed, true);
  } finally { ctx.memory.close(); }
});

test('swim_to keeps the chosen coordinate and only succeeds on dry landing', async () => {
  const w = new TestWorld();
  w.inWater = true;
  let target: { x: number; y: number; z: number } | null = null;
  w.swimTo = async (t: any) => { target = t; return { ok: false, reason: 'WATER_ESCAPE_TIMEOUT', landed: false, surfaced: false, oxygen: 14 }; };
  const ctx = makeCtx(w);
  try {
    const valid = swimTo.validate({ xyz: [4, 64, 1] }, w);
    assert.ok(valid.ok);
    const r = await swimTo.run(ctx, (valid as { args: { xyz: { x: number; y: number; z: number }; timeout?: number } }).args);
    assert.equal(r.status, 'failed', r.summary);
    assert.equal(r.data?.landed, false);
    assert.deepEqual(target, { x: 4.5, y: 64, z: 1.5 }, '保持调用方选择的坐标，不换目标');
    assert.equal(r.data?.oxygen, 14);
  } finally { ctx.memory.close(); }
});

test('swim_to refuses outside water', async () => {
  const w = new TestWorld();
  w.inWater = false;
  const ctx = makeCtx(w);
  try {
    const r = await swimTo.run(ctx, { xyz: { x: 4, y: 64, z: 1 } });
    assert.equal(r.status, 'failed');
    assert.equal(r.failureCode, 'BAD_ARGS');
  } finally { ctx.memory.close(); }
});
