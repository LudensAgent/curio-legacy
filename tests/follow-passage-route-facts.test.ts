import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Vec3Like } from '../src/adapter/types.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { followPassage } from '../src/skills/movement.ts';
import { makeCtx, TestWorld } from './survival-helpers.ts';

/** 把记录脚点变成可站的通道：脚/头是空气、下方是实心，供短 hop 预检读取。 */
const carve = (w: TestWorld, path: Vec3Like[]) => {
  for (const p of path) {
    const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
    w.setBlock({ x, y: y + 1, z }, 'air');
    w.setBlock({ x, y, z }, 'air');
    w.setBlock({ x, y: y - 1, z }, 'stone');
  }
};

const save = (memory: WorldMemory, w: TestWorld, id: string, path: Vec3Like[], entrance: Vec3Like) => {
  carve(w, path);
  memory.savePassage({ id, worldId: w.worldId, dim: w.dim, kind: 'dug', entrances: [entrance],
    deepestY: Math.min(...path.map((p) => p.y)), dug: 30, ores: {}, createdAt: 0, lastUsedAt: 0, uses: 1, path });
};

// 2026-11-05 现场形状：从 y77 下到 y50 再爬回 y79 的入口，段数多、下潜深。
const detour: Vec3Like[] = [
  { x: 0, y: 77, z: 0 }, { x: 0, y: 74, z: 0 }, { x: -1, y: 70, z: 0 }, { x: -2, y: 66, z: 0 },
  { x: -3, y: 62, z: 0 }, { x: -4, y: 58, z: 0 }, { x: -5, y: 54, z: 0 }, { x: -6, y: 50, z: 0 },
  { x: -7, y: 54, z: 0 }, { x: -8, y: 58, z: 0 }, { x: -9, y: 62, z: 0 }, { x: -10, y: 66, z: 0 },
  { x: -11, y: 70, z: 0 }, { x: -12, y: 74, z: 0 }, { x: -12, y: 79, z: 0 },
];

