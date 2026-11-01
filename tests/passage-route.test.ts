import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MoveTarget, Vec3Like } from '../src/adapter/types.ts';
import { passageDeepestAnchor, passageNext, passageRoute, passageSurfaceAnchor } from '../src/memory/passages.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { followPassage, goTo } from '../src/skills/movement.ts';
import { makeCtx, TestWorld } from './survival-helpers.ts';

// 一条 L 形矿道：从 (0,40,0) 往东到 (12,40,0)，再往南到 (12,40,12)；另一条从 (12,40,6) 往东岔出去
const main = { path: [{ x: 0, y: 40, z: 0 }, { x: 3, y: 40, z: 0 }, { x: 6, y: 40, z: 0 }, { x: 9, y: 40, z: 0 }, { x: 12, y: 40, z: 0 }, { x: 12, y: 40, z: 3 }, { x: 12, y: 40, z: 6 }, { x: 12, y: 40, z: 9 }, { x: 12, y: 40, z: 12 }] };
const branch = { path: [{ x: 14, y: 40, z: 6 }, { x: 17, y: 40, z: 6 }, { x: 20, y: 40, z: 6 }] };

test('沿记下的脚下点找路：同一条里前后相邻、不同条挨得近的点连起来', () => {
  const r = passageRoute([main, branch], { x: 0.5, y: 40, z: 0.5 }, { x: 20, y: 40, z: 6 })!;
  assert.deepEqual(r.map((p) => `${p.x},${p.z}`), ['0,0', '3,0', '6,0', '9,0', '12,0', '12,3', '12,6', '14,6', '17,6', '20,6']);
  assert.equal(passageRoute([main], { x: 0, y: 40, z: 0 }, { x: 50, y: 40, z: 50 }), null, '目标离通道太远');
  assert.equal(passageRoute([main], { x: 0, y: 80, z: 0 }, { x: 12, y: 40, z: 12 }), null, '自己离通道太远');
});

test('有 links 的通道：路由只沿真实走过的边，不因 ≤3.5 而几何抄近道', () => {
  const rec = {
    path: [] as Vec3Like[],
    links: [
      { a: { x: 0, y: 40, z: 0 }, b: { x: 1, y: 40, z: 0 } },
      { a: { x: 1, y: 40, z: 0 }, b: { x: 2, y: 40, z: 0 } },
      { a: { x: 2, y: 40, z: 0 }, b: { x: 3, y: 40, z: 0 } },
    ],
  };
  // (0,40,0) 和 (3,40,0) 直线相距 3（≤ link=3.5），但没走过这条边：路由应沿 0→1→2→3，不抄近道
  const r = passageRoute([rec], { x: 0, y: 40, z: 0 }, { x: 3, y: 40, z: 0 });
  assert.deepEqual(r!.map((p) => `${p.x},${p.z}`), ['0,0', '1,0', '2,0', '3,0']);
});

test('goto does not detour through historical passage points to reach a nearby lower target', async (t) => {
  const w = new TestWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  const memory = new WorldMemory(null);
  memory.setWorld(w.worldId);
  const xs = Array.from({ length: 21 }, (_, i) => i * 5);
  const path = [...xs.map((x) => ({ x, y: 64, z: 0 })), ...[...xs].reverse().map((x) => ({ x, y: 57, z: 0 }))];
  const target = { x: 0, y: 57, z: 0 };
  memory.savePassage({ id: 'p1', worldId: w.worldId, dim: w.dim, entrances: [], deepestY: 57, dug: 30, ores: {}, createdAt: 0, lastUsedAt: 0, uses: 1, path });
  assert.ok(passageRoute(memory.passages(w.dim), w.pos, target)?.some((point) => point.x === 100), 'the old route would take a 100-block horizontal detour');
  const ctx = makeCtx(w, { memory });
  t.after(() => memory.close());
  const moves: MoveTarget[] = [];
  const moveTo = w.moveTo.bind(w);
  t.mock.method(w, 'moveTo', async (goal, options) => { moves.push(goal); await moveTo(goal, options); });

  const result = await goTo.run(ctx, { target: '0,57,0', dig: true });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.deepEqual(moves, [{ kind: 'near', pos: target, range: 0 }], 'navigate toward the requested target without a historical route prelude');
  assert.doesNotMatch(result.summary, /沿自己挖过的通道/);
});

