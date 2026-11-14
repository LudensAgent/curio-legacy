import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { InvItem } from '../src/adapter/types.ts';
import type { StockRow } from '../src/memory/chest-memory.ts';
import { consumptionSummary, durabilityFacts, fuelFacts, oreOpportunityFact, supplyFacts, supplyReading, toolTierFact, torchCraftable } from '../src/brain/supply.ts';

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
  assert.match(f!, /采不采、采多少按当前目标和余力/);
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

test('toolTierFact：铁镐 + 有可用石镐也要报事实（不再因为它能用就沉默）', () => {
  const inv = [
    item('iron_pickaxe', 1, { durability: { left: 250, max: 250 } }),
    item('stone_pickaxe', 1, { durability: { left: 100, max: 131 } }),
    item('iron_ingot', 0),
  ];
  const f = toolTierFact({ inventory: inv, digging: true })!;
  assert.ok(f);
  assert.match(f.text, /铁镐×1（耐久 250\/250）/);
  assert.match(f.text, /石镐×1（耐久 100\/131，合计还能挖约 100 格）/);
  assert.match(f.text, /铁锭只剩 0 个，现在做不出新的铁镐（做一把新的要 3 个）/);
  assert.match(f.text, /石镐能挖石头\/煤\/铜\/铁\/青金石/);
  assert.match(f.text, /红石\/金\/钻石\/绿宝石才必须铁镐/);
  assert.match(f.text, /铁镐坏了做不出新的；石镐坏了能再做/);
  assert.match(f.text, /要用现有石镐就先 hold_item stone_pickaxe，或给 mine_cell \/ excavate_run 写 tool:"stone_pickaxe"/);
  assert.match(f.text, /换不换、做不做看当前材料和耐久/);
  assert.match(f.key, /tier:iron/);
  assert.match(f.key, /cheap:stone:1:ok/);
  // 主手拿着便宜镐时不要再叫它去拿
  const heldCheap = toolTierFact({ inventory: inv, held: 'stone_pickaxe', digging: true })!;
  assert.match(heldCheap.text, /主手就是石镐/);
  assert.doesNotMatch(heldCheap.text, /要换就先 hold_item stone_pickaxe/);
  assert.match(heldCheap.key, /held:pickaxe/);
  // 速度是换高阶镐唯一的好处：两边都量化摆出来
  assert.match(heldCheap.text, /挖普通石头每格约：石镐 0\.55 秒、铁镐 0\.4 秒/);
  // 换到不可补的铁镐上挖：要重新说一次，并说清每格都在耗它（实机：给了铁镐马上换上去挖石头阶梯，之后再没提示）
  const heldHigh = toolTierFact({ inventory: inv, held: 'iron_pickaxe', digging: true })!;
  assert.notEqual(heldHigh.key, heldCheap.key, '换到不可补的高阶镐上必须重新提示');
  assert.match(heldHigh.key, /held:high/);
  assert.match(heldHigh.text, /现在主手就是铁镐：每挖一格都耗它 1 点耐久，坏了没得补/);
  assert.match(heldHigh.text, /要用现有石镐就先 hold_item stone_pickaxe/);
  assert.notEqual(
    toolTierFact({ inventory: [item('iron_pickaxe', 1), item('stone_pickaxe', 1, { durability: { left: 1, max: 131 } }), item('iron_ingot', 0)], digging: true })!.key,
    f.key,
  );
});

test('toolTierFact：便宜镐快坏了，报做一把的真实缺口（木棍/原木这类嵌套也报）', () => {
  const inventory = [
    item('iron_pickaxe', 1),
    item('stone_pickaxe', 1, { durability: { left: 18, max: 131 } }),
    item('cobblestone', 30), item('stick', 0), item('oak_log', 1), item('iron_ingot', 0),
  ];
  const f = toolTierFact({ inventory, digging: true })!;
  assert.match(f.text, /包里的石镐×1（耐久 18\/131）剩余都不足 15%，合计还能挖约 18 格/);
  assert.match(f.text, /要用现有石镐就先 hold_item stone_pickaxe/);
  assert.match(f.text, /再做一把石镐：做 stone_pickaxe×1/);
  // 1 根原木够做木棍 → 报材料够，并顺带列出中间品
  assert.match(f.text, /材料已经够了/);
  assert.match(f.text, /stick/);
  // 没有原木 → 缺口一路追到原木
  const noLog = toolTierFact({ inventory: inventory.filter((i) => i.name !== 'oak_log'), digging: true })!;
  assert.match(noLog.text, /做 stone_pickaxe×1 还差：原木×1（哪种都行）/);
  assert.match(noLog.key, /craft:/);
});