test('回入口的绕行没有更便宜出口时照常走，并在回执里给出路线事实', async (t) => {
  const w = new TestWorld();
  w.pos = { x: 0.5, y: 77, z: 0.5 };
  const memory = new WorldMemory(null);
  memory.setWorld(w.worldId);
  save(memory, w, 'psg_detour', detour, { x: -12, y: 81, z: 0 });
  // 同分量另有一条更长但不下潜的记录出口：代价明显更高，不值得为它中断。
  const flat: Vec3Like[] = [];
  for (let x = 0; x <= 70; x += 5) flat.push({ x, y: 77, z: 0 });
  save(memory, w, 'psg_flat', flat, { x: 70, y: 77, z: 0 });
  const ctx = makeCtx(w, { memory });
  t.after(() => memory.close());
  const moves = t.mock.method(w, 'moveTo', async (goal: any) => { if (goal.kind === 'near') w.pos = { ...goal.pos }; });

  const result = await followPassage.run(ctx as never, { to: 'entrance' });

  assert.equal(result.status, 'succeeded', result.summary);
  assert.ok(moves.mock.callCount() > 0, '没有明显更便宜的出口时应该沿这条记录走');
  const facts = result.data?.routeFacts as { segments: number; dip: number; minY: number; pathLength: number };
  assert.ok(facts.segments >= 8);
  assert.ok(facts.pathLength >= 24, '路线事实的门槛是路长 >=24 且下潜 >=8');
  assert.equal(facts.minY, 50);
  assert.equal(facts.dip, 27);
  assert.equal(result.data?.alternatives, undefined, '没有中断就不给中止回执');
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

test('寻路把身体抬高 4 格：不报地形高度差，如实报 offRoute 与起点/终点/路点', async (t) => {
  const w = new TestWorld();
  w.pos = { x: 0.5, y: 40, z: 0.5 };
  const memory = new WorldMemory(null);
  memory.setWorld(w.worldId);
  save(memory, w, 'flat', [{ x: 0, y: 40, z: 0 }, { x: 4, y: 40, z: 0 }, { x: 8, y: 40, z: 0 }], { x: 8, y: 41, z: 0 });
  const ctx = makeCtx(w, { memory });
  t.after(() => memory.close());
  const goals: { kind?: string }[] = [];
  t.mock.method(w, 'moveTo', async (goal: any) => {
    goals.push(goal);
    if (goal.kind === 'near') {
      // 像实测那样：寻路为了到达 x/z 从矿道爬上去 4 格，然后报错。
      w.pos = { x: goal.pos.x, y: 44, z: goal.pos.z };
      throw new Error('No path');
    }
    w.pos = { x: goal.x, y: 44, z: goal.z };
  });

  const result = await followPassage.run(ctx as never, { to: 'entrance' });

  assert.equal(result.status, 'failed');
  assert.equal(result.data?.offRoute, true);
  assert.doesNotMatch(result.summary, /高度差/);
  assert.match(result.summary, /从 \(0\.5,40\.0,0\.5\) 到记录点 \(4,40,0\) 没走到；寻路把我带到 \(4\.0,44\.0,0\.0\)（偏离记录路线）/);
  assert.match(result.summary, /dig:true/);
  assert.deepEqual(result.data?.initialPosition, { x: 0.5, y: 40, z: 0.5 });
  assert.deepEqual(result.data?.blockedWaypoint, { x: 4, y: 40, z: 0 });
  assert.deepEqual(result.data?.position, { x: 4, y: 44, z: 0 });
  assert.ok(goals.every((g) => g.kind === 'near'), '失败后不得再用 xz 兜底');
});

test('同列的竖直偏差也报 offRoute：区分记录点与实际高度，并给 dig:true', async (t) => {
  const w = new TestWorld();
  w.pos = { x: 0.5, y: 40, z: 0.5 };
  const memory = new WorldMemory(null);
  memory.setWorld(w.worldId);
  save(memory, w, 'flat', [{ x: 0, y: 40, z: 0 }, { x: 4, y: 40, z: 0 }, { x: 8, y: 40, z: 0 }], { x: 8, y: 41, z: 0 });
  const ctx = makeCtx(w, { memory });
  t.after(() => memory.close());
  // 同列只到得了 y46，记录点在 y40 的竖井下面。
  t.mock.method(w, 'moveTo', async (goal: any) => {
    if (goal.kind === 'near') {
      w.pos = { x: goal.pos.x, y: 46, z: goal.pos.z };
      throw new Error('No path');
    }
    w.pos = { x: goal.x, y: 46, z: goal.z };
  });

  const result = await followPassage.run(ctx as never, { to: 'entrance' });

  assert.equal(result.status, 'failed');
  assert.equal(result.data?.offRoute, true);
  assert.doesNotMatch(result.summary, /记录点在你下方 6 格/);
  assert.match(result.summary, /同一列只到得了另一个高度（记录点 y=40，实际 y=46\.0）/);
  assert.match(result.summary, /descend\/climb_up/);
  assert.match(result.summary, /dig:true.*会消耗背包方块和工具耐久/);
  assert.ok(result.data?.sameColumnReachedAt);
});

test('同一列 ≤1 格高度偏差算有界本地修正，不中止整条路', async (t) => {
  const w = new TestWorld();
  w.pos = { x: 0.5, y: 40, z: 0.5 };
  const memory = new WorldMemory(null);
  memory.setWorld(w.worldId);
  save(memory, w, 'flat', [0, 4, 8, 12, 16].map((x) => ({ x, y: 40, z: 0 })), { x: 16, y: 41, z: 0 });
  const ctx = makeCtx(w, { memory });
  t.after(() => memory.close());
  // near 永远报错，但身体最终落在记录点同一列、只低 1 格：允许作为本地修正。
  t.mock.method(w, 'moveTo', async (goal: any) => {
    if (goal.kind === 'near') {
      w.pos = { x: goal.pos.x, y: goal.pos.y - 1, z: goal.pos.z };
      throw new Error('No path');
    }
    w.pos = { x: goal.x, y: goal.pos.y - 1, z: goal.z };
  });

  const result = await followPassage.run(ctx as never, { to: 'entrance' });

  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.rescueCount, 4, '每段都记一次本地修正，但路线照常走完');
  assert.equal((result.data?.arrival as { satisfied: boolean }).satisfied, true);
});

test('系统性 3 格 y 偏差不再靠 xz 兜底成功：如实报 offRoute', async (t) => {
  const w = new TestWorld();
  w.pos = { x: 0.5, y: 40, z: 0.5 };
  const memory = new WorldMemory(null);
  memory.setWorld(w.worldId);
  save(memory, w, 'flat', [0, 4, 8, 12, 16].map((x) => ({ x, y: 40, z: 0 })), { x: 16, y: 41, z: 0 });
  const ctx = makeCtx(w, { memory });
  t.after(() => memory.close());
  const goals: { kind?: string }[] = [];
  t.mock.method(w, 'moveTo', async (goal: any) => {
    goals.push(goal);
    if (goal.kind === 'near') {
      w.pos = { x: goal.pos.x, y: 37, z: goal.pos.z };
      throw new Error('No path');
    }
    w.pos = { x: goal.x, y: 37, z: goal.z };
  });

  const result = await followPassage.run(ctx as never, { to: 'entrance' });

  assert.equal(result.status, 'failed');
  assert.equal(result.data?.offRoute, true, '3 格偏差超出本地修正，必须如实报偏离');
  assert.doesNotMatch(result.summary, /走完了记下的/);
  assert.ok(goals.every((g) => g.kind === 'near'), '3 格偏差不能靠全局 xz 兜底走完');
});

test('没有记录入口、只能退回最高脚点时不提前中止（也没有可指定的 id）', async (t) => {
  const w = new TestWorld();
  w.pos = { x: 0.5, y: 77, z: 0.5 };
  const memory = new WorldMemory(null);
  memory.setWorld(w.worldId);
  // U 形记录：从 y70 下到 y50 再爬回 y70，最后折到 y79；没有 entrances。
  const uPath = [
    { x: 0, y: 70, z: 0 }, { x: 0, y: 66, z: 0 }, { x: 0, y: 62, z: 0 }, { x: 0, y: 58, z: 0 },
    { x: 0, y: 54, z: 0 }, { x: 0, y: 50, z: 0 }, { x: 0, y: 54, z: 0 }, { x: 0, y: 58, z: 0 },
    { x: 0, y: 62, z: 0 }, { x: 0, y: 66, z: 0 }, { x: 0, y: 70, z: 0 }, { x: 5, y: 74, z: 0 },
    { x: 10, y: 78, z: 0 }, { x: 10, y: 79, z: 0 },
  ];
  carve(w, uPath);
  save(memory, w, 'u-shape', uPath, { x: 10, y: 79, z: 0 });
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
  carve(w, [...path(0), ...path(1)]);
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

test('长途 hop 保留原来的 20 秒预算，不被短 hop 的收紧误伤', async (t) => {
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
  assert.ok(budgets.some((ms) => ms >= 20000), `6 格的 hop 应拿到 20s 预算：${budgets}`);
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

test('短 hop 的目标脚格被堵：不调用 moveTo，零位移并点名格子与 dig:true', async (t) => {
  const w = new TestWorld();
  w.pos = { x: 0.5, y: 40, z: 0.5 };
  const memory = new WorldMemory(null);
  memory.setWorld(w.worldId);
  save(memory, w, 'flat', [{ x: 0, y: 40, z: 0 }, { x: 4, y: 40, z: 0 }, { x: 8, y: 40, z: 0 }], { x: 8, y: 41, z: 0 });
  // 第二个路点的脚格是石头：预检应直接拒绝，不交给全局寻路。
  w.setBlock({ x: 4, y: 40, z: 0 }, 'stone');
  const ctx = makeCtx(w, { memory });
  t.after(() => memory.close());
  const moves = t.mock.method(w, 'moveTo', async (goal: any) => { if (goal.kind === 'near') w.pos = { ...goal.pos }; });

  const result = await followPassage.run(ctx as never, { to: 'entrance' });

  assert.equal(result.status, 'failed');
  assert.equal(result.data?.offRoute, undefined, '零位移不是 offRoute');
  assert.match(result.summary, /脚格 \(4,40,0\) 是 stone/);
  assert.match(result.summary, /未调用寻路/);
  assert.match(result.summary, /dig:true.*会消耗背包方块和工具耐久/);
  assert.match(result.summary, /descend\/climb_up/);
  assert.match(result.summary, /换路/);
  assert.deepEqual(result.data?.blockedWaypoint, { x: 4, y: 40, z: 0 });
  const cells = result.data?.blockedCells as { role: string; cell: Vec3Like; block: string }[];
  assert.ok(cells.some((c) => c.role === '脚格' && c.cell.x === 4 && c.block === 'stone'));
  assert.equal(moves.mock.callCount(), 0, '预检失败不得调用 moveTo');
  assert.deepEqual(w.pos, { x: 0.5, y: 40, z: 0.5 }, '身体没有位移');
});

test('短 hop 的目标格未观测（null）时不当成阻塞，交给 moveTo 实测', async (t) => {
  const w = new TestWorld();
  w.pos = { x: 0.5, y: 40, z: 0.5 };
  const memory = new WorldMemory(null);
  memory.setWorld(w.worldId);
  save(memory, w, 'flat', [{ x: 0, y: 40, z: 0 }, { x: 4, y: 40, z: 0 }, { x: 8, y: 40, z: 0 }], { x: 8, y: 41, z: 0 });
  // 第二个路点的脚格、头格、支撑格都未加载/未观测：未知不是“已确认被堵”。
  const original = w.blockAt.bind(w);
  t.mock.method(w, 'blockAt', (pos: Vec3Like) => pos.x === 4 && pos.y >= 39 && pos.y <= 41 ? null : original(pos));
  const ctx = makeCtx(w, { memory });
  t.after(() => memory.close());
  const goals: Vec3Like[] = [];
  t.mock.method(w, 'moveTo', async (goal: any) => {
    if (goal.kind === 'near') { goals.push(goal.pos); w.pos = { ...goal.pos }; }
  });

  const result = await followPassage.run(ctx as never, { to: 'entrance' });

  assert.equal(result.status, 'succeeded', result.summary);
  assert.ok(goals.some((p) => p.x === 4 && p.y === 40), '未知格子应交给 moveTo 实测');
  assert.equal(result.data?.blockedWaypoint, undefined, '未观测不得报成 blockedWaypoint');
  assert.doesNotMatch(result.summary, /未加载/);
});

test('第 1 个路点不可达、第 2 个可达：跳过一次并记录 skippedWaypoints', async (t) => {
  const w = new TestWorld();
  w.pos = { x: 0.5, y: 40, z: 0.5 };
  const memory = new WorldMemory(null);
  memory.setWorld(w.worldId);
  save(memory, w, 'flat', [{ x: 0, y: 40, z: 0 }, { x: 3, y: 40, z: 0 }, { x: 6, y: 40, z: 0 }, { x: 9, y: 40, z: 0 }], { x: 9, y: 41, z: 0 });
  const ctx = makeCtx(w, { memory });
  t.after(() => memory.close());
  const goals: { kind?: string; pos?: Vec3Like }[] = [];
  t.mock.method(w, 'moveTo', async (goal: any) => {
    goals.push(goal);
    if (goal.kind !== 'near') return;
    if (goal.pos.x === 3) throw new Error('No path');
    w.pos = { ...goal.pos };
  });

  const result = await followPassage.run(ctx as never, { to: 'entrance' });

  assert.equal(result.status, 'succeeded', result.summary);
  assert.deepEqual(result.data?.skippedWaypoints, [{ x: 3, y: 40, z: 0 }]);
  assert.match(result.summary, /跳过了不可达路点 \(3,40,0\)/);
  assert.ok(goals.some((g) => g.kind === 'near' && g.pos?.x === 6), '应尝试跳到下一个路点');
  assert.ok(goals.every((g) => g.kind === 'near'), '跳过也不是 xz 全局兜底');
});

test('人不在通道内、路线起点在下方：先走到地表入口锚点，再从实际位置路由', async (t) => {
  const w = new TestWorld();
  w.pos = { x: 0.5, y: 64, z: 3.5 };
  const memory = new WorldMemory(null);
  memory.setWorld(w.worldId);
  const p = (x: number, y: number, z: number) => ({ x, y, z });
  const A = p(0, 60, 0), N1 = p(8, 64, 0), E1 = p(20, 64, 0), N3 = p(20, 64, -50), N4 = p(8, 64, -50), E2 = p(8, 64, -8);
  const link = (a: Vec3Like, b: Vec3Like) => ({ a, b });
  // E1 沿记录网最便宜（所以是目标）；E2 水平离身体更近但路网代价高，作为入口锚点。
  memory.savePassage({
    id: 'approach-mine', worldId: w.worldId, dim: w.dim, kind: 'dug', entrances: [E1, E2], deepestY: 60, dug: 20, ores: {}, createdAt: 0, lastUsedAt: 0, uses: 1,
    path: [A, N1, E1, N3, N4, E2], links: [link(A, N1), link(N1, E1), link(E1, N3), link(N3, N4), link(N4, E2)],
  });
  const ctx = makeCtx(w, { memory });
  t.after(() => memory.close());
  const calls: { goal: any; opts: any }[] = [];
  t.mock.method(w, 'moveTo', async (goal: any, opts: any) => {
    calls.push({ goal, opts });
    if (goal.kind === 'near') w.pos = { ...goal.pos };
  });

  const result = await followPassage.run(ctx as never, { to: 'entrance' });

  assert.equal(result.status, 'succeeded', result.summary);
  assert.deepEqual(result.data?.resolvedTarget, E1, '目标仍是记录网最便宜的地表入口');
  assert.equal(calls.length > 1, true, '走到入口锚点后还要沿重算的路线继续走');
  assert.deepEqual(calls[0]?.goal.pos, E2, '先走到 24 格内水平最近的地表入口锚点');
  assert.equal(calls[0]?.opts.allowTerrainChanges, undefined, '接入口只走路，不带 dig');
  assert.equal(calls[0]?.opts.allowPlace, undefined, '接入口只走路，不带 place');
  assert.ok(calls.some((c) => c.goal.pos?.x === E1.x && c.goal.pos?.y === E1.y), '重算路线最终走向原目标');
});
