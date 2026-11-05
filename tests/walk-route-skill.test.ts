import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Vec3 } from 'vec3';
import { SKILLS } from '../src/skills/index.ts';
import { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { walkRoute } from '../src/skills/walk-route.ts';
import { walkKnownRoute, walkTo } from '../src/skills/spatial-navigation.ts';
import { runSkill } from '../src/skills/types.ts';
import type { BlockObservation, GameAdapter } from '../src/adapter/types.ts';

const require = createRequire(import.meta.url);
const data = require('minecraft-data')('1.20.1');
const Block = require('prismarine-block')(data);
const { Physics, PlayerState } = require('prismarine-physics');

test('walk_route 已注册并可校验点列', () => {
  assert.equal(SKILLS.walk_route, walkRoute);
  const v = walkRoute.validate({ points: [[0.5, 0, 0.5], [1.5, 0, 0.5]] }, {} as never);
  assert.ok(v.ok);
  const bad = walkRoute.validate({ points: [[0.5, 0, 0.5], [1.5, 1, 0.5]] }, {} as never);
  assert.ok(!bad.ok, '同高要求');
});

test('walk_route 失败也保留原请求、解析目标与唯一后端', async () => {
  const points = [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }];
  const ctx = {
    adapter: { walkBody: () => undefined },
    senses: {}, deadline: Date.now() + 1000, signal: new AbortController().signal, taskId: 'no-spatial', progress() {},
  };
  const result = await runSkill(ctx as never, walkRoute, { points });
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.data?.originalRequest, { points });
  assert.deepEqual(result.data?.resolvedTarget, points[1]);
  assert.equal(result.data?.backend, 'library_walk_route');
});

test('walk_route 取消也保留原请求、解析目标与唯一后端，不伪造 NavResult', async () => {
  const points = [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }];
  const controller = new AbortController();
  controller.abort();
  const ctx = {
    adapter: {
      state: () => ({ worldId: 'w', dim: 'overworld', sessionId: 's', pos: { x: 0.5, y: 0, z: 0.5 } }),
      walkBody: () => ({}), walkTick: () => async () => null,
    },
    senses: {},
    spatial: { closing: false, paused: false, worldId: 'w', session: { voxel: { worldId: 'w' }, voxelLoading: 'eager' } },
    deadline: Date.now() + 1000, signal: controller.signal, taskId: 'cancelled', progress() {},
  };
  const result = await runSkill(ctx as never, walkRoute, { points });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.data?.stage, 'CANCELLED');
  assert.deepEqual(result.data?.originalRequest, { points });
  assert.deepEqual(result.data?.resolvedTarget, points[1]);
  assert.equal(result.data?.backend, 'library_walk_route');
  // 库执行尚未开始：没有真实 NavResult，不能拿请求坐标拼一个。
  assert.equal(result.data?.nav, undefined);
});

test('三个导航入口显式拒绝未贯通选项，空值/未开启的手段不误报', () => {
  const routePoints = [[0.5, 0, 0.5], [1.5, 0, 0.5]] as const;
  const route = walkRoute.validate({ points: routePoints }, {} as never);
  assert.ok(route.ok);

  for (const [skill, validate, base] of [
    ['walk_route', walkRoute.validate, { points: routePoints }],
    ['walk_to', walkTo.validate, { to: [1.5, 0, 0.5], arrival: { kind: 'exact' } }],
    ['walk_known_route', walkKnownRoute.validate, { fragmentId: 'frag-1' }],
  ] as const) {
    const rejected = [
      { avoid: ['lava'] },
      { dig: true },
      { place: true },
      { tower: true },
      { materials: [{ name: 'cobblestone', count: 8 }] },
      { arbitraryKey: 1 },
    ];
    for (const extra of rejected) {
      const v = validate({ ...base, ...extra } as never, {} as never);
      assert.equal(v.ok, false, `${skill} 必须拒绝 ${JSON.stringify(extra)}`);
      if (!v.ok) assert.match(v.error, new RegExp(`${skill} 不支持参数`));
    }
    // 显式空 avoid/materials 或关闭的 dig/place/tower 不请求额外手段。
    const accepted = validate({ ...base, avoid: [], materials: [], dig: false, place: false, tower: false } as never, {} as never);
    assert.equal(accepted.ok, true, `${skill} 应接受不请求额外手段的空值`);
  }

  // 非空标量也算“给了选项”，不能静默丢弃。
  const scalar = walkTo.validate({ to: [1.5, 0, 0.5], arrival: { kind: 'exact' }, avoid: 'lava' } as never, {} as never);
  assert.equal(scalar.ok, false);
});

