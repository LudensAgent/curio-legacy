import assert from 'node:assert/strict';
import { test } from 'node:test';
import { budgetIssues, buildDesignMessages, buildKindOf, critique } from '../src/building/architect.ts';
import { normalizeSpec } from '../src/building/spec.ts';
import { BUILTIN_SKILLS_DIR, SkillBook } from '../src/knowledge/skillbook.ts';

// 5×5 墙脚的圆石前哨：平顶、没窗户，屋里有床位、箱子、工作台、熔炉和火把
const outpost = { legend: { C: 'cobblestone', D: 'oak_door', K: 'chest', B: 'crafting_table', F: 'furnace', T: 'torch', '.': 'air' }, layers: [
  ['CCCCC', 'CCCCC', 'CCCCC', 'CCCCC', 'CCCCC'],
  ['CCDCC', 'CK.BC', 'C.T.C', 'C..FC', 'CCCCC'],
  ['CCCCC', 'C...C', 'C...C', 'C...C', 'CCCCC'],
  ['CCCCC', 'CCCCC', 'CCCCC', 'CCCCC', 'CCCCC'],
] };
// 一圈栅栏的畜栏
const pen = { legend: { G: 'grass_block', f: 'oak_fence', D: 'oak_door', '.': 'air' }, layers: [
  ['GGGGGGG', 'GGGGGGG', 'GGGGGGG', 'GGGGGGG', 'GGGGGGG'],
  ['fffDfff', 'f.....f', 'f.....f', 'f.....f', 'fffffff'],
  ['   .   ', '       ', '       ', '       ', '       '],
] };

test('建筑师认得出要盖的是什么：住处、前哨、其他实用建筑', () => {
  assert.equal(buildKindOf('在矿口旁搭一个带床和箱子的前哨'), 'outpost');
  assert.equal(buildKindOf('7×7 的云杉木小屋，坡屋顶'), 'dwelling');
  assert.equal(buildKindOf('家旁边的仓库，放二十个箱子'), 'dwelling', '提到家也算住处的说法时按住处查（宁严勿松）');
  assert.equal(buildKindOf('圈羊的畜栏'), 'utility');
  assert.equal(buildKindOf('能看远处的瞭望塔'), 'utility');
  assert.equal(buildKindOf('一个好看的东西'), 'dwelling', '认不出来按住处');
});

test('前哨不挑窗户和坡顶，但要有箱子、工作台、熔炉和灯；畜栏只查盖不盖得上', () => {
  const spec = normalizeSpec({ name: '矿口前哨', design: outpost });
  const asHouse = critique(spec, 'dwelling');
  assert.ok(asHouse.some((i) => /窗户/.test(i)), '当住处查会要窗户');
  assert.deepEqual(critique(spec, 'outpost'), []);
  const bare = normalizeSpec({ name: '空前哨', design: { ...outpost, layers: outpost.layers.map((l) => l.map((r) => r.replace(/[KBFT]/g, '.'))) } });
  const issues = critique(bare, 'outpost');
  assert.ok(issues.some((i) => /箱子/.test(i)) && issues.some((i) => /熔炉/.test(i)) && issues.some((i) => /光源/.test(i)));
  assert.deepEqual(critique(normalizeSpec({ name: '畜栏', design: pen }), 'utility'), []);
});

test('实用小建筑要省料；请求里带着这类建筑的提示，说明只能盖在露天干地上', () => {
  const big = { legend: { P: 'oak_planks', D: 'oak_door', '.': 'air' }, layers: Array.from({ length: 6 }, (_, y) => Array.from({ length: 9 }, (_, z) => (y === 1 && z === 0 ? 'PPPPDPPPP' : 'PPPPPPPPP'))) };
  assert.ok(budgetIssues(normalizeSpec({ name: '大仓库', design: big }), { pastWorks: ['小屋'] }, 'utility').some((i) => /省料|费料/.test(i)));
  assert.deepEqual(budgetIssues(normalizeSpec({ name: '前哨', design: outpost }), { pastWorks: [] }, 'outpost'), []);
  const book = new SkillBook(BUILTIN_SKILLS_DIR, null);
  const [system, user] = buildDesignMessages({ brief: '矿口前哨，放床箱子熔炉', persona: '我', inventory: [], nearby: [], likes: [], pastWorks: [] }, book);
  assert.match(system.content, /露天的干地/);
  assert.match(system.content, /前哨\/补给点/, '设计手册里有前哨的写法');
  const payload = JSON.parse(user.content.split('\n')[0]);
  assert.match(payload.kind, /前哨/);
  assert.match(payload.budget, /实用的小建筑/);
});
