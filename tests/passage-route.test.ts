import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MoveTarget } from '../src/adapter/types.ts';
import { passageDeepestAnchor, passageNext, passageRoute, passageSurfaceAnchor } from '../src/memory/passages.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { goTo } from '../src/skills/movement.ts';
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
