import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MoveTarget } from '../src/adapter/types.ts';
import { passageRoute } from '../src/memory/passages.ts';
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
