import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { InvItem } from '../src/adapter/types.ts';
import type { StockRow } from '../src/memory/chest-memory.ts';
import { consumptionSummary, durabilityFacts, fuelFacts, oreOpportunityFact, supplyFacts, supplyReading, toolBackupFact, torchCraftable } from '../src/brain/supply.ts';

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

test('supplyReading：常驻基线，各消耗品的存量/覆盖/缺口', () => {
  const inv = [
    item('torch', 12), item('coal', 3), item('stick', 6),
    item('apple', 2), item('cooked_beef', 1),
    item('arrow', 5), item('cobblestone', 40),
    item('stone_pickaxe', 2, { durability: { left: 40, max: 131 }, durabilities: [50, 40] }),
  ];
  const rows = supplyReading(inv, { torchEvery: 8 });
  const by = (id: string) => rows.find((r) => r.id === id)!;
  assert.equal(by('torch').reserve, 12);
  assert.match(by('torch').note, /约能照亮 96 格暗处/);
  assert.match(by('torch').note, /还能直接做 12 支/);
  assert.equal(by('food').reserve, 3);
  assert.match(by('food').note, /熟食 1 个/);
  assert.equal(by('pickaxe').reserve, 90);
  assert.match(by('pickaxe').note, /还能挖约 90 格/);
  assert.equal(by('arrow').reserve, 5);
  assert.equal(by('blocks').reserve, 40);
  assert.ok(by('fuel').reserve > 0);
  assert.match(by('fuel').note, /能烧约/);
  // 和平：火把只照明，不提刷怪
  assert.match(supplyReading(inv, { torchEvery: 8, difficulty: 'peaceful' }).find((r) => r.id === 'torch')!.note, /和平没怪/);
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

test('oreOpportunityFact：看见矿 + 现有存量 + 用途，采不采由它定；无矿返回 null', () => {
  const res = (block: string, seen: 'now' | 'memory' = 'now') => ({ block, count: 3, nearest: 4, dir: 'E', seen });
  // 看见铜，身上没有铜：报出铜锭/粗铜 ×0 与用途
  const f = oreOpportunityFact([res('copper_ore')], undefined, [item('iron_ingot', 2)]);
  assert.match(f!, /看见copper_ore×3（E4格）/);
  assert.match(f!, /copper_ingot×0、raw_copper×0/);
  assert.match(f!, /避雷针\/望远镜\/铜块/);
  assert.match(f!, /采不采、采多少由你/);
  // 深板岩变体算同一种矿
  assert.match(oreOpportunityFact([res('deepslate_iron_ore')], undefined, [])!, /iron_ingot×0/);
  // 箱子里的料也算进存量
  const withChest = oreOpportunityFact([res('coal_ore')], [row('coal', 5)], []);
  assert.match(withChest!, /coal×5/);
  // 没有矿石资源返回 null；非矿的方块不算
  assert.equal(oreOpportunityFact([res('oak_log')], undefined, []), null);
  assert.equal(oreOpportunityFact([], undefined, []), null);
  // 多块矿只挑最近的两块
  const two = oreOpportunityFact([res('copper_ore'), res('iron_ore'), res('gold_ore')], undefined, []);
  assert.ok(!two!.includes('gold_ore'), '只报最近的两块矿');
});

test('toolBackupFact：铁镐 + 铁锭不足（≤6）+ 没有耐用石镐时才提醒，做不做备用由它定', () => {
  // 有铁镐、铁锭 0、没有石镐 → 提醒
  const f = toolBackupFact([item('iron_pickaxe', 1), item('iron_ingot', 0)], undefined);
  assert.match(f!, /你包里有铁镐/);
  assert.match(f!, /铁锭只剩 0 个/);
  assert.match(f!, /石镐（3 圆石 \+ 2 木棍）/);
  assert.match(f!, /红石\/金\/钻石\/绿宝石/);
  assert.match(f!, /由你定/);
  // 铁锭 3、6 仍算紧缺（≤6，与 frugal 稀缺线一致）→ 提醒
  assert.match(toolBackupFact([item('iron_pickaxe', 1), item('iron_ingot', 3)], undefined)!, /铁锭只剩 3 个/);
  assert.match(toolBackupFact([item('iron_pickaxe', 1), item('iron_ingot', 6)], undefined)!, /铁锭只剩 6 个/);
  // 铁锭 7 → 宽裕，不提醒
  assert.equal(toolBackupFact([item('iron_pickaxe', 1), item('iron_ingot', 7)], undefined), null);
  // 有耐用的石镐（耐久 100/131）→ 不提醒
  assert.equal(toolBackupFact([item('iron_pickaxe', 1), item('stone_pickaxe', 1, { durability: { left: 100, max: 131 } }), item('iron_ingot', 0)], undefined), null);
  // 石镐快坏了（耐久 1/131）→ 等于没有，提醒
  assert.match(toolBackupFact([item('iron_pickaxe', 1), item('stone_pickaxe', 1, { durability: { left: 1, max: 131 } }), item('iron_ingot', 0)], undefined)!, /你包里有铁镐/);
  // 没耐久信息的石镐默认当可用 → 不误报
  assert.equal(toolBackupFact([item('iron_pickaxe', 1), item('stone_pickaxe', 1), item('iron_ingot', 0)], undefined), null);
  // 箱子里的铁锭也算
  assert.equal(toolBackupFact([item('iron_pickaxe', 1)], [row('iron_ingot', 7)]), null);
  assert.match(toolBackupFact([item('iron_pickaxe', 1)], [row('iron_ingot', 1)])!, /铁锭只剩 1 个/);
  // 没有铁镐 → null
  assert.equal(toolBackupFact([item('stone_pickaxe', 1)], undefined), null);
});
