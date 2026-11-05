import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';

const require = createRequire(import.meta.url);
test('Enderman threat follows the version-matched visible metadata, preserving neutral animals', () => {
  const adapter = new MineflayerAdapter(config, new EventBus());
  adapter.mcData = require('minecraft-data')('1.20.1');
  const classify = (entity: any) => (adapter as any).classify(entity);
  const metadata: any[] = [];
  assert.equal(classify({ name: 'enderman', metadata }), 'passive');
  for (const key of ['creepy', 'stared_at']) {
    const index = adapter.mcData.entitiesByName.enderman.metadataKeys.indexOf(key);
    assert.ok(index >= 0);
    metadata[index] = true;
    assert.equal(classify({ name: 'enderman', metadata }), 'hostile');
    metadata[index] = false;
    assert.equal(classify({ name: 'enderman', metadata }), 'passive');
  }
  assert.equal(classify({ name: 'piglin' }), 'hostile', '没有金盔甲时猪灵会主动攻击，不能归为 passive');
});

test('猪灵穿金盔甲时是中立，猪灵蛮兵始终敌对', () => {
  const adapter = new MineflayerAdapter(config, new EventBus());
  adapter.mcData = require('minecraft-data')('1.20.1');
  const classify = (entity: any) => (adapter as any).classify(entity);
  (adapter as any).bot = {
    inventory: { slots: { 5: { name: 'golden_helmet' } } },
    getEquipmentDestSlot: (slot: string) => (slot === 'head' ? 5 : undefined),
  };
  assert.equal(classify({ name: 'piglin' }), 'passive');
  assert.equal(classify({ name: 'piglin_brute' }), 'hostile');
});
