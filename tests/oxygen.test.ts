import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { ownOxygen } from '../src/adapter/mineflayer.ts';

const require = createRequire(import.meta.url);
const registry = require('minecraft-data')('1.20.1');

test('oxygen comes from our own air_supply, not whatever entity mineflayer heard last', () => {
  // 旁边的海豚把 bot.oxygenLevel 写成了 318；自己的 air_supply 是 150 tick（= 10/20）
  assert.equal(ownOxygen({ registry, oxygenLevel: 318, entity: { metadata: { 1: 150 } } }), 10);
  assert.equal(ownOxygen({ registry, oxygenLevel: 0, entity: { metadata: { 1: 300 } } }), 20);
});

test('without metadata the fallback is still clamped to 0..20', () => {
  assert.equal(ownOxygen({ oxygenLevel: 318, entity: {} }), 20);
  assert.equal(ownOxygen({ oxygenLevel: -3, entity: {} }), 0);
  assert.equal(ownOxygen({ entity: {} }), 20);
});