test('碎片化通道：站在接不回地表的支巷里，把全部通道连成网后仍能给出通向地表的下一步', () => {
  // 主竖井：地表 y64 一路下到 y32；支巷：在井底 y40 横向岔出去、最远 10 格，自己没记入口
  const shaft = { path: [{ x: 0, y: 64, z: 0 }, { x: 0, y: 60, z: 0 }, { x: 0, y: 56, z: 0 }, { x: 0, y: 52, z: 0 }, { x: 0, y: 48, z: 0 }, { x: 0, y: 44, z: 0 }, { x: 0, y: 40, z: 0 }, { x: 0, y: 36, z: 0 }, { x: 0, y: 32, z: 0 }], entrances: [{ x: 0, y: 66, z: 0 }] };
  const branch = { path: [{ x: 2, y: 40, z: 0 }, { x: 6, y: 40, z: 0 }, { x: 10, y: 40, z: 0 }], entrances: [] };
  const here = { x: 10, y: 40, z: 0 };
  // 单条支巷自己最高只有 y40，走不回地表
  assert.ok(passageRoute([branch], here, { x: 2, y: 40, z: 0 })!.every((p) => p.y === 40), '单条支巷的路线到不了地表');
  // 全网锚点取到主竖井的地表入口，路线一路回到 y64
  const anchor = passageSurfaceAnchor([shaft, branch], here);
  assert.deepEqual(anchor, { x: 0, y: 66, z: 0 });
  assert.ok(passageRoute([shaft, branch], here, anchor!)!.some((p) => p.y >= 64), '连网后的路线通到地表');
  const g = passageNext([shaft, branch], here, anchor!);
  assert.ok(g, '连网后能给出下一步');
  assert.deepEqual(g!.next, { x: 6, y: 40, z: 0 });
  assert.equal(g!.inside, true);
  // 下更深则取全网最深的脚点
  assert.deepEqual(passageDeepestAnchor([shaft, branch]), { x: 0, y: 32, z: 0 });
});

test('follow_passage 沿旧矿道逐段走回入口（碎片连成网）', async (t) => {
  const w = new TestWorld();
  w.pos = { x: 10, y: 40, z: 0 };
  const memory = new WorldMemory(null);
  memory.setWorld(w.worldId);
  const save = (id: string, entrances: Vec3Like[], path: Vec3Like[]) =>
    memory.savePassage({ id, worldId: w.worldId, dim: w.dim, kind: 'dug', entrances, deepestY: Math.min(...path.map((p) => p.y)), dug: 30, ores: {}, createdAt: 0, lastUsedAt: 0, uses: 1, path });
  // 主竖井（地表→深）+ 支巷（井底岔出、没记入口）
  save('shaft', [{ x: 0, y: 66, z: 0 }], [{ x: 0, y: 64, z: 0 }, { x: 0, y: 60, z: 0 }, { x: 0, y: 56, z: 0 }, { x: 0, y: 52, z: 0 }, { x: 0, y: 48, z: 0 }, { x: 0, y: 44, z: 0 }, { x: 0, y: 40, z: 0 }, { x: 0, y: 36, z: 0 }, { x: 0, y: 32, z: 0 }]);
  save('branch', [], [{ x: 2, y: 40, z: 0 }, { x: 6, y: 40, z: 0 }, { x: 10, y: 40, z: 0 }]);
  const ctx = makeCtx(w, { memory });
  t.after(() => memory.close());
  const visited: Vec3Like[] = [];
  t.mock.method(w, 'moveTo', async (goal: any) => {
    if (goal.kind === 'near') { visited.push(goal.pos); w.pos = { x: goal.pos.x, y: goal.pos.y, z: goal.pos.z }; }
  });
  const result = await followPassage.run(ctx, { to: 'entrance' });
  assert.equal(result.status, 'succeeded', result.summary);
  // 支巷 → 竖井 → 一路回到地表脚点
  assert.ok(visited.some((p) => p.y >= 64), `走过的路点应该通到地表，实际最高 y${Math.max(...visited.map((p) => p.y))}`);
  assert.deepEqual(visited[0], { x: 6, y: 40, z: 0 }, '先从支巷往里走回竖井');
  assert.deepEqual(visited[visited.length - 1], { x: 0, y: 64, z: 0 }, '最后走到竖井顶部');
});

