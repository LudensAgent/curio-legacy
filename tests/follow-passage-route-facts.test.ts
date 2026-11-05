import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Vec3Like } from '../src/adapter/types.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { followPassage } from '../src/skills/movement.ts';
import { makeCtx, TestWorld } from './survival-helpers.ts';

const save = (memory: WorldMemory, w: TestWorld, id: string, path: Vec3Like[], entrance: Vec3Like) =>
  memory.savePassage({ id, worldId: w.worldId, dim: w.dim, kind: 'dug', entrances: [entrance],
    deepestY: Math.min(...path.map((p) => p.y)), dug: 30, ores: {}, createdAt: 0, lastUsedAt: 0, uses: 1, path });

// 2026-11-05 现场形状：从 y77 下到 y50 再爬回 y79 的入口，段数多、下潜深。
const detour: Vec3Like[] = [
  { x: 0, y: 77, z: 0 }, { x: 0, y: 74, z: 0 }, { x: -1, y: 70, z: 0 }, { x: -2, y: 66, z: 0 },
  { x: -3, y: 62, z: 0 }, { x: -4, y: 58, z: 0 }, { x: -5, y: 54, z: 0 }, { x: -6, y: 50, z: 0 },
  { x: -7, y: 54, z: 0 }, { x: -8, y: 58, z: 0 }, { x: -9, y: 62, z: 0 }, { x: -10, y: 66, z: 0 },
  { x: -11, y: 70, z: 0 }, { x: -12, y: 74, z: 0 }, { x: -12, y: 79, z: 0 },
];

test('回入口的路线要先下潜再爬回时，开走前停下并给出路线事实与备选', async (t) => {
  const w = new TestWorld();
  w.pos = { x: 0.5, y: 77, z: 0.5 };
  const memory = new WorldMemory(null);
  memory.setWorld(w.worldId);
  save(memory, w, 'psg_detour', detour, { x: -12, y: 81, z: 0 });
  // 同分量另有一条更长但不下潜的记录出口：作为备选，代价更高。
  const flat: Vec3Like[] = [];
  for (let x = 0; x <= 70; x += 5) flat.push({ x, y: 77, z: 0 });
  save(memory, w, 'psg_flat', flat, { x: 70, y: 77, z: 0 });
  const ctx = makeCtx(w, { memory });
  t.after(() => memory.close());
  const moves = t.mock.method(w, 'moveTo', async () => { throw new Error('不应开走'); });

  const result = await followPassage.run(ctx as never, { to: 'entrance' });

  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'PATH_NOT_FOUND');
  assert.equal(moves.mock.callCount(), 0, '绕行路线不应在 agent 决定前开走');
  assert.match(result.summary, /不是直接回地表/);
  assert.match(result.summary, /最低到 y=50/);
  const facts = result.data?.routeFacts as { segments: number; dip: number; minY: number; pathLength: number };
  assert.ok(facts.segments >= 8);
  assert.ok(facts.pathLength >= 24, '提前中止的门槛是路长 >=24 且下潜 >=8');
  assert.equal(facts.minY, 50);
  assert.equal(facts.dip, 27);
  const alternatives = result.data?.alternatives as { pos: Vec3Like; cost: number; ids: string[] }[];
  assert.equal(alternatives.length, 1, '当前绕行入口不重复列进备选');
  assert.deepEqual(alternatives[0]!.pos, { x: 70, y: 77, z: 0 });
  assert.equal(alternatives[0]!.ids[0], 'psg_flat');
  assert.ok(alternatives[0]!.cost >= facts.pathLength, '备选要带图上的实际代价');
  assert.deepEqual(result.data?.resolvedIds, ['psg_detour'], '给出可用来强制走当前这条的记录 ID');
});

test('显式指定 id 时尊重 agent 的选择，不因绕行提前停下', async (t) => {
  const w = new TestWorld();
  w.pos = { x: 0.5, y: 77, z: 0.5 };
  const memory = new WorldMemory(null);
  memory.setWorld(w.worldId);
  save(memory, w, 'psg_detour', detour, { x: -12, y: 81, z: 0 });
  const ctx = makeCtx(w, { memory });
  t.after(() => memory.close());
  const visited: Vec3Like[] = [];
  t.mock.method(w, 'moveTo', async (goal: any) => {
    if (goal.kind === 'near') { visited.push(goal.pos); w.pos = { ...goal.pos }; }
  });

  const result = await followPassage.run(ctx as never, { to: 'entrance', id: 'psg_detour' });

  assert.equal(result.status, 'succeeded', result.summary);
  assert.ok(visited.length > 0, '带 id 时应按记录逐段走');
});

