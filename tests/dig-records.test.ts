import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GameAdapter, Vec3Like } from '../src/adapter/types.ts';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { efficiencyInsights } from '../src/brain/efficiency.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { FakeAdapter } from './fake-adapter.ts';

// 只实现 digTimeEstimate 的适配器存根：铁镐挖圆石 0.5s、挖铁矿 0.5s；石镐都慢 1.5 倍
const pickAdapter = {
  digTimeEstimate: (block: string, tool: string | null) => {
    const times: Record<string, Record<string, number>> = {
      cobblestone: { '': 7500, wooden_pickaxe: 1500, stone_pickaxe: 750, iron_pickaxe: 500, diamond_pickaxe: 300 },
      iron_ore: { '': 7500, wooden_pickaxe: 1150, stone_pickaxe: 750, iron_pickaxe: 500, diamond_pickaxe: 375 },
    };
    return times[block]?.[tool ?? ''] ?? null;
  },
} as unknown as GameAdapter;

test('efficiencyInsights：铁镐挖石/铁矿（混有 ms=0 的寻路挖）仍给出更省的 stone_pickaxe，中位不被拉成 0', () => {
  const m = new WorldMemory(null);
  m.setWorld('w');
  for (let i = 0; i < 3; i++) m.recordDig('cobblestone', 'iron_pickaxe', 500);
  m.recordDig('cobblestone', 'diamond_pickaxe', 0);
  m.recordDig('cobblestone', 'diamond_pickaxe', 0);
  for (let i = 0; i < 3; i++) m.recordDig('iron_ore', 'iron_pickaxe', 600);
  m.recordDig('iron_ore', 'stone_pickaxe', 0);

  const ins = efficiencyInsights(pickAdapter, m, [{ name: 'stone_pickaxe', count: 1 }]);
  const stone = ins.find((e) => e.block === 'cobblestone')!;
  assert.ok(stone, '有实测的圆石组不能被丢掉');
  assert.equal(stone.avg_s, 0.5, '中位只算实测 500ms，不被 0ms 拉低');
  assert.equal(stone.tool, 'iron_pickaxe', '没有实测耗时的记录不参与工具归属，避免工具与耗时错配');
  assert.equal(stone.mined, 3, 'ms=0 的记录本轮不参与效率估算');
  assert.equal(stone.cheaper[0].tool, 'stone_pickaxe');
  assert.equal(stone.cheaper[0].have, true);

  const ore = ins.find((e) => e.block === 'iron_ore')!;
  assert.ok(ore);
  assert.equal(ore.avg_s, 0.6);
  assert.equal(ore.cheaper[0].tool, 'stone_pickaxe');
});

test('efficiencyInsights：全是 ms=0（没有实测）的组不产出，不把没测过的耗时伪造成 0 秒', () => {
  const m = new WorldMemory(null);
  m.setWorld('w');
  for (let i = 0; i < 5; i++) m.recordDig('cobblestone', 'iron_pickaxe', 0);
  assert.equal(efficiencyInsights(pickAdapter, m, [{ name: 'stone_pickaxe', count: 1 }]).length, 0);
});

test('perception：判断不了所在环境（where 分支为空）时，挖掉的方块仍进入效率账本', () => {
  const adapter = new FakeAdapter();
  adapter.observationReady = false; // contact/overhead/where 都拿不到，走非 where 分支
  const now = Date.now();
  const dug = [
    { pos: { x: 1, y: 63, z: 0 }, name: 'stone', ts: now - 2000, tool: 'iron_pickaxe', ms: 480 },
    { pos: { x: 2, y: 63, z: 0 }, name: 'stone', ts: now - 1000, tool: null, ms: 0 },
  ];
  Object.assign(adapter, { recentDug: (since: number) => dug.filter((d) => d.ts > since) });

  const memory = new WorldMemory(null);
  const perception = new Perception(adapter, memory, new EventBus(), new Vision(adapter));
  perception.update();
  // 只有实测耗时的挖掘进效率账；ms=0 的寻路挖不挤占 300 条上限
  assert.deepEqual(memory.recentDigs().map((r) => ({ block: r.block, tool: r.tool, ms: r.ms })), [
    { block: 'stone', tool: 'iron_pickaxe', ms: 480 },
  ]);
  // 游标已推进：同一批不会在下次感知里重复记账
  perception.update();
  assert.equal(memory.recentDigs().length, 1);
});

test('efficiencyInsights：同族不同工具分别成组，不拿多数工具配混合中位', () => {
  const m = new WorldMemory(null);
  m.setWorld('w');
  for (let i = 0; i < 3; i++) m.recordDig('cobblestone', 'iron_pickaxe', 500);
  for (let i = 0; i < 3; i++) m.recordDig('cobblestone', 'stone_pickaxe', 750);
  const ins = efficiencyInsights(pickAdapter, m, [{ name: 'stone_pickaxe', count: 1 }, { name: 'iron_pickaxe', count: 1 }]);
  const iron = ins.find((e) => e.tool === 'iron_pickaxe')!;
  const stone = ins.find((e) => e.tool === 'stone_pickaxe')!;
  assert.equal(iron.avg_s, 0.5);
  assert.equal(stone.avg_s, 0.8, '750ms 按现有一位小数显示为 0.8s');
  assert.equal(iron.cheaper[0].tool, 'stone_pickaxe');
  assert.ok(stone.better.some((b) => b.tool === 'iron_pickaxe'));
});

