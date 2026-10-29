import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Vec3Like } from '../src/adapter/types.ts';
import { FACINGS, localMap, toWorld } from '../src/perception/local.ts';
import { surroundings } from '../src/perception/surroundings.ts';
import { unstuck } from '../src/skills/movement.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

test('局部地图在各朝向列出已看见且有支撑的下一级脚部落点', () => {
  const pos = { x: 0, y: 64, z: 0 };
  const adapter = { blockAt: () => { throw new Error('不能用隐藏世界补全视觉'); } };
  for (const facing of FACINGS) {
    const observed = new Map([-2, -1, 0].map((up) => {
      const cell = toWorld(pos, facing, [1, up, 0]);
      return [`${cell.x},${cell.y},${cell.z}`, up === -2 ? 'stone' : 'air'];
    }));
    const map = localMap(adapter, pos, facing, (positions) => positions.flatMap((cell) => {
      const name = observed.get(`${cell.x},${cell.y},${cell.z}`);
      return name ? [{ pos: cell, name }] : [];
    }));
    assert.ok(map.spots.stand.includes('[1,-1,0] 前下1'), facing);
    assert.equal(map.layers['u-2'][1][2], 'S');
    assert.equal(map.layers['u-2'][0][2], '?', '没看见的下方格仍是未知');
    assert.ok(!map.spots.stand.some((spot) => spot.startsWith('[1,0,0]')), '下一级不冒充平走');
  }
});

test('下一级支撑未知、是液体或身体空间被挡时，局部地图不声称能站', () => {
  const pos = { x: 0, y: 64, z: 0 };
  const adapter = { blockAt: () => { throw new Error('不能用隐藏世界补全视觉'); } };
  for (const [support, head] of [[null, 'air'], ['water', 'air'], ['lava', 'air'], ['stone', 'stone']] as const) {
    const map = localMap(adapter, pos, 'N', (positions) => positions.flatMap((cell) => {
      if (cell.x !== 0 || cell.z !== -1) return [];
      const name = cell.y === 62 ? support : cell.y === 63 ? 'air' : cell.y === 64 ? head : null;
      return name ? [{ pos: cell, name }] : [];
    }));
    assert.ok(!map.spots.stand.some((spot) => spot.startsWith('[1,-1,0]')), `${support}/${head}`);
  }
});

test('周围出口分别描述平走、下一级和上一级，保留实际落点高度', () => {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.removed = new Set(['0,63,-1', '-1,63,0', '-1,62,0']);
  adapter.blocks.push({ name: 'stone', pos: { x: 0, y: 64, z: 1 } });
  const around = surroundings(adapter);
  assert.deepEqual(around.exitOptions.N, { walk: false, step_down: true, step_up: false });
  assert.deepEqual(around.exitOptions.E, { walk: true, step_down: false, step_up: false });
  assert.deepEqual(around.exitOptions.S, { walk: false, step_down: false, step_up: true });
  assert.deepEqual(around.exitOptions.W, { walk: false, step_down: false, step_up: false });
  assert.deepEqual(around.exits, ['N↓', 'E', 'S↑']);
  assert.match(around.text, /↓ 下一级/);
  assert.match(around.text, /W 下方有落差/);
});

test('周围出口保留未知支撑，不把下方液体当作可站的下一级', (t) => {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.removed.add('0,63,-1');
  const blockAt = adapter.blockAt.bind(adapter);
  let support: string | null = null;
  t.mock.method(adapter, 'blockAt', (pos: Vec3Like) => pos.x === 0 && pos.y === 62 && pos.z === -1 ? support : blockAt(pos));
  const unknown = surroundings(adapter);
  assert.equal(unknown.exitOptions.N.step_down, null);
  assert.equal(unknown.exitOptions.N.walk, false);
  assert.ok(!unknown.exits.includes('N↓'));
  assert.match(unknown.text, /N 下方未知/);
  for (const liquid of ['water', 'lava']) {
    support = liquid;
    const around = surroundings(adapter);
    assert.equal(around.exitOptions.N.step_down, false);
    assert.ok(!around.exits.includes('N↓'));
  }
});

test('现有脱困寻路能读取带下行箭头的出口方向', async (t) => {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.removed.add('0,63,-1');
  adapter.blocks.push(...[{ x: 1, y: 65, z: 0 }, { x: -1, y: 65, z: 0 }, { x: 0, y: 65, z: 1 }]
    .map((pos) => ({ name: 'stone', pos })));
  assert.deepEqual(surroundings(adapter).exits, ['N↓']);
  const ctx = makeCtx(adapter);
  t.after(() => ctx.memory.close());
  const move = t.mock.method(adapter, 'moveTo', async (target) => {
    assert.equal(target.kind, 'xz');
    if (target.kind === 'xz') {
      assert.equal(target.x, 0.5);
      assert.equal(target.z, -2.5);
      adapter.pos = { x: target.x, y: 63, z: target.z };
    }
  });
  const result = await unstuck.run(ctx, {});
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(move.mock.callCount(), 1);
});
