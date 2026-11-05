import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';

const require = createRequire(import.meta.url);
const data = require('minecraft-data')('1.20.1');
const Vec3 = require('vec3').Vec3;

/** 不连服务器的 bot 模型：只验证“没有载具就不该一直关着物理”的状态恢复。 */
function setup(vehicle: { name: string } | null) {
  const bus = new EventBus();
  const adapter = new MineflayerAdapter(config, bus);
  const block = { name: 'stone', position: new Vec3(0, 63, 0), boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] };
  const bot = Object.assign(new EventEmitter(), {
    registry: data,
    physicsEnabled: false,
    vehicle,
    entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0, pitch: 0, velocity: new Vec3(0, 0, 0), height: 1.8, eyeHeight: 1.62 },
    game: { dimension: 'overworld', difficulty: 'normal', rules: {} },
    time: { timeOfDay: 1000, day: 1, age: 0, isDay: true },
    health: 20,
    food: 20,
    blockAt: () => block,
    world: { getColumnAt: () => ({}) },
    inventory: { items: () => [], slots: [], emptySlotCount: () => 36 },
  });
  adapter.bot = bot;
  adapter.mcData = data;
  Object.assign(adapter, { connectedFlag: true, spawned: true, dimension: 'overworld' });
  return { adapter, bot };
}

test('没有乘船却仍关着物理时，读取状态会恢复物理模拟', () => {
  const { adapter, bot } = setup(null);
  adapter.state();
  assert.equal(bot.physicsEnabled, true);
});

test('坐船时保持物理关闭，由船的位置推进', () => {
  const { adapter, bot } = setup({ name: 'oak_boat' });
  adapter.state();
  assert.equal(bot.physicsEnabled, false);
});

test('坐的不是船（马/猪/矿车）时物理照常开启', () => {
  const { adapter, bot } = setup({ name: 'horse' });
  adapter.state();
  assert.equal(bot.physicsEnabled, true);
});
