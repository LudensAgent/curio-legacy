import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Vec3 } from 'vec3';
import { VoxelMap } from 'curio-minecraft-3d-memory';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { observeCells } from '../src/skills/walk-route.ts';
import type { Senses } from '../src/skills/types.ts';
import type { BlockObservation, GameAdapter } from '../src/adapter/types.ts';

const require = createRequire(import.meta.url);
const data = require('minecraft-data')('1.20.1');
const Block = require('prismarine-block')(data);
const { Physics, PlayerState } = require('prismarine-physics');

/** 控制日志：记录每次 setControlState/clearControlStates，用于断言取消后不再写前进键。 */
interface ControlEvent { kind: 'set' | 'clear'; name?: string; value?: boolean; at: number }
let clockBase = 0;

/** prismarine-physics 平坦石地面（y=-1），身体脚高 y=0；带控制日志与 moveTo/stopAll 计数。 */
function makeWalkAdapter() {
  const world = { getBlock(p: { floored(): { x: number; y: number; z: number } }) {
    const c = p.floored();
    const id = c.y <= -1 ? data.blocksByName.stone.defaultState : data.blocksByName.air.defaultState;
    const b = Block.fromStateId(id, 0); b.position = c; return b;
  } };
  const control: Record<string, boolean> = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  const controlLog: ControlEvent[] = [];
  const entity = { position: new Vec3(0.54, 0, 0.52), velocity: new Vec3(0, 0, 0), onGround: true, isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: false, yaw: 0, pitch: 0, effects: {}, attributes: {} };
  const bot = { version: '1.20.1', entity, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, inventory: { slots: [] },
    setControlState(name: string, value: boolean) { control[name] = value; controlLog.push({ kind: 'set', name, value, at: clockBase++ }); },
    clearControlStates() { for (const k of Object.keys(control)) control[k] = false; controlLog.push({ kind: 'clear', at: clockBase++ }); },
    look(yaw: number, pitch: number) { entity.yaw = yaw; entity.pitch = pitch; } };
  const physics = Physics(data, world);
  let moveToCalls = 0;
  let stopAllCount = 0;

  // Genuine EventEmitter so Arbiter's real lifecycle binding works like production;
  // a plain object without on/off made the constructor throw after the DB opened.
  const adapter = Object.assign(new EventEmitter(), {
    state: () => ({
      worldId: 'world', dim: 'overworld', sessionId: 's1', alive: true, connected: true, observationReady: true,
      pos: { x: entity.position.x, y: entity.position.y, z: entity.position.z }, onGround: entity.onGround, inventory: [],
    }),
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
    look: async (yaw: number, pitch: number) => { bot.look(yaw, pitch); },
    moveTo: async () => { moveToCalls++; },
    stopAll: () => { stopAllCount++; bot.clearControlStates(); },
  }) as unknown as GameAdapter;

  return { adapter, controlLog, getMoveToCalls: () => moveToCalls, getStopAllCount: () => stopAllCount, control, entity };
}

/** 平坦世界的 senses：无条件返回请求格 stone(y=-1)/air(其它) 的合法观测。 */
function flatSenses(): Senses {
  return {
    observeBlocks: (positions: { x: number; y: number; z: number }[]): BlockObservation[] => positions.map((p): BlockObservation => ({
      name: p.y === -1 ? 'minecraft:stone' : 'minecraft:air', properties: {}, stateComplete: true, pos: { ...p },
      worldId: 'world', sessionId: 's1', dimension: 'overworld', observationId: 1, observedAt: Date.now(), source: 'vision',
    })),
    perceivedEntities: () => [],
    knownBlocks: () => [],
    refresh: () => {},
    markSweep: () => {},
    nearestLand: () => null,
    navigationWaypoint: () => null,
    rememberedWaypoint: () => null,
  } as unknown as Senses;
}

/**
 * 显式测试观测源：把平坦夹具的观测直接写入真实共享服务。
 * 它只用于本文件的旧单元夹具，不冒充生产 Vision 证据（生产链路由 host 集成测试覆盖）。
 */
function sharedFlatSenses(svc: SharedSpatialSession): Senses {
  const base = flatSenses();
  let begun = false;
  return {
    ...base,
    observeBlocks: (positions: { x: number; y: number; z: number }[]) => {
      if (!begun) {
        svc.beginSession({ worldId: 'world', dim: 'overworld', sessionId: 's1' });
        begun = true;
      }
      const observations = base.observeBlocks!(positions);
      if (observations.length > 0) svc.observe(observations);
      return observations;
    },
  } as unknown as Senses;
}

async function openShared(): Promise<{ svc: SharedSpatialSession; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'walk-route-production-'));
  const svc = await SharedSpatialSession.open({ worldId: 'world', databasePath: join(dir, 'memory.db') });
  return { svc, dir };
}

async function closeShared(svc: SharedSpatialSession, dir: string): Promise<void> {
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

const points3 = [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 1.5 }, { x: 2.5, y: 0, z: 1.5 }];

