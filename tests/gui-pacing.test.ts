import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';

function fixture(type: string) {
  const slots = Array(39).fill(null);
  const window = { id: 1, type: `minecraft:${type}`, inventoryStart: 3, slots };
  const packets: { name: string; time: number }[] = [];
  const horse = { id: 7, name: 'horse', position: new Vec3(1, 64, 0) };
  const bot = Object.assign(new EventEmitter(), {
    entity: { id: 1, position: new Vec3(0, 64, 0) }, entities: { 7: horse }, vehicle: horse,
    game: { dimension: 'overworld' }, inventory: { slots: [], selectedItem: null, items: () => [] },
    blockAt: () => ({ name: type, position: new Vec3(1, 64, 0) }),
    async openBlock() { return window; }, closeWindow() {},
    _client: { write(name: string) {
      packets.push({ name, time: Date.now() });
      if (name === 'entity_action') bot.emit('windowOpen', window);
      if (name === 'enchant_item') slots[2] = { name: 'stone', count: 1 };
      if (name === 'name_item') slots[2] = { name: 'stone', count: 1, customName: 'test' };
      if (name === 'set_beacon_effect') slots[0] = null;
    } },
  });
  const adapter = new MineflayerAdapter({ ...config, ui: { pacingMs: 120, openHoldMs: 120, closeHoldMs: 0 } }, new EventBus()) as any;
  adapter.bot = bot; adapter.mcData = minecraftData('1.20.1'); adapter.connectedFlag = true;
  adapter.moveTo = async () => {};
  return { adapter, bot, slots, packets };
}

test('按钮、铁砧改名和信标提交都等待 UI_PACING_MS', async () => {
  const cases = [
    { type: 'stonecutter', op: { button: 0 }, packet: 'enchant_item' },
    { type: 'anvil', op: { rename: 'test' }, packet: 'name_item' },
    { type: 'beacon', op: { beacon: { primary: 1, secondary: 0 } }, packet: 'set_beacon_effect' },
  ];
  await Promise.all(cases.map(async ({ type, op, packet }) => {
    const f = fixture(type);
    f.slots[0] = { name: 'iron_ingot', count: 1 };
    const start = Date.now();
    const result = await f.adapter.useGui({ x: 1, y: 64, z: 0 }, [op], new AbortController().signal);
    assert.equal(result.ok, true, result.reason);
    const sent = f.packets.find((p) => p.name === packet);
    assert.ok(sent && sent.time - start >= 350, '初始 250ms 状态稳定后，还需等待 120ms 点击节奏');
  }));
});

test('马背打开物品栏后按 UI_OPEN_HOLD_MS 停留', async () => {
  const f = fixture('horse');
  const start = Date.now();
  const result = await f.adapter.useGui({ entityId: 7 }, [], new AbortController().signal);
  assert.equal(result.ok, true, result.reason);
  assert.ok(Date.now() - start >= 350, '开窗停留后再等待状态稳定');
});

test('按钮节奏等待期间取消时不发送按钮包', async () => {
  const f = fixture('stonecutter');
  const controller = new AbortController();
  const pending = f.adapter.useGui({ x: 1, y: 64, z: 0 }, [{ button: 0 }], controller.signal);
  setTimeout(() => controller.abort(), 300);
  await assert.rejects(pending);
  assert.equal(f.packets.some((p) => p.name === 'enchant_item'), false);
});
