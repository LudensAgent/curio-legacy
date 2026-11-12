import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exploreToward } from '../src/skills/movement/explore-toward.ts';
import { travelTo } from '../src/skills/movement/travel-to.ts';
import { voxelNavigationFixture } from './voxel-navigation-fixture.ts';

/** 走廊到 x=3；x=4..9 是 depth 格深的水（水面 y=63），x=10..24 是对岸陆地，都已观察。 */
function lakeFixture(depth = 3) {
  const fixture = voxelNavigationFixture(3);
  const { adapter, map } = fixture;
  let sequence = 70_000;
  const observe = (x: number, y: number, z: number, name: string) => map.observe({
    worldId: adapter.worldId, dim: adapter.dim, sessionId: adapter.sessionId, observedAt: Date.now(), sequence: ++sequence,
    source: 'vision', evidence: 'seen', stateComplete: true, state: { name: `minecraft:${name}`, properties: {} }, pos: { x, y, z },
  });
  for (let x = 4; x <= 24; x++) for (let z = -1; z <= 1; z++) {
    const lake = x <= 9;
    for (let y = 59; y <= 63; y++) {
      const name = !lake ? 'stone' : y > 63 - depth ? 'water' : 'stone';
      observe(x, y, z, name);
      if (name === 'water') adapter.blocks.push({ name: 'water', pos: { x, y, z } });
    }
    observe(x, 64, z, 'air');
    observe(x, 65, z, 'air');
  }
  return fixture;
}

test('swim:true 时在水边游到沿原方向已观察的对岸，再继续陆路完成方向距离', async (t) => {
  const { adapter, ctx } = lakeFixture();
  t.after(() => ctx.memory.close());
  const fractions: number[] = [];
  ctx.progress = (fraction) => { fractions.push(fraction); };
  const r = await exploreToward.run(ctx, { direction: 'E', distance: 16, segment: 16, maxLateralDrift: 1,
    timeoutMs: 60_000, origin: { ...adapter.pos }, swim: true });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.ok(fractions.some((f) => f > 0), `游泳/陆路推进期间进度更新：${fractions}`);
  assert.ok(fractions.every((f, i) => i === 0 || f >= fractions[i - 1]!), `进度只增不减：${fractions}`);
  const legs = r.data?.swimLegs as { mode: string; target: { x: number }; status: string }[];
  assert.ok(legs?.length >= 1, '回执记录代为游泳的段');
  assert.equal(legs[0]!.mode, 'dry_shore');
  assert.ok(legs[0]!.target.x >= 10, '目标是对岸站立格');
  assert.ok(adapter.actions.some((action) => action.startsWith('swim:')));
  assert.ok(adapter.pos.x >= 16.5);
  assert.match(r.summary, /代为游泳/);
});

test('默认不下水：同一片水前停下，不发游泳动作', async (t) => {
  const { adapter, ctx } = lakeFixture();
  t.after(() => ctx.memory.close());
  const r = await exploreToward.run(ctx, { direction: 'E', distance: 16, segment: 16, maxLateralDrift: 1,
    timeoutMs: 60_000, origin: { ...adapter.pos } });
  assert.notEqual(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.swimLegs, undefined);
  assert.ok(!adapter.actions.some((action) => action.startsWith('swim:')));
  assert.ok(adapter.pos.x < 4.5, '没有进入水域');
});

test('swim:true 时一格深的水直接涉水走过，不需要游泳', async (t) => {
  const { adapter, ctx } = lakeFixture(1);
  t.after(() => ctx.memory.close());
  const r = await exploreToward.run(ctx, { direction: 'E', distance: 16, segment: 16, maxLateralDrift: 1,
    timeoutMs: 60_000, origin: { ...adapter.pos }, swim: true });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.swimLegs, undefined);
  assert.ok(!adapter.actions.some((action) => action.startsWith('swim:')));
});

test('travel_to swim:true 横渡深水到对岸目标', async (t) => {
  const { adapter, ctx } = lakeFixture();
  t.after(() => ctx.memory.close());
  const r = await travelTo.run(ctx, { to: { x: 14, y: 64, z: 0 }, range: 1, timeoutMs: 60_000, swim: true });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.ok(((r.data?.swimLegs as unknown[] | undefined)?.length ?? 0) >= 1, '回执记录代为游泳的段');
  assert.ok(Math.abs(adapter.pos.x - 14.5) <= 1.5);
});
