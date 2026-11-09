import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GameAdapter, MoveTarget, Vec3Like } from '../src/adapter/types.ts';
import { SKILLS } from '../src/skills/index.ts';
import { exploreToward } from '../src/skills/movement/explore-toward.ts';
import type { SkillCtx } from '../src/skills/types.ts';

function harness(options: { blocked?: (goal: MoveTarget, from: Vec3Like) => boolean; bricksFromX?: number } = {}) {
  let pos: Vec3Like = { x: 0.5, y: 64, z: 0.5 };
  const goals: MoveTarget[] = [];
  const looks: number[] = [];
  const adapter = {
    state: () => ({ pos: { ...pos }, dim: 'overworld', worldId: 'w', alive: true, connected: true, riding: null }),
    eye: () => ({ x: pos.x, y: pos.y + 1.62, z: pos.z, yaw: 0, pitch: 0 }),
    async look(yaw: number) { looks.push(yaw); },
    resolveBlockNames: (n: string) => [n],
    async moveTo(target: MoveTarget) {
      goals.push(target);
      if (options.blocked?.(target, pos)) throw new Error('No path');
      if (target.kind === 'xz') pos = { x: target.x + 0.5, y: pos.y, z: target.z + 0.5 };
    },
    recentDug: () => [], recentPlaced: () => [],
  } as unknown as GameAdapter;
  const bricks = { name: 'nether_bricks', pos: { x: 90, y: 64, z: 0 } };
  const visible = () => options.bricksFromX !== undefined && pos.x >= options.bricksFromX;
  const senses = {
    refresh() {}, markSweep() {}, perceivedEntities: () => [],
    knownBlocks: (names: string[]) => visible() && names.includes(bricks.name) ? [{ ...bricks, dist: 10 }] : [],
    observeBlocks: (ps: Vec3Like[]) => visible() ? ps.map((p) => ({ name: bricks.name, pos: p })) : [],
  };
  let chunks = 0;
  const memory = { get visitedChunkCount() { return chunks += 1; }, lastDeath: () => null, findLandmark: () => undefined };
  const ctx = { adapter, senses, memory, signal: new AbortController().signal, deadline: Date.now() + 120_000, progress() {} } as unknown as SkillCtx;
  return { adapter, ctx, goals, looks, at: () => pos };
}

const argsOf = (raw: unknown, adapter: GameAdapter) => {
  const parsed = exploreToward.validate(raw, adapter);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  return parsed.args;
};

test('explore_toward 注册；方向冻结起点、校验幂等，超限拒绝不缩短', () => {
  assert.equal(SKILLS.explore_toward, exploreToward);
  const { adapter } = harness();
  const parsed = exploreToward.validate({ direction: 'e', distance: 300 }, adapter);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.args.origin, { x: 0.5, y: 64, z: 0.5 });
  assert.deepEqual(exploreToward.validate(parsed.args, adapter), parsed);
  const over = exploreToward.validate({ direction: 'E', distance: 600 }, adapter);
  assert.ok(!over.ok && /不会被缩短/.test(over.error));
  assert.ok(!exploreToward.validate({ direction: 'UP', distance: 100 }, adapter).ok);
});

test('explore_toward 沿冻结方向分段走完并每段朝该方向扫视；回执报沿方向进度与新区块', async () => {
  const h = harness();
  const r = await exploreToward.run(h.ctx, argsOf({ direction: 'E', distance: 64 }, h.adapter));
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.stopReason, 'DISTANCE_MET');
  assert.ok(h.goals.every((g) => g.kind === 'xz' && Math.abs(g.z) <= 1), '目标都在冻结射线上');
  assert.ok((r.data?.segmentCount as number) >= 2);
  assert.ok(h.looks.length >= 2 * 5, '每段结束朝探索方向扫视');
  assert.equal(r.data?.backend, 'pathfinder');
  assert.ok((r.data?.progress as { along: number }).along >= 62);
  assert.ok(typeof r.data?.newChunks === 'number');
});

test('explore_toward 的 until 只认本次视野看见的，看见就停', async () => {
  const h = harness({ bricksFromX: 30 });
  const r = await exploreToward.run(h.ctx, argsOf({ direction: 'E', distance: 200, until: 'nether_bricks' }, h.adapter));
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.stopReason, 'UNTIL_SEEN');
  assert.ok(h.at().x < 100, '看见就停，不走完全程');
  assert.deepEqual((r.data?.sighting as { foundPos: Vec3Like }).foundPos, { x: 90, y: 64, z: 0 });
});

test('explore_toward 连续几段走不通就停，只报辅助走不通', async () => {
  const h = harness({ blocked: () => true });
  const r = await exploreToward.run(h.ctx, argsOf({ direction: 'N', distance: 100 }, h.adapter));
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'STUCK');
  assert.equal(r.data?.stopReason, 'BLOCKED');
  assert.match(r.summary, /不描述没看见的地形/);
});
