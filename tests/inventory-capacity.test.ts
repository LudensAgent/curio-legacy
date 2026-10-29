import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Vec3 } from 'vec3';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { buildMindMessages } from '../src/mind/prompt.ts';
import { SelfModel } from '../src/mind/self.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { FakeAdapter } from './fake-adapter.ts';

test('adapter retains individual inventory stacks without merging item data', () => {
  const slots = Array.from({ length: 46 }, () => null as null | { slot: number; name: string; count: number; nbt?: object });
  slots[9] = { slot: 9, name: 'raw_iron', count: 2 };
  slots[10] = { slot: 10, name: 'raw_iron', count: 5, nbt: { custom: true } };
  slots[11] = { slot: 11, name: 'bucket', count: 2 };
  const adapter = new MineflayerAdapter(config, new EventBus());
  adapter.bot = {
    entity: { position: new Vec3(0, 64, 0) }, game: { dimension: 'overworld' }, health: 20,
    inventory: { slots, items: () => slots.slice(9, 45).filter(Boolean), emptySlotCount: () => 33 },
  };
  adapter.mcData = { itemsByName: { raw_iron: { stackSize: 64 }, bucket: { stackSize: 16 } } };
  Reflect.set(adapter, 'connectedFlag', true);
  const state = adapter.state();
  assert.deepEqual(state.inventory.find((item) => item.name === 'raw_iron')?.stacks, [{ slot: 9, count: 2 }, { slot: 10, count: 5 }]);
  assert.deepEqual(state.inventory.find((item) => item.name === 'bucket')?.stacks, [{ slot: 11, count: 2 }]);
});

test('both thinking tiers receive conditional per-stack space and shared empty-slot capacity', () => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const percept = { ...perception.update(), emptySlots: 1 };
  const state = { ...adapter.state(), emptySlots: 4, inventory: [
    { name: 'raw_iron', count: 7, stackSize: 64, stacks: [{ slot: 9, count: 2 }, { slot: 10, count: 5 }] },
    { name: 'bucket', count: 2, stackSize: 16, stacks: [{ slot: 11, count: 2 }] },
    { name: 'pickaxe', count: 1, stackSize: 1, stacks: [{ slot: 12, count: 1 }] },
    { name: 'unknown', count: 3, stacks: [{ slot: 13, count: 3 }] },
    { name: 'no_slots', count: 2, stackSize: 64 },
  ] };
  for (const tier of ['glance', 'deliberate'] as const) {
    const [, user] = buildMindMessages({ reason: '测试', percept, state, self: new SelfModel(null), memory, activity: null, suspended: [], lastRecord: null,
      noticed: [], changes: [], userSuggestion: null, audience: null, notes: [], mySkills: [], persona: 'P', skills: [], tier } as any);
    const body = JSON.parse(user.content.match(/【身体】(\{.*)/)![1]);
    assert.equal(body.empty_slots, 4, '空槽与背包来自同一个状态快照');
    assert.match(body.inventory[0], /槽9 2\/64，该叠可再放 62 个数据相同的物品；槽10 5\/64，该叠可再放 59 个数据相同的物品/);
    assert.match(body.inventory[1], /槽11 2\/16，该叠可再放 14 个数据相同的物品/);
    assert.equal(body.inventory[2], 'pickaxe×1（每叠上限 1）');
    assert.equal(body.inventory[3], 'unknown×3');
    assert.equal(body.inventory[4], 'no_slots×2（每叠上限 64）');
    assert.match(body.inventory_space, /分别可放 256、64、4 个/);
    assert.match(body.inventory_space, /这些空槽由所有物品共用/);
  }
  const [, noSpace] = buildMindMessages({ reason: '测试', percept, state: { ...state, emptySlots: 0,
    inventory: [{ name: 'raw_iron', count: 64, stackSize: 64, stacks: [{ slot: 9, count: 64 }] }] }, self: new SelfModel(null), memory,
    activity: null, suspended: [], lastRecord: null, noticed: [], changes: [], userSuggestion: null, audience: null, notes: [], mySkills: [], persona: 'P', skills: [], tier: 'glance' } as any);
  const full = JSON.parse(noSpace.content.match(/【身体】(\{.*)/)![1]);
  assert.match(full.inventory[0], /槽9 64\/64，该叠可再放 0 个/);
  assert.match(full.inventory_space, /分别可放 0、0、0 个/);
  memory.close();
});
