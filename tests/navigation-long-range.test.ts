/**
 * B5 长程场景探针：512 格跨 TTL。
 *
 * 地图证据在测试开始时已全部过期；navigate_to 只能先用 remembered 几何拿候选，
 * 在执行前按当前证据停下，并通过 Coordinator 的有界边界观察刷新相关格后继续。
 * 这不是实机验收，也不证明连续 8 小时负载；它检查宿主能否在原目标/原期限下
 * 跨多个 TTL 窗口滚动推进到 512 格。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoxelMap } from 'curio-minecraft-3d-memory';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { navigateTo } from '../src/skills/movement/navigate.ts';
import type { BlockObservation, Vec3Like } from '../src/adapter/types.ts';
import type { Senses, SkillCtx, SkillResult } from '../src/skills/types.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const WORLD = 'fake-world', DIM = 'overworld', SESSION = 'fake-session';
const TARGET = { x: 512, y: 64, z: 0 };

let sequence = 0;

/** 一条 0..xMax 的已观察平地；证据窗口短于整段行程，测试开始时全部已过期。 */
function staleFlatMap(xMax: number) {
  const map = new VoxelMap(WORLD, { validityWindowMs: 10_000 });
  const observedAt = Date.now() - 20_000;
  for (let x = -1; x <= xMax; x++) for (let z = -1; z <= 1; z++) for (let y = 63; y <= 65; y++) {
    map.observe({
      worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt, sequence: ++sequence,
      source: 'vision', evidence: 'seen', stateComplete: true,
      state: { name: y === 63 ? 'stone' : 'air', properties: {} }, pos: { x, y, z },
    });
  }
  return map;
}

function fakeSpatial(map: VoxelMap) {
  return {
    worldId: WORLD,
    session: {
      voxel: map,
      history: { worldId: WORLD, getFragment: () => null, fragments: () => ({ items: [], total: 0 }) },
    },
    closing: false, paused: false, observationAdmitted: true,
    capabilities: () => ({
      owner: 'host_composed', contract: 'memory-host-contract/2',
      library: {}, host: { execute: { walk: true, groundedArrival: true, invalidation: true, cancellation: true } },
      effective: { execute: { walk: true, groundedArrival: true, invalidation: true, cancellation: true } },
      overclaims: [],
    }),
    attach: () => ({}),
    detach: () => {},
  } as unknown as SharedSpatialSession;
}

/** 模拟生产 Vision：把这次合法观察写入同一张 VoxelMap，再返回观测。 */
function observingSenses(adapter: FakeAdapter, map: VoxelMap): Partial<Senses> {
  return {
    observeBlocks: (positions: Vec3Like[]): BlockObservation[] => positions.flatMap((pos) => {
      const name = adapter.blockAt(pos);
      if (name === null) return [];
      const observation = {
        worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: Date.now(), sequence: ++sequence,
        source: 'vision' as const, evidence: 'seen' as const, stateComplete: true,
        state: { name: name.replace(/^minecraft:/, ''), properties: {} }, pos: { ...pos },
      };
      map.observe(observation);
      return [{
        ...observation,
        observationId: sequence,
        dimension: DIM,
        properties: {},
        name,
      }];
    }),
  };
}