test('短距离的小下探不打断：只有明显绕远才在开走前停下', async (t) => {
  const w = new TestWorld();
  w.pos = { x: 0.5, y: 40, z: 0.5 };
  const memory = new WorldMemory(null);
  memory.setWorld(w.worldId);
  // 下探 10 格，但总路长只有 22 格：一两次台阶的绕行，不值得打断。
  save(memory, w, 'short-dip', [{ x: 0, y: 40, z: 0 }, { x: 0, y: 34, z: 0 }, { x: 0, y: 30, z: 0 }, { x: 0, y: 36, z: 0 }, { x: 0, y: 42, z: 0 }], { x: 0, y: 42, z: 0 });
  const ctx = makeCtx(w, { memory });
  t.after(() => memory.close());
  t.mock.method(w, 'moveTo', async (goal: any) => { if (goal.kind === 'near') w.pos = { ...goal.pos }; });

  const result = await followPassage.run(ctx as never, { to: 'entrance' });

  assert.equal(result.status, 'succeeded', result.summary);
  const facts = result.data?.routeFacts as { dip: number; pathLength: number };
  assert.equal(facts.dip, 10);
  assert.ok(facts.pathLength < 24);
});

test('正常回入口的路线把段数/路长/下潜幅度写进回执', async (t) => {
  const w = new TestWorld();
  w.pos = { x: 0.5, y: 40, z: 0.5 };
  const memory = new WorldMemory(null);
  memory.setWorld(w.worldId);
  save(memory, w, 'flat', [{ x: 0, y: 40, z: 0 }, { x: 4, y: 40, z: 0 }, { x: 8, y: 40, z: 0 }], { x: 8, y: 41, z: 0 });
  const ctx = makeCtx(w, { memory });
  t.after(() => memory.close());
  t.mock.method(w, 'moveTo', async (goal: any) => { if (goal.kind === 'near') w.pos = { ...goal.pos }; });

  const result = await followPassage.run(ctx as never, { to: 'entrance' });

  assert.equal(result.status, 'succeeded', result.summary);
  const facts = result.data?.routeFacts as { segments: number; dip: number; pathLength: number };
  assert.ok(facts.segments >= 2);
  assert.equal(facts.dip, 0);
  assert.ok(facts.pathLength > 0);
  assert.equal(result.data?.rescueCount, 0);
});

test('同列兜底到达的高度差太多时停下，不把路线挪到另一层', async (t) => {
  const w = new TestWorld();
  w.pos = { x: 0.5, y: 40, z: 0.5 };
  const memory = new WorldMemory(null);
  memory.setWorld(w.worldId);
  save(memory, w, 'flat', [{ x: 0, y: 40, z: 0 }, { x: 4, y: 40, z: 0 }, { x: 8, y: 40, z: 0 }], { x: 8, y: 41, z: 0 });
  const ctx = makeCtx(w, { memory });
  t.after(() => memory.close());
  t.mock.method(w, 'moveTo', async (goal: any) => {
    if (goal.kind === 'near') throw new Error('No path');
    w.pos = { x: goal.x, y: 30, z: goal.z };
  });

  const result = await followPassage.run(ctx as never, { to: 'entrance' });

  assert.equal(result.status, 'failed');
  assert.match(result.summary, /高度差 10 格/);
  assert.match(result.summary, /这条记录和当前地形对不上/);
  assert.ok(result.data?.staleWaypoint);
});

test('系统性 3 格 y 偏差仍能走完：兜底成功只记次数，不中止', async (t) => {
  const w = new TestWorld();
  w.pos = { x: 0.5, y: 40, z: 0.5 };
  const memory = new WorldMemory(null);
  memory.setWorld(w.worldId);
  save(memory, w, 'flat', [0, 4, 8, 12, 16].map((x) => ({ x, y: 40, z: 0 })), { x: 16, y: 41, z: 0 });
  const ctx = makeCtx(w, { memory });
  t.after(() => memory.close());
  // 记录点的 y 总是差 3 格（在 4 格容差内），near 每次都失败、同列兜底每次都能到。
  t.mock.method(w, 'moveTo', async (goal: any) => {
    if (goal.kind === 'near') throw new Error('No path');
    w.pos = { x: goal.x, y: 37, z: goal.z };
  });

  const result = await followPassage.run(ctx as never, { to: 'entrance' });

  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.rescueCount, 4, '每段都记一次兜底，但路线照常走完');
  assert.equal((result.data?.arrival as { satisfied: boolean }).satisfied, false, '偏了 3 格时不能报 arrived');
});

test('没有记录入口、只能退回最高脚点时不提前中止（也没有可指定的 id）', async (t) => {
  const w = new TestWorld();
  w.pos = { x: 0.5, y: 77, z: 0.5 };
  const memory = new WorldMemory(null);
  memory.setWorld(w.worldId);
  // U 形记录：从 y70 下到 y50 再爬回 y70，最后折到 y79；没有 entrances。
  save(memory, w, 'u-shape', [
    { x: 0, y: 70, z: 0 }, { x: 0, y: 66, z: 0 }, { x: 0, y: 62, z: 0 }, { x: 0, y: 58, z: 0 },
    { x: 0, y: 54, z: 0 }, { x: 0, y: 50, z: 0 }, { x: 0, y: 54, z: 0 }, { x: 0, y: 58, z: 0 },
    { x: 0, y: 62, z: 0 }, { x: 0, y: 66, z: 0 }, { x: 0, y: 70, z: 0 }, { x: 5, y: 74, z: 0 },
    { x: 10, y: 78, z: 0 }, { x: 10, y: 79, z: 0 },
  ], { x: 10, y: 79, z: 0 });
  // 抹掉入口记录：目标只能退回最高脚点。
  memory.savePassage({ ...memory.passages(w.dim).find((r) => r.id === 'u-shape')!, entrances: [] });
  const ctx = makeCtx(w, { memory });
  t.after(() => memory.close());
  const moves = t.mock.method(w, 'moveTo', async (goal: any) => { if (goal.kind === 'near') w.pos = { ...goal.pos }; });

  const result = await followPassage.run(ctx as never, { to: 'entrance' });

  assert.equal(result.status, 'succeeded', result.summary);
  assert.ok(moves.mock.callCount() > 0, '没有记录入口时要照常沿记录走，而不是拦下');
  assert.deepEqual(result.data?.resolvedIds ?? [], []);
});

