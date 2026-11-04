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

/** 用一个不连服务器的 bot 模型，直接验证 blockStateAt 在“拿不到属性”和“拿到属性”两种边界下的返回。 */
function setup(name: string, getProperties?: () => Record<string, string | number | boolean>) {
  const adapter = new MineflayerAdapter(config, new EventBus());
  const pos = new Vec3(1, 65, 0);
  const block = Object.assign(
    { name, position: pos, boundingBox: 'block' },
    getProperties ? { getProperties } : {},
  );
  const bot = Object.assign(new EventEmitter(), {
    registry: data,
    entity: { position: new Vec3(0, 64, 0), yaw: 0 },
    game: { dimension: 'overworld' },
    blockAt: () => block,
  });
  adapter.bot = bot;
  adapter.mcData = data;
  Object.assign(adapter, { connectedFlag: true });
  return { adapter, pos };
}

test('blockStateAt：缺少属性读取器时返回 null，不把空回退当成完整状态', () => {
  const { adapter, pos } = setup('stone');
  assert.equal(adapter.blockStateAt({ x: pos.x, y: pos.y, z: pos.z }), null);
});

test('blockStateAt：读取器返回的空属性是 stone/air 的真实完整状态', () => {
  const { adapter, pos } = setup('stone', () => ({}));
  assert.deepEqual(adapter.blockStateAt({ x: pos.x, y: pos.y, z: pos.z }), { name: 'stone', properties: {} });
});

test('blockStateAt：实际属性原样返回，不丢 boolean/number/string 值', () => {
  const { adapter, pos } = setup('oak_door', () => ({ open: true, level: 3, facing: 'north' }));
  assert.deepEqual(adapter.blockStateAt({ x: pos.x, y: pos.y, z: pos.z }), { name: 'oak_door', properties: { open: true, level: 3, facing: 'north' } });
});