test('512 格目标跨 TTL 滚动推进到原目标', { timeout: 300_000 }, async (t) => {
  const map = staleFlatMap(TARGET.x + 1);
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.worldId = WORLD;
  adapter.sessionId = SESSION;
  adapter.dim = DIM;
  adapter.speed = 100_000;
  const senses = observingSenses(adapter, map);
  const ctx: SkillCtx = {
    ...makeCtx(adapter, { deadlineMs: 280_000, senses }),
    spatial: fakeSpatial(map),
  };
  t.after(() => ctx.memory.close());
  // 生产 Perception/Vision 在移动中持续观察前方视锥；这里在每次调用前刷新
  // 当前站位与前方一段有界视角，避免把“测试没有运行 Perception”误判为导航不能跨 TTL。
  const refreshView = () => {
    const startX = Math.floor(adapter.pos.x) - 1;
    const cells: Vec3Like[] = [];
    for (let x = startX; x <= startX + 40; x++) {
      for (const y of [63, 64, 65]) cells.push({ x, y, z: 0 });
    }
    const feet = { x: Math.floor(adapter.pos.x), y: Math.floor(adapter.pos.y), z: Math.floor(adapter.pos.z) };
    cells.push(feet, { ...feet, y: feet.y + 1 }, { ...feet, y: feet.y - 1 });
    senses.observeBlocks!(cells);
  };

  const base = {
    to: TARGET, allowed: ['walk', 'step'] as ('walk' | 'step')[],
    historical: true, maxSteps: 64,
    maxSegments: 16, maxTransitions: 1024, maxSearches: 32,
    maxObservations: 8, maxObservedCells: 512,
  };

  let sessionId: string | undefined;
  let calls = 0;
  let executed = 0;
  let lastCumulative = 0;
  const sessionIds = new Set<string>();
  const stops: string[] = [];
  let result: SkillResult | null = null;
  while (calls < 128) {
    calls += 1;
    refreshView();
    const validated = navigateTo.validate({ ...base, ...(sessionId === undefined ? {} : { sessionId }) }, adapter);
    assert.ok(validated.ok, validated.ok ? '' : validated.error);
    result = await navigateTo.run(ctx, validated.args);
    const data = result.data as Record<string, unknown> | undefined;
    // executed 是 session 累计值，只能累加差值；失败分支的 executed:0 不参与累计。
    const cumulative = Number(data?.executed ?? 0);
    if (Number.isInteger(cumulative) && cumulative >= lastCumulative) {
      executed += cumulative - lastCumulative;
      lastCumulative = cumulative;
    }
    const stop = (data?.stop as { reason?: string } | undefined)?.reason;
    if (stop !== undefined) stops.push(stop);
    if (result.status === 'succeeded') break;
    const continuation = data?.continuation as { canContinue?: boolean; sessionId?: string } | undefined;
    // 必须始终续接同一份预算账本；不能因为某次无进展就新建 session 重置预算。
    if (continuation?.canContinue !== true || continuation.sessionId === undefined) {
      assert.fail(`原 session 不可续接（stop=${stop ?? 'none'}，calls=${calls}，executed=${executed}）；不能靠新建 session 重置预算`);
    }
    sessionIds.add(continuation.sessionId);
    sessionId = continuation.sessionId;
    if (result.status === 'cancelled') break;
  }

  assert.equal(result?.status, 'succeeded', `512 格应真实到达；calls=${calls} executed=${executed} stops=${stops.join(',')}`);
  assert.equal(Math.floor(adapter.pos.x), TARGET.x, `实测脚位应落在目标格；实际 ${adapter.pos.x}`);
  assert.ok(executed >= 500, `确认段数应覆盖几乎整段；实际 ${executed}`);
  assert.ok(calls > 1, '512 格必须跨多次调用滚动推进，不能靠一次未验证的长搜索');
  assert.ok(stops.length > 0, '跨 TTL 行程必须留下真实的段/预算停止事实');
  assert.equal(sessionIds.size, 1, `整段行程必须使用同一个 session 预算；实际 ${[...sessionIds].join(',')}`);
});

test('历史搜索预算耗尽时报告 search_budget，不冒充未知边界', async (t) => {
  const map = staleFlatMap(17);
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.worldId = WORLD;
  adapter.sessionId = SESSION;
  adapter.dim = DIM;
  const ctx: SkillCtx = { ...makeCtx(adapter, { deadlineMs: 10_000 }), spatial: fakeSpatial(map) };
  t.after(() => ctx.memory.close());

  const validated = navigateTo.validate({
    to: { x: 16, y: 64, z: 0 }, allowed: ['walk'], historical: true,
    maxNodes: 1, maxSegments: 1, maxSteps: 16,
  }, adapter);
  assert.ok(validated.ok, validated.ok ? '' : validated.error);
  const result = await navigateTo.run(ctx, validated.args);
  assert.equal(result.status, 'failed');
  assert.equal((result.data?.stop as { reason?: string } | undefined)?.reason, 'BUDGET_EXHAUSTED');
  assert.equal(result.data?.budget, 'nodes', '预算原因来自历史搜索，而不是被 strict 的证据不足覆盖');
});
