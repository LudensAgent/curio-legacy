import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { InvItem } from '../src/adapter/types.ts';
import type { StockRow } from '../src/memory/chest-memory.ts';
import { consumptionSummary, durabilityFacts, fuelFacts, supplyFacts, torchCraftable } from '../src/brain/supply.ts';

const item = (name: string, count: number, extra?: Partial<InvItem>): InvItem => ({ name, count, ...extra });
const row = (item: string, inChests: number): StockRow => ({ item, total: inChests, inChests, chestCount: 1, inBackpack: 0 });

test('torchCraftable：煤/木炭 + 木棍，取短板 ×4；箱子里的料也算', () => {
  assert.deepEqual(torchCraftable([item('coal', 3), item('charcoal', 1), item('stick', 6)]), { coal: 4, sticks: 6, craftable: 16, chestCoal: 0, chestSticks: 0 });
  assert.deepEqual(torchCraftable([item('stick', 10)]), { coal: 0, sticks: 10, craftable: 0, chestCoal: 0, chestSticks: 0 });
  // 箱子里有煤、背包只有木棍：合计计入，并标出箱子部分
  const withChest = torchCraftable([item('stick', 4)], [row('coal', 5)]);
  assert.deepEqual(withChest, { coal: 5, sticks: 4, craftable: 16, chestCoal: 5, chestSticks: 0 });
});

test('supplyFacts：火把报覆盖与还能做多少，并按难度门控刷怪措辞', () => {
  const inv = [item('torch', 12), item('coal', 3), item('stick', 6)];
  const out = supplyFacts({ inv, torchEvery: 8, only: new Set(['torch']) });
  assert.equal(out.length, 1);
  assert.match(out[0], /火把 12 支（torch_every≈8 → 约能照亮 96 格暗处）/);
  assert.match(out[0], /还能直接做 12 支/);
  // 和平：只为照明，不提刷怪
  assert.match(supplyFacts({ inv, torchEvery: 8, only: new Set(['torch']), difficulty: 'peaceful' })[0], /和平没怪，火把只为照明/);
  // 普通：会刷怪，用中文难度名
  assert.match(supplyFacts({ inv, torchEvery: 8, only: new Set(['torch']), difficulty: 'normal' })[0], /普通，会刷怪/);
});

test('supplyFacts：箱子里存的煤/木棍也计入还能做多少', () => {
  const inv = [item('torch', 12), item('coal', 1), item('stick', 6)];
  const out = supplyFacts({ inv, torchEvery: 8, only: new Set(['torch']), stock: [row('coal', 2)] });
  assert.match(out[0], /煤\/木炭 3、木棍 6，还能直接做 12 支/);
  assert.match(out[0], /其中箱子里 煤\/木炭 2、木棍 0/);
});

test('supplyFacts：食物/箭/方块报存量', () => {
  const inv = [item('apple', 3), item('cooked_beef', 2), item('arrow', 5), item('cobblestone', 40)];
  const out = supplyFacts({ inv });
  assert.ok(out.some((l) => /路上食物 5 个（其中熟食 2 个）/.test(l)));
  assert.ok(out.some((l) => /箭 5 发/.test(l)));
  assert.ok(out.some((l) => /能垫路的方块 40 块/.test(l)));
});

test('fuelFacts：够 / 不够 / 没有燃料；箱子里燃料也算', () => {
  const enough = fuelFacts([item('raw_iron', 24), item('coal', 3)], 'raw_iron', 24)!;
  assert.match(enough, /现有燃料合计能烧约 24 件/);
  assert.match(enough, /，够/);
  const short = fuelFacts([item('raw_iron', 24), item('coal', 1)], 'raw_iron', 24)!;
  assert.match(short, /还差约 16/);
  const none = fuelFacts([item('raw_iron', 24)], 'raw_iron', 24)!;
  assert.match(none, /没有燃料/);
  // 箱子里的煤补上背包缺口
  const withChest = fuelFacts([item('raw_iron', 24), item('coal', 1)], 'raw_iron', 24, [row('coal', 2)])!;
  assert.match(withChest, /现有燃料合计能烧约 24 件/);
  assert.match(withChest, /（箱子）/);
});

test('durabilityFacts：剩余耐久合计投影成还能挖的格数，换料缺口含箱子里的圆石', () => {
  const inv = [item('stone_pickaxe', 2, { durability: { left: 40, max: 131 }, durabilities: [50, 40] })];
  const out = durabilityFacts(inv, ['pickaxe']);
  assert.equal(out.length, 1);
  assert.match(out[0], /stone_pickaxe ×2，剩余耐久合计 90（按每挖一格耗 1 耐久，约还能挖 90 格）/);
  // 箱子里有圆石+木棍时，换料不再报"还差"
  const withChest = durabilityFacts(inv, ['pickaxe'], [row('cobblestone', 3), row('stick', 2)]);
  assert.match(withChest[0], /材料已经够了/);
});

test('consumptionSummary：聚合最近消耗的消耗品，非消耗品不计', () => {
  const summary = consumptionSummary([{ torch: 5, cobblestone: 12 }, { torch: 3, arrow: 2, stone_pickaxe: 1 }]);
  assert.match(summary!, /最近消耗的消耗品：/);
  assert.match(summary!, /torch×8/);
  assert.match(summary!, /cobblestone×12/);
  assert.ok(!/stone_pickaxe/.test(summary!));
  // 没有消耗品消耗时返回 null
  assert.equal(consumptionSummary([{ stone_pickaxe: 1 }, { iron_ingot: 2 }]), null);
});
