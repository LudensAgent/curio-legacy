import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoxelMap } from 'curio-minecraft-3d-memory';
import type { Vec3Like } from '../src/adapter/types.ts';
import { approachVisible } from '../src/skills/movement/index.ts';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const WORLD = 'perception-world', DIM = 'overworld', SESSION = 'perception-session';
type Cell = { x: number; y: number; z: number };

function fill(map: VoxelMap, name: string, cells: Cell[]) {
  let sequence = 0;
  for (const pos of cells) {
    map.observe({
      worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: Date.now(), sequence: sequence++,
      source: 'vision', evidence: 'seen', stateComplete: true, state: { name, properties: {} }, pos,
    });
  }
}

function flatMapWithoutTarget() {
  const air: Cell[] = [], floor: Cell[] = [];
  for (let x = -1; x <= 5; x++) for (let z = -1; z <= 1; z++) {
    // (2,64,0) 故意不观察：目标只在测试适配器的当前可见方块里。
    for (let y = 64; y <= 66; y++) if (!(x === 2 && y === 64 && z === 0)) air.push({ x, y, z });
    floor.push({ x, y: 63, z });
  }
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fill(map, 'minecraft:air', air);
  fill(map, 'minecraft:grass_block', floor);
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

test('目标只在当前感知、尚未写入 VoxelMap 时也能解析并接近', async (t) => {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.3, y: 64, z: 0.2 };
  adapter.worldId = WORLD; adapter.sessionId = SESSION; adapter.dim = DIM;
  // 目标方块只存在于当前适配器的可见方块里；共享地图没有这一格。
  adapter.blocks.push({ name: 'oak_log', pos: { x: 2, y: 64, z: 0 } });
  const map = flatMapWithoutTarget();
  assert.equal(map.cellAt(DIM, 2, 64, 0).observed, false);

  const ctx = { ...makeCtx(adapter), spatial: fakeSpatial(map) };
  t.after(() => ctx.memory.close());
  const validated = approachVisible.validate({ target: { block: { x: 2, y: 64, z: 0 } }, radius: 8 }, adapter);
  assert.ok(validated.ok, validated.ok ? '' : validated.error);
  const r = await approachVisible.run(ctx, validated.args);
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.outcome, 'ARRIVED');
  const evidence = r.data?.evidence as { target?: { source?: string; name?: string } } | undefined;
  assert.equal(evidence?.target?.source, 'current_perception');
  assert.equal(evidence?.target?.name, 'oak_log');
  // 接近只移动身体，不改目标方块，也不写未经感知的地图内容。
  assert.ok(!adapter.actions.some((action) => /^dig:|^place:/.test(action)), adapter.actions.join(','));
  assert.equal(map.cellAt(DIM, 2, 64, 0).observed, false);
});

test('只有方向/距离、目标格未被当前感知时不会编造方块', async (t) => {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.3, y: 64, z: 0.2 };
  adapter.worldId = WORLD; adapter.sessionId = SESSION; adapter.dim = DIM;
  const map = flatMapWithoutTarget();
  const ctx = { ...makeCtx(adapter), spatial: fakeSpatial(map) };
  t.after(() => ctx.memory.close());
  const validated = approachVisible.validate({ target: { block: { x: 2, y: 64, z: 0 } }, radius: 8 }, adapter);
  assert.ok(validated.ok, validated.ok ? '' : validated.error);
  const r = await approachVisible.run(ctx, validated.args);
  assert.equal(r.status, 'failed', r.summary);
  assert.match(r.summary, /未加载\/未观察/);
  assert.equal(r.data?.outcome, 'UNKNOWN');
  assert.equal(r.data?.displacement, 0);
  assert.equal(r.data?.evidenceSource, 'unobserved');
});
