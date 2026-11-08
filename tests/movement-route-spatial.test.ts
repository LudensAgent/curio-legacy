import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoxelMap } from 'curio-minecraft-3d-memory';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { clearRouteRecords, planRoute } from '../src/skills/movement/index.ts';
import { SKILLS } from '../src/skills/index.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const WORLD = 'fake-world', DIM = 'overworld', SESSION = 'fake-session';
const at = (x: number, y: number, z: number) => ({ x, y, z });

let sequence = 0;
const BASE_TIME = Date.now();
function fill(map: VoxelMap, name: string, cells: { x: number; y: number; z: number }[], properties: Record<string, string> = {}) {
  for (const pos of cells) {
    sequence += 1;
    map.observe({
      worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: BASE_TIME + sequence, sequence,
      source: 'vision', evidence: 'seen', stateComplete: true,
      state: { name, properties }, pos,
    });
  }
}

function fillBox(map: VoxelMap, name: string, min: { x: number; y: number; z: number }, max: { x: number; y: number; z: number }) {
  const cells: { x: number; y: number; z: number }[] = [];
  for (let x = min.x; x <= max.x; x++) for (let y = min.y; y <= max.y; y++) for (let z = min.z; z <= max.z; z++) cells.push(at(x, y, z));
  fill(map, name, cells);
}

function fakeSpatial(map: VoxelMap) {
  return {
    worldId: WORLD,
    session: {
      voxel: map,
      history: { worldId: WORLD, getFragment: () => null, fragments: () => ({ items: [], total: 0 }) },
    },
    closing: false, paused: false, observationAdmitted: true,
    attach: () => ({}), detach: () => {},
  } as unknown as SharedSpatialSession;
}

function ctxAt(map: VoxelMap, pos: { x: number; y: number; z: number }) {
  const w = new FakeAdapter();
  w.pos = { ...pos };
  w.worldId = WORLD;
  w.sessionId = SESSION;
  w.dim = DIM;
  return { w, ctx: { ...makeCtx(w), spatial: fakeSpatial(map) } };
}

function flatWorld() {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(-1, 0, -1), at(4, 2, 1));
  fill(map, 'minecraft:stone', [at(0, -1, 0), at(1, -1, 0), at(2, -1, 0), at(3, -1, 0)]);
  return map;
}

test('plan_route source:"spatial" 返回现有 move_step 步骤，不新增动作、不发 routeId', async (t) => {
  const map = flatWorld();
  const { w, ctx } = ctxAt(map, at(0.5, 0, 0.5));
  t.after(() => ctx.memory.close());
  clearRouteRecords();
  const r = await planRoute.run(ctx, { to: at(3, 0, 0), mode: 'walk', source: 'spatial', arrival: { kind: 'exact' } });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.source, 'spatial');
  assert.equal(r.data?.routeId, undefined);
  const steps = r.data?.steps as { skill: string; args: Record<string, unknown> }[];
  assert.ok(Array.isArray(steps) && steps.length > 0);
  assert.ok(steps.every((step) => step.skill === 'move_step' || step.skill === 'descend_to'));
  assert.ok(steps.every((step) => !!SKILLS[step.skill]), '步骤只能使用现有动作');
  const transitions = r.data?.transitions as { from: { x: number; y: number; z: number } }[];
  steps.forEach((step, index) => {
    w.pos = { ...transitions[index]!.from };
    const validated = SKILLS[step.skill]!.validate(step.args, w);
    assert.equal(validated.ok, true, `${step.skill} 参数应通过现有动作校验：${JSON.stringify(step.args)} ${JSON.stringify(validated)}`);
  });
  assert.deepEqual(w.actions, [], 'plan_route 只读，不移动');
});

test('plan_route source:"spatial" 对 1 格台阶生成 move_step', async (t) => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(-1, 0, -1), at(3, 3, 1));
  fill(map, 'minecraft:stone', [at(0, -1, 0), at(1, -1, 0), at(1, 0, 0)]);
  const { ctx } = ctxAt(map, at(0.5, 0, 0.5));
  t.after(() => ctx.memory.close());
  clearRouteRecords();
  const r = await planRoute.run(ctx, { to: at(1, 1, 0), mode: 'walk', source: 'spatial', arrival: { kind: 'exact' } });
  assert.equal(r.status, 'succeeded', r.summary);
  const steps = r.data?.steps as { skill: string; args: Record<string, unknown> }[];
  assert.deepEqual(steps.map((step) => step.skill), ['move_step']);
  const transitions = r.data?.transitions as { kind: string }[];
  assert.deepEqual(transitions.map((transition) => transition.kind), ['step']);
});

