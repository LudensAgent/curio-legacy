import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoxelMap } from 'curio-minecraft-3d-memory';
import type { Vec3Like } from '../src/adapter/types.ts';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import type { Senses, SkillCtx } from '../src/skills/types.ts';
import { approachVisible } from '../src/skills/movement/index.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const WORLD = 'fake-world', DIM = 'overworld', SESSION = 'fake-session';

function fakeSpatial(map: VoxelMap) {
  return {
    worldId: WORLD,
    session: { voxel: map, history: { worldId: WORLD, getFragment: () => null, fragments: () => ({ items: [], total: 0 }) } },
    query: (q: { kind: string }) => q.kind === 'fragments'
      ? { status: 'ok', data: { kind: 'fragments', items: [], total: 0 } }
      : { status: 'ok', data: null },
    closing: false, paused: false, observationAdmitted: true,
    capabilities: () => ({ owner: 'host_composed', contract: 'memory-host-contract/2', library: {}, host: { execute: { walk: true, groundedArrival: true, invalidation: true, cancellation: true } },
      effective: { execute: { walk: true, groundedArrival: true, invalidation: true, cancellation: true } }, overclaims: [] }),
  } as unknown as SharedSpatialSession;
}

function setup(senses: Partial<Senses> = {}) {
  const adapter = new FakeAdapter();
  adapter.worldId = WORLD; adapter.sessionId = SESSION; adapter.dim = DIM;
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx: SkillCtx = { ...makeCtx(adapter, { senses: { observeBlocks: () => [], effectiveRange: () => 64, ...senses } }), spatial: fakeSpatial(new VoxelMap(WORLD, { validityWindowMs: 60_000 })) };
  return { adapter, ctx };
}

const argsOf = (raw: unknown) => {
  const parsed = approachVisible.validate(raw, new FakeAdapter());
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  return parsed.args;
};

test('approach_visible 校验：landmark 目标与 backend 选项，规范化后再校验不变', () => {
  const lm = approachVisible.validate({ target: { landmark: 'base' }, backend: 'spatial' }, new FakeAdapter());
  assert.ok(lm.ok);
  assert.deepEqual(lm.args.target, { kind: 'landmark', name: 'base' });
  assert.equal(lm.args.backend, 'spatial');
  assert.equal(approachVisible.validate({ target: { landmark: 'base' }, backend: 'pathfinder' }, new FakeAdapter()).ok, false);
  assert.deepEqual(approachVisible.validate(lm.args, new FakeAdapter()), lm);
  assert.equal(argsOf({ target: { pos: { x: 1, y: 64, z: 0 } } }).backend, 'spatial', '默认仍是共享空间记忆后端');
  assert.ok(!approachVisible.validate({ target: { pos: { x: 1, y: 64, z: 0 } }, backend: 'auto' }, new FakeAdapter()).ok);
});

test('已识别方块仍需体素路线证据，不借旧后端跨过未知区域', async () => {
  const { adapter, ctx } = setup({ recognizedAt: (p: Vec3Like) => p.x === 20 && p.y === 64 && p.z === 0 ? 'chest' : null });
  adapter.blocks.push({ name: 'chest', pos: { x: 20, y: 64, z: 0 } });
  const r = await approachVisible.run(ctx, argsOf({ target: { block: { x: 20, y: 64, z: 0 } }, backend: 'spatial' }));
  assert.equal(r.status, 'failed', r.summary);
  assert.equal(r.data?.backend, 'spatial');
  assert.equal(r.data?.targetEvidence, 'recognized');
  assert.equal(r.data?.outcome, 'UNKNOWN');
  assert.ok(!adapter.actions.some((a) => a.startsWith('moveTo:')));
  assert.ok(!adapter.actions.some((a) => /^dig:|^place:/.test(a)));
});

test('没看见过的方块不接近', async () => {
  const { adapter, ctx } = setup();
  const r = await approachVisible.run(ctx, argsOf({ target: { block: { x: 20, y: 64, z: 0 } }, backend: 'spatial' }));
  assert.equal(r.failureCode, 'NOT_FOUND');
  assert.ok(!adapter.actions.some((a) => a.startsWith('moveTo:')));
});

test('landmark 目标按记忆解析成位置；记不得就不动', async () => {
  const { adapter, ctx } = setup();
  ctx.memory.addLandmark('waypoint', '矿洞口', DIM, { x: 12, y: 64, z: 0 });
  const r = await approachVisible.run(ctx, argsOf({ target: { landmark: '矿洞口' }, backend: 'spatial' }));
  assert.equal(r.status, 'failed', r.summary);
  assert.deepEqual((r.data?.landmark as { pos: Vec3Like }).pos, { x: 12, y: 64, z: 0 });
  assert.ok(!adapter.actions.some((a) => a.startsWith('moveTo:')));

  const none = setup();
  const missing = await approachVisible.run(none.ctx, argsOf({ target: { landmark: '不存在' } }));
  assert.equal(missing.failureCode, 'NOT_FOUND');
  assert.ok(!none.adapter.actions.some((a) => a.startsWith('moveTo:')));
});

test('把空气格当方块目标：回执给出下方支撑与可用写法，不自动改选', async () => {
  const { adapter, ctx } = setup({ observeBlocks: (ps: Vec3Like[]) => ps.map((p) => ({ name: 'air', properties: {}, pos: p, worldId: WORLD, sessionId: SESSION, dimension: DIM, observationId: 1, observedAt: Date.now(), source: 'vision' as const })) });
  const r = await approachVisible.run(ctx, argsOf({ target: { block: { x: 3, y: 64, z: 0 } } }));
  assert.equal(r.failureCode, 'BAD_ARGS');
  assert.deepEqual((r.data?.supportBelow as { pos: Vec3Like }).pos, { x: 3, y: 63, z: 0 });
  assert.match(r.summary, /"pos":\{"x":3,"y":64,"z":0\}/);
  assert.ok(!adapter.actions.some((a) => a.startsWith('moveTo:')));
});
