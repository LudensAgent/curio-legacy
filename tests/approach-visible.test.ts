import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoxelMap } from 'curio-minecraft-3d-memory';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { approachVisible } from '../src/skills/movement/index.ts';
import { SKILLS } from '../src/skills/index.ts';
import type { EntityInfo } from '../src/adapter/types.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const WORLD = 'fake-world', DIM = 'overworld', SESSION = 'fake-session';
let sequence = 0;

function fill(map: VoxelMap, name: string, cells: { x: number; y: number; z: number }[]) {
  for (const pos of cells) {
    sequence += 1;
    map.observe({
      worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: Date.now(), sequence,
      source: 'vision', evidence: 'seen', stateComplete: true, state: { name, properties: {} }, pos,
    });
  }
}

function flatMap(maxX = 5) {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  const air: { x: number; y: number; z: number }[] = [];
  for (let x = -1; x <= maxX; x++) for (let y = 64; y <= 66; y++) for (let z = -1; z <= 1; z++) air.push({ x, y, z });
  fill(map, 'minecraft:air', air);
  fill(map, 'minecraft:grass_block', Array.from({ length: maxX + 2 }, (_, x) => ({ x: x - 1, y: 63, z: 0 })));
  return map;
}

function fakeSpatial(map: VoxelMap) {
  return {
    worldId: WORLD,
    session: { voxel: map, history: { worldId: WORLD, getFragment: () => null, fragments: () => ({ items: [], total: 0 }) } },
    closing: false, paused: false, observationAdmitted: true,
    capabilities: () => ({
      owner: 'host_composed', contract: 'memory-host-contract/1',
      library: { execute: { walk: true } }, host: {},
      effective: { execute: { walk: true, groundedArrival: true, invalidation: true, cancellation: true } },
      overclaims: [],
    }),
  } as unknown as SharedSpatialSession;
}

function setup(map: VoxelMap, pos = { x: 0.3, y: 64, z: 0.2 }) {
  const adapter = new FakeAdapter();
  adapter.pos = { ...pos };
  adapter.worldId = WORLD;
  adapter.sessionId = SESSION;
  adapter.dim = DIM;
  return { adapter, ctx: { ...makeCtx(adapter), spatial: fakeSpatial(map) } };
}

test('approach_visible 已注册，且校验 target 三选一', () => {
  const w = new FakeAdapter();
  assert.equal(SKILLS.approach_visible, approachVisible);
  assert.equal(approachVisible.validate({ target: { pos: { x: 1, y: 64, z: 0 } } }, w).ok, true);
  assert.equal(approachVisible.validate({ target: { block: { x: 1, y: 64, z: 0 } } }, w).ok, true);
  assert.equal(approachVisible.validate({ target: { entity: { name: 'cow' } } }, w).ok, true);
  assert.equal(approachVisible.validate({ target: {} }, w).ok, false);
  assert.equal(approachVisible.validate({ target: { pos: { x: 0, y: 64, z: 0 }, block: { x: 1, y: 64, z: 0 } } }, w).ok, false);
});

test('approach_visible 从非格心起点接近一个位置，返回 ARRIVED 与实际位移', async (t) => {
  const { adapter, ctx } = setup(flatMap());
  t.after(() => ctx.memory.close());
  const r = await approachVisible.run(ctx, {
    target: { kind: 'position', pos: { x: 3.5, y: 64, z: 0.5 } },
    radius: 32, allowed: ['walk', 'step'], historical: true, maxSteps: 8, allowUnknownCorridor: false,
  });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.outcome, 'ARRIVED');
  assert.equal(Math.floor(adapter.pos.x), 3);
  assert.ok((r.data?.displacement as number) > 2);
  assert.ok(!adapter.actions.some((a) => /^dig:|^place:/.test(a)), '不挖/不放');
});

test('approach_visible 接近一个方块旁的合法站位，不改目标', async (t) => {
  const map = flatMap();
  const { adapter, ctx } = setup(map);
  adapter.blocks.push({ name: 'chest', pos: { x: 2, y: 64, z: 0 } });
  t.after(() => ctx.memory.close());
  const r = await approachVisible.run(ctx, {
    target: { kind: 'block', pos: { x: 2, y: 64, z: 0 } },
    radius: 32, allowed: ['walk', 'step'], historical: true, maxSteps: 8, allowUnknownCorridor: false,
  });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.outcome, 'ARRIVED');
  assert.deepEqual((r.data?.originalTarget as { kind: string }).kind, 'block');
  const pos = adapter.pos;
  assert.ok(Math.hypot(pos.x - 2.5, pos.z - 0.5) <= 1.8, `应停在方块旁：${JSON.stringify(pos)}`);
  assert.ok(!adapter.actions.some((a) => /^dig:|^place:/.test(a)), '不挖/不放');
});

test('approach_visible 接近一个已看见的实体，使用其脚下支撑的相邻站位', async (t) => {
  const map = flatMap();
  const { adapter, ctx } = setup(map);
  adapter.entities.push({ id: 7, name: 'cow', kind: 'passive', pos: { x: 2.5, y: 64, z: 0.5 } } as EntityInfo);
  t.after(() => ctx.memory.close());
  const r = await approachVisible.run(ctx, {
    target: { kind: 'entity', id: 7 },
    radius: 32, allowed: ['walk', 'step'], historical: true, maxSteps: 8, allowUnknownCorridor: false,
  });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.outcome, 'ARRIVED');
  assert.equal((r.data?.entity as EntityInfo | undefined)?.id, 7);
  assert.ok(Math.hypot(adapter.pos.x - 2.5, adapter.pos.z - 0.5) <= 2.5);
});

test('approach_visible 半径外目标返回 UNSUPPORTED，且不移动', async (t) => {
  const map = flatMap();
  const { adapter, ctx } = setup(map);
  adapter.blocks.push({ name: 'chest', pos: { x: 40, y: 64, z: 0 } });
  const before = { ...adapter.pos };
  t.after(() => ctx.memory.close());
  const r = await approachVisible.run(ctx, {
    target: { kind: 'block', pos: { x: 40, y: 64, z: 0 } },
    radius: 32, allowed: ['walk'], historical: true, maxSteps: 8, allowUnknownCorridor: false,
  });
  assert.equal(r.status, 'failed');
  assert.equal(r.data?.outcome, 'UNSUPPORTED');
  assert.deepEqual(adapter.pos, before);
});

test('approach_visible 空气方块目标按能力缺口拒绝', async (t) => {
  const map = flatMap();
  const { ctx } = setup(map);
  t.after(() => ctx.memory.close());
  const r = await approachVisible.run(ctx, {
    target: { kind: 'block', pos: { x: 2, y: 64, z: 0 } },
    radius: 32, allowed: ['walk'], historical: true, maxSteps: 8, allowUnknownCorridor: false,
  });
  assert.equal(r.status, 'failed');
  assert.equal(r.data?.outcome, 'UNSUPPORTED');
});