test('follow_passage 离矿道远时先走到最近脚点接回网里，再沿路由走', async (t) => {
  const w = new TestWorld();
  w.pos = { x: 50, y: 30, z: 0 };
  const memory = new WorldMemory(null);
  memory.setWorld(w.worldId);
  // 只有一条孤立支巷，且 agent 站得离它很远（超过 near）
  memory.savePassage({ id: 'branch', worldId: w.worldId, dim: w.dim, kind: 'dug', entrances: [], deepestY: 40, dug: 4, ores: {}, createdAt: 0, lastUsedAt: 0, uses: 1, path: [{ x: 2, y: 40, z: 0 }, { x: 6, y: 40, z: 0 }, { x: 10, y: 40, z: 0 }] });
  const ctx = makeCtx(w, { memory });
  t.after(() => memory.close());
  const visited: Vec3Like[] = [];
  t.mock.method(w, 'moveTo', async (goal: any) => {
    if (goal.kind === 'near') { visited.push(goal.pos); w.pos = { x: goal.pos.x, y: goal.pos.y, z: goal.pos.z }; }
  });
  const result = await followPassage.run(ctx, { to: 'entrance' });
  assert.equal(result.status, 'succeeded', result.summary);
  // 先接到最近的脚点 (10,40,0)，再沿支巷走回地表参考点 (2,40,0)
  assert.deepEqual(visited[0], { x: 10, y: 40, z: 0 }, '先走到最近的脚点接回网里');
  assert.deepEqual(visited[visited.length - 1], { x: 2, y: 40, z: 0 }, '最后走到地表参考点');
});

test('follow_passage dig:true 在上台阶时先挖开头顶再迈', async (t) => {
  const w = new TestWorld();
  w.pos = { x: 0, y: 40, z: 0 };
  const memory = new WorldMemory(null);
  memory.setWorld(w.worldId);
  // 一条 1 格上台阶的旧矿道：links 记真实相邻格对，入口在台阶顶
  memory.savePassage({
    id: 'p1', worldId: w.worldId, dim: w.dim, kind: 'dug',
    entrances: [{ x: 1, y: 42, z: 0 }],
    deepestY: 40, dug: 30, ores: {}, createdAt: 0, lastUsedAt: 0, uses: 1,
    path: [{ x: 0, y: 40, z: 0 }, { x: 1, y: 41, z: 0 }],
    links: [{ a: { x: 0, y: 40, z: 0 }, b: { x: 1, y: 41, z: 0 } }],
  });
  const ctx = makeCtx(w, { memory });
  t.after(() => memory.close());
  const digs: Vec3Like[] = [];
  t.mock.method(w, 'dig', async (pos: Vec3Like) => { digs.push(pos); w.setBlock(pos, 'air'); return { ok: true }; });
  t.mock.method(w, 'moveTo', async (goal: any) => { if (goal.kind === 'near') w.pos = { x: goal.pos.x, y: goal.pos.y, z: goal.pos.z }; });
  const result = await followPassage.run(ctx, { to: 'entrance', dig: true });
  assert.equal(result.status, 'succeeded', result.summary);
  // 起跳头顶 (0,42,0) 和新头 (1,42,0) 都要先挖开（2 格高隧道里跳不上去）
  assert.ok(digs.some((d) => d.x === 0 && d.y === 42 && d.z === 0), `挖了起跳头顶 (0,42,0)：${JSON.stringify(digs)}`);
  assert.ok(digs.some((d) => d.x === 1 && d.y === 42 && d.z === 0), `挖了新头 (1,42,0)：${JSON.stringify(digs)}`);
});