test('plan_route source:"spatial" 对 2 格下落生成 descend_to', async (t) => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fillBox(map, 'minecraft:air', at(-1, 0, -1), at(3, 4, 1));
  fill(map, 'minecraft:stone', [at(0, 1, 0), at(0, -1, 0), at(1, -1, 0)]);
  const { ctx } = ctxAt(map, at(0.5, 2, 0.5));
  t.after(() => ctx.memory.close());
  clearRouteRecords();
  const r = await planRoute.run(ctx, { to: at(1, 0, 0), mode: 'walk', source: 'spatial', arrival: { kind: 'exact' } });
  assert.equal(r.status, 'succeeded', r.summary);
  const steps = r.data?.steps as { skill: string; args: Record<string, unknown> }[];
  assert.deepEqual(steps.map((step) => step.skill), ['descend_to']);
  const transitions = r.data?.transitions as { kind: string; drop: number }[];
  assert.equal(transitions[0]?.drop, 2);
  assert.ok(SKILLS.descend_to, 'descend_to 是现有 L2 动作');
});

test('plan_route source:"auto" 在没有历史查询端口时使用 spatial', async (t) => {
  const map = flatWorld();
  const { ctx } = ctxAt(map, at(0.5, 0, 0.5));
  t.after(() => ctx.memory.close());
  clearRouteRecords();
  const r = await planRoute.run(ctx, { to: at(3, 0, 0), mode: 'walk', source: 'auto', arrival: { kind: 'exact' } });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.source, 'spatial');
});

test('plan_route source:"auto" 目标脚高变化且 spatial 无路时，不回退到同高 search', async (t) => {
  const map = flatWorld();
  const { ctx } = ctxAt(map, at(0.5, 0, 0.5));
  t.after(() => ctx.memory.close());
  clearRouteRecords();
  const r = await planRoute.run(ctx, { to: at(3, 1, 0), mode: 'walk', source: 'auto', arrival: { kind: 'exact' } });
  assert.equal(r.status, 'failed');
  assert.doesNotMatch(r.summary, /this walk planner|fixed feet height/, '目标换层时不再调用必然失败的同高 search');
  assert.match(r.summary, /目标脚高 1 与当前 0 不同|不能表示换层/);
  assert.equal(r.data?.heightChange, 1);
  assert.ok(Array.isArray(r.data?.boundaries), '保留空间 3D 的边界事实');
});

test('plan_route source:"search" 仍明确报告固定脚高能力边界', async (t) => {
  const map = flatWorld();
  const { ctx } = ctxAt(map, at(0.5, 0, 0.5));
  t.after(() => ctx.memory.close());
  clearRouteRecords();
  const r = await planRoute.run(ctx, { to: at(3, 1, 0), mode: 'walk', source: 'search', arrival: { kind: 'exact' } });
  assert.equal(r.status, 'failed');
  assert.match(r.summary, /fixed feet height 0/);
});

test('plan_route source:"spatial" 严格无路时用历史体素给出带 UNKNOWN 标记的候选路线', async (t) => {
  const map = flatWorld();
  map.markStale(DIM, 'expired');
  const { ctx } = ctxAt(map, at(0.5, 0, 0.5));
  t.after(() => ctx.memory.close());
  clearRouteRecords();
  const r = await planRoute.run(ctx, { to: at(3, 0, 0), mode: 'walk', source: 'spatial', arrival: { kind: 'exact' } });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.evidenceMode, 'historical');
  assert.equal(r.data?.assurance, 'historical_geometry');
  assert.equal(r.data?.currentPassability, 'UNKNOWN');
  assert.match(r.summary, /历史体素路线/);
  assert.match(r.summary, /当前可通行性未知/);
  const verification = r.data?.verification as { verdict?: string; openPrefix?: number } | undefined;
  assert.notEqual(verification?.verdict, 'OPEN', '历史路线必须暴露它不是当前已验证的 OPEN 路线');
  const steps = r.data?.steps as { skill: string; args: Record<string, unknown> }[] | undefined;
  assert.ok(steps?.length, '历史路线仍应给出可逐步执行的现有动作');
  assert.ok(steps.every((step) => !!SKILLS[step.skill]));
});

test('plan_route source:"spatial" 无法确认时返回边界事实，不伪造 steps', async (t) => {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  fill(map, 'minecraft:stone', [at(0, -1, 0)]);
  const { ctx } = ctxAt(map, at(0.5, 0, 0.5));
  t.after(() => ctx.memory.close());
  clearRouteRecords();
  const r = await planRoute.run(ctx, { to: at(3, 0, 0), mode: 'walk', source: 'spatial', arrival: { kind: 'exact' } });
  assert.equal(r.status, 'failed');
  assert.deepEqual(r.data?.steps, []);
  assert.ok(Array.isArray(r.data?.boundaries));
});
