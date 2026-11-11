import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exploreToward } from '../src/skills/movement/explore-toward.ts';
import { travelTo } from '../src/skills/movement/travel-to.ts';
import { voxelNavigationFixture } from './voxel-navigation-fixture.ts';

for (const [skill, revealAhead] of [['explore_toward', 7], ['travel_to', 7], ['explore_toward', 2]] as const) {
  test(`${skill} 离旧前沿 ${revealAhead} 格时才更新地图，也能接续移动`, async (t) => {
    const { adapter, map, ctx } = voxelNavigationFixture(8);
    t.after(() => ctx.memory.close());
    // 路面按行走时看到的区域分批进入地图。初始搜索无法计划到 40 格终点。
    let nextX = 9, sequence = 10000;
    const handoffs: { x: number; continuous: boolean }[] = [];
    const move = adapter.moveTo.bind(adapter);
    const body = Object.assign(adapter, { settleMovement: async () => {} });
    t.mock.method(body, 'moveTo', async (target, opts) => {
      assert.equal(target.kind, 'feet');
      handoffs.push({ x: target.x, continuous: opts.settleAtTarget === false });
      if (target.x >= nextX - revealAhead) {
        const end = Math.min(40, nextX + 7);
        for (; nextX <= end; nextX++) for (const y of [63, 64, 65]) map.observe({
          worldId: adapter.worldId, dim: adapter.dim, sessionId: adapter.sessionId,
          observedAt: Date.now(), sequence: ++sequence, source: 'vision', evidence: 'seen', stateComplete: true,
          state: { name: y === 63 ? 'minecraft:stone' : 'minecraft:air', properties: {} }, pos: { x: nextX, y, z: 0 },
        });
      }
      await move(target, opts);
    });
    let explicitLooks = 0;
    t.mock.method(adapter, 'look', async () => { explicitLooks++; });
    const result = skill === 'explore_toward'
      ? await exploreToward.run(ctx, { direction: 'E', distance: 40, segment: 16, maxLateralDrift: 4,
        timeoutMs: 60_000, origin: { ...adapter.pos } })
      : await travelTo.run(ctx, { to: { x: 41, y: 64, z: 0 }, range: 1, timeoutMs: 60_000 });
    assert.equal(result.status, 'succeeded', result.summary);
    assert.equal(handoffs.length, 40);
    assert.deepEqual(handoffs.filter(point => !point.continuous).map(point => point.x), [40.5],
      '只有原目的地需要完整刹停；已更新的前沿与 16/32 格窗口应直接交接');
    assert.equal(explicitLooks, 0);
    assert.deepEqual(adapter.pos, { x: 40.5, y: 64, z: 0.5 });
  });
}