type FakeItem = { name: string; type: number; count: number };
type FakeBlock = { name: string; position: Vec3Like; diggable: boolean; harvestTools?: Record<number, boolean>; digTime: (type: number | null) => number };
type FakeToolBot = {
  entity: { position: Vec3Like; onGround: boolean; isInWater: boolean; effects: Record<string, never> };
  heldItem: FakeItem | null;
  inventory: { items: () => FakeItem[]; slots: unknown[] };
  game: { dimension: string };
  blockAt: () => FakeBlock;
  canDigBlock: () => boolean;
  equip: (item: FakeItem) => Promise<void>;
  unequip: () => Promise<void>;
  dig: () => Promise<void>;
  stopDigging: () => void;
};

const stone = (): FakeBlock => ({
  name: 'stone', position: { x: 1, y: 64, z: 0 }, diggable: true,
  harvestTools: { 257: true, 871: true }, digTime: (t) => t === 871 ? 300 : t === 257 ? 400 : 7500,
});
// 软方块没有 harvestTools：任何工具都挖得动；这里让铁锹比铁镐快，验证指定工具时不会被换掉
const dirt = (): FakeBlock => ({
  name: 'dirt', position: { x: 1, y: 64, z: 0 }, diggable: true,
  digTime: (t) => t === 256 ? 300 : t === 257 ? 1000 : 1200,
});

function digBot(block: FakeBlock, items: FakeItem[]) {
  const used: string[] = [];
  const bot: FakeToolBot = {
    entity: { position: { x: 0, y: 64, z: 0 }, onGround: true, isInWater: false, effects: {} },
    heldItem: null,
    inventory: { items: () => items, slots: [] },
    game: { dimension: 'overworld' },
    blockAt: () => block,
    canDigBlock: () => true,
    equip: async (item) => { bot.heldItem = item; },
    unequip: async () => { bot.heldItem = null; },
    dig: async () => { used.push(bot.heldItem?.name ?? 'hand'); },
    stopDigging: () => {},
  };
  return { bot, used };
}

function adapterWith(bot: FakeToolBot) {
  const adapter = new MineflayerAdapter(config, new EventBus());
  Object.assign(adapter, { bot, mcData: {}, connectedFlag: true });
  return adapter;
}

test('dig(opts.tool)：指定 iron_pickaxe 时只用这一把，不换成更快的钻石镐', async () => {
  const { bot, used } = digBot(stone(), [{ name: 'iron_pickaxe', type: 257, count: 1 }, { name: 'diamond_pickaxe', type: 871, count: 1 }]);
  const r = await adapterWith(bot).dig({ x: 1, y: 64, z: 0 }, new AbortController().signal, { tool: 'iron_pickaxe' });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(used, ['iron_pickaxe']);
});

test('dig(opts.tool)：背包没有指定工具 → TOOL_MISSING，不换别的工具也不空手挖', async () => {
  const { bot, used } = digBot(stone(), [{ name: 'diamond_pickaxe', type: 871, count: 1 }]);
  const r = await adapterWith(bot).dig({ x: 1, y: 64, z: 0 }, new AbortController().signal, { tool: 'iron_pickaxe' });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /TOOL_MISSING.*iron_pickaxe/);
  assert.deepEqual(used, []);
});

test('dig(opts.tool)：指定工具挖不动该方块 → TOOL_MISSING', async () => {
  const { bot, used } = digBot(stone(), [{ name: 'iron_axe', type: 258, count: 1 }]);
  const r = await adapterWith(bot).dig({ x: 1, y: 64, z: 0 }, new AbortController().signal, { tool: 'iron_axe' });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /TOOL_MISSING.*iron_axe/);
  assert.deepEqual(used, []);
});

test('dig(opts.tool)：软方块（泥土）照指定用铁镐，不被换成更快的铁锹；不传时保持自动挑最快', async () => {
  const items = [{ name: 'iron_pickaxe', type: 257, count: 1 }, { name: 'iron_shovel', type: 256, count: 1 }];
  const forced = digBot(dirt(), items);
  await adapterWith(forced.bot).dig({ x: 1, y: 64, z: 0 }, new AbortController().signal, { tool: 'iron_pickaxe' });
  assert.deepEqual(forced.used, ['iron_pickaxe']);
  const auto = digBot(dirt(), items);
  await adapterWith(auto.bot).dig({ x: 1, y: 64, z: 0 }, new AbortController().signal);
  assert.deepEqual(auto.used, ['iron_shovel'], '不传 tool 时保持原有自动换手');
});