test('follow_passage 无 dig 在上台阶被头顶挡时停下并提示 dig:true', async (t) => {
  const w = new TestWorld();
  w.pos = { x: 0, y: 40, z: 0 };
  const memory = new WorldMemory(null);
  memory.setWorld(w.worldId);
  memory.savePassage({
    id: 'p1', worldId: w.worldId, dim: w.dim, kind: 'dug',
    entrances: [{ x: 1, y: 42, z: 0 }],
    deepestY: 40, dug: 30, ores: {}, createdAt: 0, lastUsedAt: 0, uses: 1,
    path: [{ x: 0, y: 40, z: 0 }, { x: 1, y: 41, z: 0 }],
    links: [{ a: { x: 0, y: 40, z: 0 }, b: { x: 1, y: 41, z: 0 } }],
  });
  const ctx = makeCtx(w, { memory });
  t.after(() => memory.close());
  const digs: Vec3Like[] = [];
  t.mock.method(w, 'dig', async (pos: Vec3Like) => { digs.push(pos); w.setBlock(pos, 'air'); return { ok: true }; });
  const result = await followPassage.run(ctx, { to: 'entrance' });
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'PATH_NOT_FOUND');
  assert.match(result.summary, /可加 dig:true/);
  assert.equal(digs.length, 0, '没授权 dig 不挖');
});

test('follow_passage 接不到矿道（moveTo 过不去）时报失败', async (t) => {
  const w = new TestWorld();
  w.pos = { x: 50, y: 30, z: 0 };
  const memory = new WorldMemory(null);
  memory.setWorld(w.worldId);
  memory.savePassage({ id: 'branch', worldId: w.worldId, dim: w.dim, kind: 'dug', entrances: [], deepestY: 40, dug: 4, ores: {}, createdAt: 0, lastUsedAt: 0, uses: 1, path: [{ x: 2, y: 40, z: 0 }, { x: 6, y: 40, z: 0 }, { x: 10, y: 40, z: 0 }] });
  const ctx = makeCtx(w, { memory });
  t.after(() => memory.close());
  t.mock.method(w, 'moveTo', async () => { throw new Error('No path'); });
  const result = await followPassage.run(ctx, { to: 'entrance' });
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'PATH_NOT_FOUND');
});

test('goto cannot use old passage points to bypass missing visual navigation', async (t) => {
  const w = new TestWorld();
  w.pos = { x: 0.5, y: 40, z: 0.5 };
  const ctx = makeCtx(w, { senses: { navigationWaypoint: () => null, rememberedWaypoint: () => null } });
  t.after(() => ctx.memory.close());
  ctx.memory.setWorld(w.worldId);
  ctx.memory.savePassage({ id: 'p1', worldId: w.worldId, dim: w.dim, entrances: [], deepestY: 40, dug: 30, ores: {}, createdAt: 0, lastUsedAt: 0, uses: 1, ...main });
  const move = t.mock.method(w, 'moveTo', w.moveTo.bind(w));

  const result = await goTo.run(ctx, { target: '12,40,12' });
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'PATH_NOT_FOUND');
  assert.match(result.summary, /眼前没有可确认的通路/);
  assert.equal(move.mock.callCount(), 0);
  assert.deepEqual(result.data?.position, { x: 0.5, y: 40, z: 0.5 });
});