test('显式 id 仍然能读到会被导航去重掉的重复记录', async (t) => {
  const w = new TestWorld();
  w.pos = { x: 0.5, y: 40, z: 0.5 };
  const memory = new WorldMemory(null);
  memory.setWorld(w.worldId);
  const path = (z: number) => [{ x: 0, y: 40, z }, { x: 4, y: 40, z }, { x: 8, y: 40, z }];
  const link = (ax: number, az: number, bx: number, bz: number) => ({ a: { x: ax, y: 40, z: az }, b: { x: bx, y: 40, z: bz } });
  memory.savePassage({ id: 'live-dup', worldId: w.worldId, dim: w.dim, kind: 'dug', entrances: [{ x: 8, y: 41, z: 0 }], deepestY: 40, dug: 8, ores: {}, createdAt: 0, lastUsedAt: 2, uses: 1, path: path(0), links: [link(0, 0, 4, 0), link(4, 0, 8, 0)] });
  memory.archivePassage({ id: 'archived-dup', worldId: w.worldId, dim: w.dim, kind: 'dug', entrances: [{ x: 8, y: 41, z: 1 }], deepestY: 40, dug: 8, ores: {}, createdAt: 0, lastUsedAt: 1, uses: 1, path: path(1), links: [link(0, 1, 4, 1), link(4, 1, 8, 1)] });
  const ctx = makeCtx(w, { memory });
  t.after(() => memory.close());
  const visited: Vec3Like[] = [];
  t.mock.method(w, 'moveTo', async (goal: any) => { if (goal.kind === 'near') { visited.push(goal.pos); w.pos = { ...goal.pos }; } });

  const result = await followPassage.run(ctx as never, { to: 'entrance', id: 'archived-dup' });

  assert.equal(result.status, 'succeeded', result.summary);
  assert.deepEqual(result.data?.resolvedTarget, { x: 8, y: 41, z: 1 }, '显式 id 选的是归档那条记录自己的入口');
  assert.ok(visited.length > 0);
});

test('长途 hop 仍保留 15 秒预算，不被短 hop 的收紧误伤', async (t) => {
  const w = new TestWorld();
  w.pos = { x: 0.5, y: 40, z: 0.5 };
  const memory = new WorldMemory(null);
  memory.setWorld(w.worldId);
  save(memory, w, 'long-hop', [{ x: 0, y: 40, z: 0 }, { x: 6, y: 40, z: 0 }, { x: 12, y: 40, z: 0 }], { x: 12, y: 41, z: 0 });
  const ctx = makeCtx(w, { memory });
  t.after(() => memory.close());
  const budgets: number[] = [];
  t.mock.method(w, 'moveTo', async (goal: any, opts: any) => {
    budgets.push(opts.timeoutMs);
    if (goal.kind === 'near') w.pos = { ...goal.pos };
  });

  const result = await followPassage.run(ctx as never, { to: 'entrance' });

  assert.equal(result.status, 'succeeded', result.summary);
  assert.ok(budgets.some((ms) => ms >= 15000), `6 格的 hop 应拿到 15s 预算：${budgets}`);
});

test('短途路点用更短的 moveTo 预算，不留给 A* 10 秒', async (t) => {
  const w = new TestWorld();
  w.pos = { x: 0.5, y: 40, z: 0.5 };
  const memory = new WorldMemory(null);
  memory.setWorld(w.worldId);
  save(memory, w, 'flat', [{ x: 0, y: 40, z: 0 }, { x: 4, y: 40, z: 0 }, { x: 8, y: 40, z: 0 }], { x: 8, y: 41, z: 0 });
  const ctx = makeCtx(w, { memory });
  t.after(() => memory.close());
  const budgets: number[] = [];
  t.mock.method(w, 'moveTo', async (goal: any, opts: any) => {
    budgets.push(opts.timeoutMs);
    if (goal.kind === 'near') w.pos = { ...goal.pos };
  });

  const result = await followPassage.run(ctx as never, { to: 'entrance' });

  assert.equal(result.status, 'succeeded', result.summary);
  assert.ok(budgets.every((ms) => ms <= 5000), `短途 hop 的预算应 ≤5000ms：${budgets}`);
});
