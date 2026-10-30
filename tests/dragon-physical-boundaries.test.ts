import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { dragonFight } from '../src/skills/dragon.ts';
import { equipArmor } from '../src/skills/equipment.ts';
import type { Senses, SkillCtx } from '../src/skills/types.ts';
import { FakeAdapter } from './fake-adapter.ts';

const require = createRequire(import.meta.url);
const Vec3 = require('vec3').Vec3;
const senses: Senses = { refresh() {}, markSweep() {}, knownBlocks() { return []; }, perceivedEntities() { return []; } };
const context = (adapter: FakeAdapter): SkillCtx => ({ adapter, senses, memory: new WorldMemory(null), bus: new EventBus(), signal: new AbortController().signal, deadline: Date.now() + 4000, taskId: 'physical-boundary', progress() {} });

test('low-health dragon control attempts retreat and food even after losing sight of every hazard', async () => {
  const adapter = new FakeAdapter();
  adapter.dim = 'the_end'; adapter.hp = 5; adapter.food = 16;
  for (const item of ['bow', 'arrow', 'bread']) adapter.inv.set(item, 1);
  const result = await dragonFight.run(context(adapter), { seconds: 10 });
  assert.equal(result.failureCode, 'LOW_HP');
  assert.ok(adapter.actions.includes('moveTo:near'));
  assert.equal(adapter.food, 20);
  assert.notEqual(result.data?.defeatVerified, true);
});

test('equip_armor 装备最好材质的护甲并核对装备栏', async () => {
  const adapter = new FakeAdapter();
  adapter.inv.set('diamond_helmet', 1);
  const ctx = context(adapter);
  assert.equal((await equipArmor.run(ctx, {})).status, 'succeeded');
  assert.equal(adapter.equipped.get('head'), 'diamond_helmet');
});

test('a cage with no clear ballistic path cannot draw or spend an arrow', async () => {
  const adapter = new MineflayerAdapter(config, new EventBus());
  const events: string[] = [];
  const crystal = { id: 44, name: 'end_crystal', isValid: true, position: new Vec3(20, 72, 0), height: 2 };
  adapter.bot = { entity: { position: new Vec3(0, 64, 0) }, entities: { 44: crystal }, game: { dimension: 'the_end' },
    inventory: { items: () => [{ name: 'bow' }, { name: 'arrow' }] },
    world: { raycast: () => ({ name: 'iron_bars' }) },
    equip: async () => {}, lookAt: async () => {}, activateItem: () => events.push('draw'), deactivateItem: () => events.push('release') };
  adapter.mcData = {}; (adapter as any).connectedFlag = true;
  const result = await adapter.rangedAttack(44, new AbortController().signal);
  assert.equal(result.reason, 'BLOCKED_AIM');
  assert.deepEqual(events, []);
});

test('stopping a drawn bow changes held slots instead of sending an arrow release', () => {
  const adapter = new MineflayerAdapter(config, new EventBus());
  const events: string[] = [];
  adapter.bot = { heldItem: { name: 'bow' }, quickBarSlot: 8, usingHeldItem: true,
    setQuickBarSlot: (slot: number) => events.push(`slot:${slot}`),
    clearControlStates() {}, deactivateItem: () => events.push('fire') };
  adapter.stopAll();
  assert.deepEqual(events, ['slot:0']);
  assert.equal(adapter.bot.usingHeldItem, false);
});

test('hearing alone cannot aim at a dragon or establish observed death evidence', async () => {
  const adapter = new FakeAdapter();
  adapter.dim = 'the_end'; adapter.inv.set('bow', 1); adapter.inv.set('arrow', 1);
  adapter.dragonDeath = { entityId: 44, worldId: adapter.worldId, dim: adapter.dim, sessionId: adapter.sessionId, pos: { x: 6, y: 64, z: 0 }, observedAt: Date.now() + 1 };
  const ctx = context(adapter); ctx.deadline = Date.now() + 350;
  ctx.senses = { ...senses, perceivedEntities() { return [{ id: 44, name: 'ender_dragon', kind: 'hostile', perception: 'heard', pos: { x: 6, y: 64, z: 0 }, dist: 6 }]; } };
  const result = await dragonFight.run(ctx, { seconds: 10 });
  assert.equal(result.data?.defeatVerified, false);
  assert.ok(!adapter.actions.some((action) => /^(ranged|attack):/.test(action)));
});
