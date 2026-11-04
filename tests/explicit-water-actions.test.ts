import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Vec3Like } from '../src/adapter/types.ts';
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

test('swim_to preserves fractional and negative coordinates exactly and only succeeds on dry landing', async () => {
  const w = new TestWorld();
  w.inWater = true;
  let target: Vec3Like | null = null;
  w.swimTo = async (t: Vec3Like | null) => { target = t; return { ok: false, reason: 'WATER_ESCAPE_TIMEOUT', landed: false, surfaced: false, oxygen: 14 }; };
  const ctx = makeCtx(w);
  try {
    const valid = swimTo.validate({ xyz: [-3.5, 64, 10.25] }, w);
    assert.ok(valid.ok);
    const r = await swimTo.run(ctx, valid.args);
    assert.equal(r.status, 'failed', r.summary);
    assert.equal(r.data?.landed, false);
    assert.deepEqual(target, { x: -3.5, y: 64, z: 10.25 }, '保持调用方选择的世界坐标（小数/负值），不取整、不加 0.5、不换目标');
    assert.equal(r.data?.oxygen, 14);
  } finally { ctx.memory.close(); }
});

test('swim_to from a dry shore still swims toward the chosen target (no blanket in-water refusal)', async () => {
  const w = new TestWorld();
  w.inWater = false; // 站在干岸上也要能先走进水里再游向目标
  let target: Vec3Like | null = null;
  w.swimTo = async (t: Vec3Like | null) => { target = t; w.inWater = false; return { ok: true, landed: true, surfaced: true, oxygen: 20 }; };
  const ctx = makeCtx(w);
  try {
    const valid = swimTo.validate({ xyz: [4, 64, 1] }, w);
    assert.ok(valid.ok);
    const r = await swimTo.run(ctx, valid.args);
    assert.equal(r.status, 'succeeded', r.summary);
    assert.deepEqual(target, { x: 4, y: 64, z: 1 }, '目标坐标原样传给底层，不因不在水里而拒绝');
    assert.equal(r.data?.landed, true);
  } finally { ctx.memory.close(); }
});

test('swim_to refuses an exhausted budget without delegating', async (t) => {
  const w = new TestWorld();
  w.inWater = true; w.oxygen = 10;
  let swims = 0;
  w.swimTo = async () => { swims++; return { ok: false, reason: 'WATER_ESCAPE_TIMEOUT', landed: false, surfaced: false, oxygen: 10 }; };
  const now = 100000;
  t.mock.method(Date, 'now', () => now);
  const ctx = makeCtx(w);
  ctx.deadline = now + 500; // 剩余不足 1 秒上浮/游泳
  try {
    const r = await swimTo.run(ctx, { xyz: { x: 4, y: 64, z: 1 } });
    assert.equal(r.status, 'failed');
    assert.equal(r.failureCode, 'TIMEOUT');
    assert.equal(swims, 0, '预算不足不强行开游');
    assert.equal(r.data?.oxygen, 10, '保留实际氧气');
  } finally { ctx.memory.close(); }
});

test('swim_to delegates a short parent budget without extending it', async (t) => {
  const w = new TestWorld();
  w.inWater = true; w.oxygen = 10;
  let delegatedMs: number | undefined;
  w.swimTo = async (_t: Vec3Like | null, _signal: AbortSignal, opts?: { timeoutMs?: number }) => { delegatedMs = opts?.timeoutMs; return { ok: false, reason: 'WATER_ESCAPE_TIMEOUT', landed: false, surfaced: false, oxygen: 10 }; };
  const now = 100000;
  t.mock.method(Date, 'now', () => now);
  const ctx = makeCtx(w);
  ctx.deadline = now + 2500; // 剩余 2500 → 委托 1500
  try {
    const r = await swimTo.run(ctx, { xyz: { x: 4, y: 64, z: 1 } });
    assert.equal(r.status, 'failed');
    assert.equal(delegatedMs, 1500, '委托时长 = 剩余 - 1000，不被 Math.max 拉长');
  } finally { ctx.memory.close(); }
});