test('walk_route 通过真实身体桥离线走通三段转弯', { timeout: 45000 }, async () => {
  // prismarine-physics 世界：石地面 y=-1，空气以上
  const world = { getBlock(p: { floored(): { x: number; y: number; z: number } }) {
    const c = p.floored();
    const id = c.y <= -1 ? data.blocksByName.stone.defaultState : data.blocksByName.air.defaultState;
    const b = Block.fromStateId(id, 0); b.position = c; return b;
  } };
  const control = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  const entity = { position: new Vec3(0.54, 0, 0.52), velocity: new Vec3(0, 0, 0), onGround: true, isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: false, yaw: 0, pitch: 0, effects: {}, attributes: {} };
  const bot = { version: '1.20.1', entity, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, inventory: { slots: [] },
    setControlState(name: string, value: boolean) { control[name] = value; },
    clearControlStates() { for (const k of Object.keys(control)) control[k] = false; },
    look(yaw: number, pitch: number) { entity.yaw = yaw; entity.pitch = pitch; } };
  const physics = Physics(data, world);
  let clock = 2000;
  const adapter = {
    state: () => ({ worldId: 'world', dim: 'overworld', sessionId: 's1', alive: true, connected: true, observationReady: true, pos: { x: entity.position.x, y: entity.position.y, z: entity.position.z }, onGround: entity.onGround }),
    walkBody: () => ({
      setControlState: (n: string, v: boolean) => bot.setControlState(n, v),
      clearControlStates: () => bot.clearControlStates(),
      look: (y: number, p: number) => bot.look(y, p),
      entity: { position: entity.position, velocity: entity.velocity, onGround: entity.onGround, isInWater: entity.isInWater },
    }),
    walkTick: () => () => new Promise((resolve) => {
      setTimeout(() => {
        physics.simulatePlayer(new PlayerState(bot, control), world).apply(bot);
        resolve({ position: entity.position, velocity: entity.velocity, onGround: entity.onGround, isInWater: entity.isInWater });
      }, 50);
    }),
  } as unknown as GameAdapter;
  const dir = mkdtempSync(join(tmpdir(), 'walk-route-skill-'));
  const svc = await SharedSpatialSession.open({ worldId: 'world', databasePath: join(dir, 'memory.db') });
  let begun = false;
  const senses = {
    observeBlocks: (positions: { x: number; y: number; z: number }[]) => {
      if (!begun) {
        svc.beginSession({ worldId: 'world', dim: 'overworld', sessionId: 's1' });
        begun = true;
      }
      const observations = positions.map((p): BlockObservation => ({
        name: p.y === -1 ? 'minecraft:stone' : 'minecraft:air', properties: {}, stateComplete: true, pos: { ...p },
        worldId: 'world', sessionId: 's1', dimension: 'overworld', observationId: 1, observedAt: Date.now(), source: 'vision',
      }));
      if (observations.length > 0) svc.observe(observations);
      return observations;
    },
  };
  try {
    const reported: number[] = [];
    const ctx = { adapter, senses, spatial: svc, deadline: Date.now() + 30000, signal: new AbortController().signal, taskId: 't', progress(p: number) { reported.push(p); } };
    const points = [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 1.5 }, { x: 2.5, y: 0, z: 1.5 }];
    const result = await runSkill(ctx as never, walkRoute, { points });
    assert.equal(result.status, 'succeeded', result.summary);
    assert.equal((result.data?.nav as { outcome: string }).outcome, 'ARRIVED');
    // 父委托外壳在成功时也必须完整，不光有 data.nav。
    assert.deepEqual(result.data?.originalRequest, { points });
    assert.deepEqual(result.data?.resolvedTarget, points[points.length - 1]);
    assert.equal(result.data?.backend, 'library_walk_route');
    assert.equal(result.data?.stage, 'ARRIVED');
    // 进度按库实测确认的新段推进，不靠墙钟；成功终点为 1。
    assert.ok(reported.some((p) => p > 0 && p < 1), `应报告中间进度，实际 ${reported.join(',')}`);
    assert.ok(reported.every((p, i) => i === 0 || p >= reported[i - 1]!), '进度必须单调不减');
    assert.equal(reported.at(-1), 1);
  } finally {
    const result = await svc.shutdown();
    assert.equal(result.error, null);
    assert.equal(result.cancelError, null);
    assert.equal(result.closeError, null);
    assert.ok(result.close !== null, 'real close must return a result');
    assert.equal(result.close.completed, true);
    assert.equal(result.close.error, null);
    assert.equal(result.close.unconfirmedRequest, false);
    rmSync(dir, { recursive: true, force: true });
  }
});