test('toolTierFact：材料只在箱子里时，不说“背包里已经够了”', () => {
  const inv = [item('diamond_pickaxe', 1), item('diamond', 0), item('stick', 1)];
  const f = toolTierFact({
    inventory: inv,
    stock: [row('cobblestone', 156), row('stick', 8)],
    digging: true,
  })!;
  assert.ok(f);
  assert.match(f.text, /箱子里够，但背包里还差/);
  assert.match(f.text, /cobblestone×3/);
  assert.match(f.text, /先 take_items 取回再合成/);
  assert.doesNotMatch(f.text, /再做一把石镐：做 stone_pickaxe×1 的材料已经够了/);
});

test('toolTierFact：没有便宜镐、也做不出便宜镐时仍报真实缺口，不沉默', () => {
  const f = toolTierFact({ inventory: [item('iron_pickaxe', 1), item('iron_ingot', 0)], digging: true })!;
  assert.ok(f, '线上“石镐没补”的场景不能因为没有现成便宜镐就不提');
  assert.match(f.text, /包里没有石镐/);
  assert.match(f.text, /再做一把石镐：做 stone_pickaxe×1 还差/);
  assert.match(f.text, /圆石|原木/);
  assert.match(f.key, /craft:/);
});

test('toolTierFact：木镐是最便宜候选时，不宣称它能挖铜/铁/青金石', () => {
  const f = toolTierFact({
    inventory: [item('iron_pickaxe', 1), item('oak_log', 4), item('iron_ingot', 0)],
    digging: true,
  })!;
  assert.ok(f);
  assert.match(f.text, /木镐能挖石头\/煤/);
  assert.match(f.text, /铜\/铁\/青金石至少要石镐/);
  assert.doesNotMatch(f.text, /木镐能挖石头\/煤\/铜/);
});

test('toolTierFact：钻石镐 + 只有石镐可用时，补上“红石/金/钻石/绿宝石要铁镐”这一层', () => {
  const f = toolTierFact({
    inventory: [item('diamond_pickaxe', 1), item('stone_pickaxe', 1), item('diamond', 0)],
    digging: true,
  })!;
  assert.ok(f);
  assert.match(f.text, /石镐能挖石头\/煤\/铜\/铁\/青金石/);
  assert.match(f.text, /红石\/金\/钻石\/绿宝石至少要铁镐/);
  assert.match(f.text, /远古残骸\/黑曜石才必须钻石镐/);
});

test('toolTierFact：钻石镐档次下，便宜铁镐可用也报事实', () => {
  const f = toolTierFact({
    inventory: [
      item('diamond_pickaxe', 1, { durability: { left: 1000, max: 1561 } }),
      item('iron_pickaxe', 1, { durability: { left: 200, max: 250 } }),
      item('diamond', 0),
    ],
    digging: true,
  })!;
  assert.match(f.text, /钻石镐×1（耐久 1000\/1561）/);
  assert.match(f.text, /铁镐×1（耐久 200\/250，合计还能挖约 200 格）/);
  assert.match(f.text, /钻石只剩 0 个，现在做不出新的钻石镐（做一把新的要 3 个）/);
  assert.match(f.text, /只有远古残骸\/黑曜石才必须钻石镐/);
  assert.match(f.text, /hold_item iron_pickaxe/);
  assert.match(f.key, /tier:diamond/);
  assert.match(f.key, /cheap:iron:1:ok/);
});

test('toolTierFact：材料宽裕 / 没在挖 / 最高档只有石镐时返回 null', () => {
  // 铁锭 7 → 宽裕
  assert.equal(toolTierFact({ inventory: [item('iron_pickaxe', 1), item('iron_ingot', 7), item('stone_pickaxe', 1)], digging: true }), null);
  // 没在挖 → 投放门控在函数自身也生效
  assert.equal(toolTierFact({ inventory: [item('iron_pickaxe', 1), item('stone_pickaxe', 1), item('iron_ingot', 0)], digging: false }), null);
  // 最高档只有石镐 → 不是一个需要换便宜镐的场景
  assert.equal(toolTierFact({ inventory: [item('stone_pickaxe', 1), item('wooden_pickaxe', 1)], digging: true }), null);
});

test('toolTierFact：稀缺材料按箱子账本合计，held 进 key', () => {
  assert.equal(toolTierFact({ inventory: [item('iron_pickaxe', 1)], stock: [row('iron_ingot', 7)], digging: true }), null);
  const f = toolTierFact({
    inventory: [item('iron_pickaxe', 1), item('cobblestone', 3), item('oak_log', 1)],
    stock: [row('iron_ingot', 1)],
    held: 'iron_pickaxe',
    digging: true,
  })!;
  assert.match(f.text, /铁锭只剩 1 个/);
  assert.match(f.text, /再做一把石镐：做 stone_pickaxe×1/);
  assert.match(f.key, /held:high/, '主手是不可补的铁镐');
  assert.match(f.key, /mat:1/);
});
