import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { Vec3 } from 'vec3';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import type { MoveTarget } from '../src/adapter/types.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';

function fixture() {
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0.5, 64, 0.5), onGround: false },
    entities: {} as Record<number, { position: Vec3 }>,
    game: { dimension: 'overworld' },
    pathfinder: { async goto(_goal: unknown) {}, stop() {}, setGoal(_goal: unknown) {} },
  });
  const adapter = new MineflayerAdapter(config, new EventBus());
  adapter.bot = bot;
  adapter.mcData = {};
  Reflect.set(adapter, 'connectedFlag', true);
  return { adapter, bot, opts: { signal: new AbortController().signal, timeoutMs: 1000 } };
}

test('installed Pathfinder empty noPath resolution is not arrival', async () => {
  const { adapter, bot, opts } = fixture();
  const pathfinderGoto = createRequire(import.meta.url)('mineflayer-pathfinder/lib/goto');
  bot.pathfinder.goto = (goal) => pathfinderGoto(bot, goal);
  bot.pathfinder.setGoal = () => { bot.emit('path_update', { status: 'noPath', path: [] }); };
  await assert.rejects(adapter.moveTo({ kind: 'xyz', x: 4, y: 64, z: 0 }, opts), /No path: 寻路结束但尚未到达目标.*0\.50,64\.00,0\.50/);
  assert.equal(bot.listenerCount('path_update'), 0);
  assert.equal(bot.listenerCount('physicsTick'), 0);
});

test('moving sideways without reaching the requested cell is not arrival', async () => {
  const { adapter, bot, opts } = fixture();
  bot.pathfinder.goto = async () => { bot.entity.position = new Vec3(0.5, 64, 1.5); };
  await assert.rejects(adapter.moveTo({ kind: 'xyz', x: 4, y: 64, z: 0 }, opts), /尚未到达目标.*0\.50,64\.00,1\.50/);
});

test('exact arrival uses the actual integer feet cell without an extra block of height', async () => {
  const { adapter, bot, opts } = fixture();
  bot.pathfinder.goto = async () => { bot.entity.position = new Vec3(-1.5, 64.5, 2.75); };
  await adapter.moveTo({ kind: 'xyz', x: -2, y: 64, z: 2 }, opts);
  await assert.rejects(adapter.moveTo({ kind: 'xyz', x: -2, y: 65, z: 2 }, opts), /尚未到达目标/);
});

test('arrival retains each goal range and horizontal or three-dimensional semantics', async () => {
  const { adapter, bot, opts } = fixture();
  const near: MoveTarget = { kind: 'near', pos: { x: 4, y: 64, z: 0 }, range: 2 };
  bot.pathfinder.goto = async () => { bot.entity.position = new Vec3(2.75, 64.75, 0.5); };
  await adapter.moveTo(near, opts);
  bot.pathfinder.goto = async () => { bot.entity.position = new Vec3(2.75, 65.75, 0.5); };
  await assert.rejects(adapter.moveTo(near, opts), /尚未到达目标/);
  await adapter.moveTo({ kind: 'xz', x: 4, z: 0, range: 2 }, opts);
});

test('follow arrival uses the current entity even when it moved less than the follow range', async () => {
  const { adapter, bot, opts } = fixture();
  bot.entities[7] = { position: new Vec3(4.5, 64, 0.5) };
  bot.pathfinder.goto = async () => {
    bot.entity.position = new Vec3(1.5, 64, 0.5);
    bot.entities[7].position = new Vec3(6.5, 64, 0.5);
  };
  await assert.rejects(adapter.moveTo({ kind: 'follow_entity', entityId: 7, range: 3 }, opts), /尚未到达目标/);
  bot.pathfinder.goto = async () => { bot.entity.position = new Vec3(3.5, 64, 0.5); };
  await adapter.moveTo({ kind: 'follow_entity', entityId: 7, range: 3 }, opts);
  bot.pathfinder.goto = async () => { delete bot.entities[7]; };
  await assert.rejects(adapter.moveTo({ kind: 'follow_entity', entityId: 7, range: 3 }, opts), /ENTITY_GONE/);
});

test('away arrival checks the original destination instead of moving it farther away', async () => {
  const { adapter, bot, opts } = fixture();
  bot.pathfinder.goto = async () => { bot.entity.position = new Vec3(5.5, 66, 0.5); };
  await adapter.moveTo({ kind: 'away_from', pos: { x: -5, y: 64, z: 0.5 }, distance: 8 }, opts);
});

test('cancellation after the path resolves remains cancellation', async () => {
  const { adapter, bot, opts } = fixture(), controller = new AbortController();
  bot.pathfinder.goto = async () => { bot.entity.position = new Vec3(4.5, 64, 0.5); controller.abort(); };
  await assert.rejects(adapter.moveTo({ kind: 'xyz', x: 4, y: 64, z: 0 }, { ...opts, signal: controller.signal }), { name: 'AbortedError' });
});
