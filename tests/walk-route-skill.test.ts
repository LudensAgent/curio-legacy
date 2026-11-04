import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { Vec3 } from 'vec3';
import { SKILLS } from '../src/skills/index.ts';
import { walkRoute } from '../src/skills/walk-route.ts';
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

test('walk_route 通过真实身体桥离线走通三段转弯', async () => {
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
  const senses = {
    observeBlocks: (positions: { x: number; y: number; z: number }[]) => positions.map((p): BlockObservation => ({
      name: p.y === -1 ? 'minecraft:stone' : 'minecraft:air', properties: {}, stateComplete: true, pos: { ...p },
      worldId: 'world', sessionId: 's1', dimension: 'overworld', observationId: 1, observedAt: Date.now(), source: 'vision',
    })),
  };
  const ctx = { adapter, senses, deadline: Date.now() + 30000, signal: new AbortController().signal, taskId: 't', progress() {} };
  const result = await runSkill(ctx as never, walkRoute, { points: [{ x: 0.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 0.5 }, { x: 1.5, y: 0, z: 1.5 }, { x: 2.5, y: 0, z: 1.5 }] });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal((result.data?.nav as { outcome: string }).outcome, 'ARRIVED');
});
