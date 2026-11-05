import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Vec3Like } from '../src/adapter/types.ts';
import { wait } from '../src/skills/wait.ts';
import { gather } from '../src/skills/work.ts';
import { surface, unstuck } from '../src/skills/movement.ts';
import { swimTo } from '../src/skills/actions.ts';
import { runSkill, type SkillCtx } from '../src/skills/types.ts';
import { AbortedError, TimeoutError } from '../src/util.ts';
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

test('unstuck reports pillar construction spend by stage instead of hiding it inside movement', async (t) => {
  const w = new TestWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  // 四面脚下被封住、正上方也被挡（climb_up 会先挖开）：surroundings 判定 enclosed。
  // 头顶用玻璃（不是可垫方块），挖开的掉落不会抵消垫柱的背包净差。
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) w.setBlock({ x: dx, y: 64, z: dz }, 'stone');
  w.setBlock({ x: 0, y: 66, z: 0 }, 'glass');
  w.inv.set('cobblestone', 2);
  t.mock.method(w, 'moveTo', async (target: any) => {
    // climb_up 的原地向上一步：模拟真实垫柱消耗一块可垫方块，然后站上新高度。
    if (target.kind === 'xyz') {
      w.inv.set('cobblestone', (w.inv.get('cobblestone') ?? 1) - 1);
      w.setBlock({ x: 0, y: 64, z: 0 }, 'cobblestone');
      w.pos = { x: 0.5, y: target.y, z: 0.5 };
    }
  });
  const ctx = makeCtx(w);
  try {
    const result = await unstuck.run(ctx, {});
    assert.equal(result.status, 'succeeded', result.summary);
    const construction = result.data?.construction as { attempted: boolean; stage: string; blocksPlaced: number; boundary: string; placedByStage: { stage: string; blocks: { name: string; count: number }[] }[] };
    assert.equal(construction.attempted, true);
    assert.equal(construction.stage, 'pillar_up');
    assert.equal(construction.blocksPlaced, 1, '实际背包减少的可垫方块数');
    assert.deepEqual(construction.placedByStage, [{ stage: 'pillar_up', blocks: [{ name: 'cobblestone', count: 1 }] }]);
    assert.match(construction.boundary, /净减少.*不区分搭柱\/梯子/);
    assert.match(result.summary, /垫了 1 块.*cobblestone×1/);
    assert.equal(w.inv.get('cobblestone'), 1);
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

test('surface treats a positive 500ms remaining budget as usable and delegates the full budget', async (t) => {
  const w = new TestWorld();
  w.inWater = true; w.oxygen = 10;
  let delegatedMs: number | undefined;
  w.swimTo = async (_t: Vec3Like | null, _signal: AbortSignal, opts?: { timeoutMs?: number }) => { delegatedMs = opts?.timeoutMs; return { ok: true, landed: false, surfaced: true, oxygen: 20 }; };
  const now = 100000;
  t.mock.method(Date, 'now', () => now);
  const ctx = makeCtx(w);
  ctx.deadline = now + 500;
  try {
    const r = await surface.run(ctx, {});
    assert.equal(r.status, 'succeeded', r.summary);
    assert.equal(delegatedMs, 500, 'surface 同样不再扣 1000');
  } finally { ctx.memory.close(); }
});

test('surface refuses only when no positive time remains', async (t) => {
  const w = new TestWorld();
  w.inWater = true; w.oxygen = 10;
  let swims = 0;
  w.swimTo = async () => { swims++; return { ok: true, landed: false, surfaced: true, oxygen: 20 }; };
  const now = 100000;
  t.mock.method(Date, 'now', () => now);
  const ctx = makeCtx(w);
  ctx.deadline = now;
  try {
    const r = await surface.run(ctx, {});
    assert.equal(r.status, 'failed');
    assert.equal(r.failureCode, 'TIMEOUT');
    assert.equal(swims, 0);
  } finally { ctx.memory.close(); }
});

test('swim_to success reports surfaced and landed as separate facts', async () => {
  const w = new TestWorld();
  w.inWater = false;
  w.swimTo = async () => { w.inWater = false; return { ok: true, landed: true, surfaced: false, oxygen: 20 }; };
  const ctx = makeCtx(w);
  try {
    const r = await swimTo.run(ctx, { xyz: { x: 4, y: 64, z: 1 } });
    assert.equal(r.status, 'succeeded', r.summary);
    assert.equal(r.data?.landed, true);
    assert.equal(r.data?.surfaced, false, 'surfaced 单独如实报告，不因 landed 硬写成 true');
  } finally { ctx.memory.close(); }
});

test('swim_to treats a positive 500ms remaining budget as usable, not exhausted', async (t) => {
  const w = new TestWorld();
  w.inWater = true; w.oxygen = 10;
  let delegatedMs: number | undefined;
  w.swimTo = async (_t: Vec3Like | null, _signal: AbortSignal, opts?: { timeoutMs?: number }) => { delegatedMs = opts?.timeoutMs; return { ok: false, reason: 'WATER_ESCAPE_TIMEOUT', landed: false, surfaced: false, oxygen: 10 }; };
  const now = 100000;
  t.mock.method(Date, 'now', () => now);
  const ctx = makeCtx(w);
  ctx.deadline = now + 500; // 500ms 是正剩余，不因固定 -1000 缓冲被误判为耗尽
  try {
    const r = await swimTo.run(ctx, { xyz: { x: 4, y: 64, z: 1 } });
    assert.equal(r.status, 'failed');
    assert.equal(r.failureCode, 'TIMEOUT', 'WATER_ESCAPE_TIMEOUT 是预算耗尽，不是找不到路');
    assert.equal(delegatedMs, 500, '500ms 剩余应原样委托，不再扣 1000');
    assert.equal(r.data?.oxygen, 10);
  } finally { ctx.memory.close(); }
});

test('swim_to delegates the full positive parent budget without a fixed -1000 cut', async (t) => {
  const w = new TestWorld();
  w.inWater = true; w.oxygen = 10;
  let delegatedMs: number | undefined;
  w.swimTo = async (_t: Vec3Like | null, _signal: AbortSignal, opts?: { timeoutMs?: number }) => { delegatedMs = opts?.timeoutMs; return { ok: false, reason: 'WATER_ESCAPE_TIMEOUT', landed: false, surfaced: false, oxygen: 10 }; };
  const now = 100000;
  t.mock.method(Date, 'now', () => now);
  const ctx = makeCtx(w);
  ctx.deadline = now + 2500; // 剩余 2500 → 委托 2500（不再 -1000）
  try {
    const r = await swimTo.run(ctx, { xyz: { x: 4, y: 64, z: 1 } });
    assert.equal(r.status, 'failed');
    assert.equal(delegatedMs, 2500, '委托时长 = 剩余，不被 -1000 缩减');
  } finally { ctx.memory.close(); }
});

type WaterPartial = { pos?: { x: number; y: number; z: number }; oxygen?: number; observedAt?: number };

for (const scenario of [
  {
    name: 'surface cancellation keeps the pre-delegation clone when the adapter throws AbortedError without partial',
    cancelled: true,
    error: () => new AbortedError('test cancel'),
    run: (ctx: SkillCtx) => runSkill(ctx, surface, {}),
  },
  {
    name: 'swim_to timeout keeps the pre-delegation clone when the adapter throws TimeoutError without partial',
    cancelled: false,
    error: () => new TimeoutError('test timeout'),
    run: (ctx: SkillCtx) => runSkill(ctx, swimTo, { xyz: { x: -3.5, y: 64, z: 10.25 } }),
  },
]) test(scenario.name, async (t) => {
  const w = new TestWorld();
  // state().pos 是可变引用：底层动作会原地改写它，再推进时钟，且不带 partial 抛错。
  const sharedPos = { x: 1.25, y: 60, z: -4.5 };
  const shared = { pos: sharedPos, oxygen: 12 };
  w.state = () => shared as unknown as ReturnType<TestWorld['state']>;
  let now = 100000;
  t.mock.method(Date, 'now', () => now);
  w.swimTo = async () => {
    sharedPos.x = 99; sharedPos.y = 4; sharedPos.z = -99;
    shared.oxygen = 2;
    now += 500;
    throw scenario.error();
  };
  const ctx = makeCtx(w);
  try {
    let partial: WaterPartial | undefined;
    if (scenario.cancelled) {
      let caught: unknown;
      try { await scenario.run(ctx); } catch (e) { caught = e; }
      assert.ok(caught instanceof Error, '取消应向上抛出，不发明成功或失败结果');
      assert.equal(caught.name, 'AbortedError', 'AbortedError 保持取消语义');
      partial = (caught as Error & { partial?: WaterPartial }).partial;
    } else {
      const result = await scenario.run(ctx);
      assert.equal(result.status, 'failed');
      assert.equal(result.failureCode, 'TIMEOUT', 'TimeoutError 归类为 TIMEOUT 失败，不包装成成功');
      partial = result.data as WaterPartial;
    }
    assert.deepEqual(partial?.pos, { x: 1.25, y: 60, z: -4.5 }, '没有时，partial 用委托前的坐标克隆，不读被原地改写/推进后的当前值');
    assert.notStrictEqual(partial?.pos, sharedPos, 'partial.pos 是独立克隆，不是底层仍在改写的同一对象');
    assert.equal(partial?.oxygen, 12, 'partial.oxygen 是委托前氧气，不是底层改写后的 2');
    assert.equal(partial?.observedAt, 100000, 'partial.observedAt 是委托前观测时刻，不是推进后的时刻');
    assert.deepEqual(sharedPos, { x: 99, y: 4, z: -99 }, '确认适配器确实原地改写了 state().pos');
    assert.equal(shared.oxygen, 2);
    assert.equal(now, 100500, '确认适配器确实推进了时钟');
  } finally { ctx.memory.close(); t.mock.restoreAll(); }
});

test('water timeout maps to TIMEOUT while SWIM_NO_PROGRESS keeps its physical failure code', async () => {
  const w = new TestWorld();
  w.inWater = true; w.oxygen = 10;
  const ctx = makeCtx(w);
  const runBoth = async (reason: string) => {
    w.swimTo = async () => ({ ok: false, reason, landed: false, surfaced: false, oxygen: 10 });
    return { surface: await surface.run(ctx, {}), swimTo: await swimTo.run(ctx, { xyz: { x: 4, y: 64, z: 1 } }) };
  };
  try {
    const progress = await runBoth('SWIM_NO_PROGRESS');
    assert.equal(progress.surface.failureCode, 'STUCK', 'SWIM_NO_PROGRESS 仍是物理没进展');
    assert.equal(progress.swimTo.failureCode, 'PATH_NOT_FOUND', 'SWIM_NO_PROGRESS 对 swim_to 仍是找不到路');
    const timeout = await runBoth('WATER_ESCAPE_TIMEOUT');
    assert.equal(timeout.surface.failureCode, 'TIMEOUT', 'surface 的预算耗尽是 TIMEOUT');
    assert.equal(timeout.swimTo.failureCode, 'TIMEOUT', 'swim_to 的预算耗尽是 TIMEOUT');
    assert.equal(timeout.surface.data?.reason, 'WATER_ESCAPE_TIMEOUT');
    assert.equal(timeout.swimTo.data?.reason, 'WATER_ESCAPE_TIMEOUT');
  } finally { ctx.memory.close(); }
});

test('swim_to refuses only when no positive time remains', async (t) => {
  const w = new TestWorld();
  w.inWater = true; w.oxygen = 10;
  let swims = 0;
  w.swimTo = async () => { swims++; return { ok: false, reason: 'WATER_ESCAPE_TIMEOUT', landed: false, surfaced: false, oxygen: 10 }; };
  const now = 100000;
  t.mock.method(Date, 'now', () => now);
  const ctx = makeCtx(w);
  ctx.deadline = now; // 剩余 0
  try {
    const r = await swimTo.run(ctx, { xyz: { x: 4, y: 64, z: 1 } });
    assert.equal(r.status, 'failed');
    assert.equal(r.failureCode, 'TIMEOUT');
    assert.equal(swims, 0, '剩余 <= 0 才拒绝，不发出控制');
    assert.equal(r.data?.oxygen, 10);
  } finally { ctx.memory.close(); }
});