test('observeCells 遵守 ≤32 批次：超过 32 个候选时关键格不因截断漏掉', () => {
  const map = new VoxelMap('world', { validityWindowMs: 60_000 });
  const cells = Array.from({ length: 80 }, (_, i) => ({ x: i, y: 0, z: 0 }));
  const requested: number[] = [];
  const senses = {
    ...flatSenses(),
    observeBlocks: (positions: { x: number; y: number; z: number }[]) => {
      positions.forEach((p) => requested.push(p.x));
      return positions.map((p): BlockObservation => ({ name: 'minecraft:air', properties: {}, stateComplete: true, pos: { ...p }, worldId: 'world', sessionId: 's1', dimension: 'overworld', observationId: 1, observedAt: Date.now(), source: 'vision' }));
    },
  } as unknown as Senses;
  const ctx = { senses } as never;
  observeCells(ctx, map, cells);
  assert.deepEqual(requested, Array.from({ length: 80 }, (_, i) => i), '全部 80 个候选必须分批请求，关键格排在第 32 个之后也不漏掉');
});

test('observeCells 整批合并 ChangeReport：支撑拆除与无关刷新同批不丢失', () => {
  const map = new VoxelMap('world', { validityWindowMs: 60_000 });
  // 先建立支撑格 stone 的已有证据
  map.observe({ worldId: 'world', dim: 'overworld', sessionId: 's1', observedAt: 1, sequence: 1, source: 'vision', evidence: 'seen', stateComplete: true, state: { name: 'minecraft:stone', properties: {} }, pos: { x: 15, y: -1, z: 0 } });
  // 一次返回两个变化：先支撑拆除（stone→air），再无关刷新
  const senses = {
    ...flatSenses(),
    observeBlocks: () => ([
      { name: 'minecraft:air', properties: {}, stateComplete: true, pos: { x: 15, y: -1, z: 0 }, worldId: 'world', sessionId: 's1', dimension: 'overworld', observationId: 2, observedAt: Date.now(), source: 'vision' },
      { name: 'minecraft:air', properties: {}, stateComplete: true, pos: { x: 16, y: 2, z: 0 }, worldId: 'world', sessionId: 's1', dimension: 'overworld', observationId: 3, observedAt: Date.now(), source: 'vision' },
    ] as BlockObservation[]),
  } as unknown as Senses;
  const ctx = { senses } as never;
  const report = observeCells(ctx, map, [{ x: 15, y: -1, z: 0 }, { x: 16, y: 2, z: 0 }]);
  assert.ok(report, '应返回合并报告');
  const cells = report!.sections.flatMap((s) => s.cells.map((c) => `${c.pos.x},${c.pos.y},${c.pos.z}`));
  assert.ok(cells.includes('15,-1,0'), '支撑拆除的变化必须出现在报告中');
  const view = map.cellAt('overworld', 15, -1, 0);
  assert.equal(view.observed ? view.evidence.observation.state.name : null, 'minecraft:air', '地图必须反映支撑已拆除为空气');
});

test('observeCells 不把缺失 blockStateAt 的光学名称回退当成完整状态', () => {
  const map = new VoxelMap('world', { validityWindowMs: 60_000 });
  const senses = {
    ...flatSenses(),
    observeBlocks: () => ([
      { name: 'minecraft:oak_door', properties: {}, stateComplete: false, pos: { x: 3, y: 0, z: 0 }, worldId: 'world', sessionId: 's1', dimension: 'overworld', observationId: 1, observedAt: Date.now(), source: 'vision' },
    ] as BlockObservation[]),
  } as unknown as Senses;
  const ctx = { senses } as never;
  observeCells(ctx, map, [{ x: 3, y: 0, z: 0 }]);
  const view = map.cellAt('overworld', 3, 0, 0);
  assert.equal(view.observed, true, '名称可见的格子应进入地图');
  assert.equal(view.observed ? view.evidence.observation.stateComplete : null, false, '仅有光学名称时不得标记为完整状态');
});

test('observeCells 把混合 boolean/number/string 属性规范成语义字符串，且不改元数据', () => {
  const map = new VoxelMap('world', { validityWindowMs: 60_000 });
  const observedAt = 1_700_000_000_000;
  const senses = {
    ...flatSenses(),
    observeBlocks: () => ([
      { name: 'minecraft:oak_door', properties: { open: true, water_level: 3, facing: 'north' }, stateComplete: true, pos: { x: 5, y: 2, z: 0 }, worldId: 'world', sessionId: 's1', dimension: 'overworld', observationId: 42, observedAt, source: 'vision' },
    ] as BlockObservation[]),
  } as unknown as Senses;
  const ctx = { senses } as never;
  observeCells(ctx, map, [{ x: 5, y: 2, z: 0 }]);
  const view = map.cellAt('overworld', 5, 2, 0);
  assert.equal(view.observed, true);
  const obs = view.observed ? view.evidence.observation : null;
  assert.deepEqual(obs?.state.properties, { open: 'true', water_level: '3', facing: 'north' }, 'boolean/number 必须规范成字符串，字符串键值原样保留');
  assert.equal(obs?.state.name, 'minecraft:oak_door');
  assert.equal(obs?.worldId, 'world');
  assert.equal(obs?.dim, 'overworld');
  assert.equal(obs?.sessionId, 's1');
  assert.equal(obs?.observedAt, observedAt, 'observedAt 必须原样保留');
  assert.equal(obs?.sequence, 42, 'observationId 必须映射为 sequence');
  assert.equal(obs?.source, 'vision');
  assert.equal(obs?.stateComplete, true);
});
