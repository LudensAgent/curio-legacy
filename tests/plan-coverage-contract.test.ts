import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorldMemory } from '../src/memory/store.ts';
import { createActivity, describeActivity, planCoverageGap } from '../src/mind/activity.ts';
import { QUERY_ONLY_STEPS } from '../src/mind/step-capability.ts';
import { validateDraft } from '../src/mind/thinker.ts';
import { SKILLS } from '../src/skills/index.ts';
import { bodyMotionOf } from '../src/skills/types.ts';
import { TestWorld } from './survival-helpers.ts';

const state = () => ({ pos: { x: 0.5, y: 64, z: 0.5 }, inventory: [], worldId: 'w', dim: 'overworld' }) as any;
const make = (what: string, steps: { skill: string; args?: unknown }[], extra: Record<string, unknown> = {}) =>
  createActivity({ what, why: '', kind: 'gather', repeat: 1, steps, ...extra }, '', 'llm', state());

test('走到看见/记得的目标：gather/take_items/sleep/craft 算身体移动，不再误报覆盖缺口', () => {
  const cases: [string, { skill: string; args?: unknown }[]][] = [
    ['往南走到那棵橡树旁，砍够木头', [{ skill: 'gather', args: { block: 'oak_log', count: 8 } }]],
    ['走到身边看得见的箱子旁，取回圆石和火把', [{ skill: 'take_items', args: { item: 'cobblestone', count: 8 } }]],
    ['走到床边睡一觉，跳过黑夜', [{ skill: 'sleep', args: {} }]],
    ['走到工作台旁，把两把石镐合并修理', [{ skill: 'craft', args: { item: 'stone_pickaxe' } }]],
    ['从坑里垫两块圆石爬回地面，再走到床边睡过黑夜', [
      { skill: 'pillar_one', args: { item: 'cobblestone' } },
      { skill: 'sleep', args: {} },
    ]],
    ['走到床边右键床确认重生点', [{ skill: 'interact_block', args: { target: 'white_bed' } }]],
    ['走到看得见的箱子旁，打开它', [{ skill: 'use_gui', args: { target: 'chest' } }]],
    ['走到熔炉旁，把铁矿烧成铁', [{ skill: 'smelt', args: { item: 'raw_iron', count: 6 } }]],
  ];
  for (const [what, steps] of cases) assert.equal(planCoverageGap(make(what, steps)), null, what);
});

test('本来就是环顾/转头看的观察目标，不要求移动', () => {
  for (const [what, step] of [
    ['环顾四周，专门找看得见的橡木树干', { skill: 'look_around', args: {} }],
    ['转头扫视四周，找到能看见的橡木原木方块并记录坐标', { skill: 'look_around', args: {} }],
    ['抬起头看过去，确认那棵树的形状', { skill: 'look_around', args: {} }],
    ['看过去，查一下记得的箱子里原木还有多少', { skill: 'find_item', args: { item: 'oak_log' } }],
    ['看过去，查一下那条门还在不在', { skill: 'observe_portal', args: {} }],
    ['朝远处的树看，确认形状', { skill: 'look_around', args: {} }],
    ['查看远处的树是什么', { skill: 'look_around', args: {} }],
  ] as const) assert.equal(planCoverageGap(make(what, [step])), null, what);
});

test('真正只观察却要到远处时，仍报告覆盖缺口', () => {
  assert.match(planCoverageGap(make('走远找树，砍 6 根原木', [
    { skill: 'look_around', args: {} },
    { skill: 'find_item', args: { item: 'oak_log' } },
  ])) ?? '', /没有会让身体移动的动作/);
  assert.match(planCoverageGap(make('走到远处没去过的地方找树', [
    { skill: 'look_around', args: {} },
    { skill: 'find_item', args: { item: 'oak_log' } },
  ])) ?? '', /没有会让身体移动的动作/);
  assert.match(planCoverageGap(make('走到北边看见的下界传送门旁，看清门框', [
    { skill: 'look_around', args: {} },
  ])) ?? '', /没有会让身体移动的动作/);
  assert.match(planCoverageGap(make('走到远处找树，脚下垫一块就好', [
    { skill: 'place_support', args: { at: [1, -1, 0], item: 'cobblestone' } },
  ])) ?? '', /没有会让身体移动的动作/);
  for (const what of ['到远处的树林找树', '往远处找树', '向远处找树', '朝远处看，找树', '寻找远处的树']) {
    assert.match(planCoverageGap(make(what, [{ skill: 'look_around', args: {} }])) ?? '', /没有会让身体移动的动作/, what);
  }
  assert.match(planCoverageGap(make('走到远处查箱子', [
    { skill: 'find_item', args: { item: 'oak_log' } },
  ])) ?? '', /没有会让身体移动的动作/, 'find_item 只查记录，不能到远处');
});

test('当前活动把步骤能力贴出来，只在相关时出现', () => {
  const find = make('查清箱子里的铁锭', [{ skill: 'find_item', args: { item: 'iron_ingot' } }], {
    doneWhen: { type: 'inventory_min', item: 'iron_ingot', count: 6 },
  });
  assert.match(String(describeActivity(find, state()).step_capability ?? ''), /只有查询\/观察/);

  const inspect = make('查看背包', [{ skill: 'inspect_inventory', args: {} }], {
    doneWhen: { type: 'inventory_min', item: 'iron_ingot', count: 6 },
  });
  assert.match(String(describeActivity(inspect, state()).step_capability ?? ''), /只有查询\/观察/, 'readOnly 技能也应有能力提示');

  const take = make('从箱子取出铁锭', [{ skill: 'take_items', args: { item: 'iron_ingot', count: 6 } }], {
    doneWhen: { type: 'inventory_min', item: 'iron_ingot', count: 6 },
  });
  assert.equal(describeActivity(take, state()).step_capability, undefined, 'take_items 不在“不产生物品”集合里');

  const look = make('朝北探路', [{ skill: 'look_around', args: {} }], {
    doneWhen: { type: 'exploration', min_distance: 16 },
  });
  assert.match(String(describeActivity(look, state()).done_when?.progress_note ?? ''), /只证明推进量/);

  const gather = make('砍 8 根原木', [{ skill: 'gather', args: { block: 'oak_log', count: 8 } }]);
  assert.equal(describeActivity(gather, state()).step_capability, undefined, '普通采集不出现能力提示');

  for (const steps of [
    [{ skill: 'move_step', args: { at: [1, 0, 0] } }],
    [{ skill: 'sleep', args: {} }],
    [{ skill: 'craft', args: { item: 'stone_pickaxe' } }],
  ]) {
    const activity = make('做点事', steps);
    assert.equal(describeActivity(activity, state()).step_capability, undefined, `${steps[0].skill} 不是查询/观察`);
  }
});

test('take_items 不再被 done_when 误判为不会产生物品', (t) => {
  const adapter = new TestWorld(), memory = new WorldMemory(null);
  t.after(() => memory.close());
  const draft = validateDraft({
    what: '从箱子取出铁锭',
    steps: [{ skill: 'take_items', args: { item: 'iron_ingot', count: 6, target: { x: 0, y: 64, z: 0 } } }],
    done_when: { type: 'inventory_min', item: 'iron_ingot', count: 6 },
  }, adapter, memory, []);
  assert.ok(!('error' in draft), 'error' in draft ? draft.error : '');

  const noSee = validateDraft({
    what: '走到记得的门旁，看看门还在不在',
    steps: [{ skill: 'approach_visible', args: { target: { pos: { x: 0, y: 64, z: 0 } } } }],
    done_when: { type: 'exploration', find: 'nether_portal' },
  }, adapter, memory, []);
  assert.ok('error' in noSee);
  assert.match(noSee.error, /不会观察目标/, 'approach_visible 只到已看见/记得的目标，不保证本次看见');
});

test('查询/观察集合按 readOnly 元数据派生，并补上 look/observe_portal', () => {
  assert.ok(QUERY_ONLY_STEPS.has('inspect_inventory'));
  assert.ok(QUERY_ONLY_STEPS.has('base_memory'));
  assert.ok(QUERY_ONLY_STEPS.has('look'));
  assert.ok(QUERY_ONLY_STEPS.has('observe_portal'));
  assert.ok(!QUERY_ONLY_STEPS.has('gather'));
});

test('bodyMotion 标注与动作契约一致', () => {
  assert.equal(bodyMotionOf(SKILLS.use_gui), 'horizontal', 'use_gui 在适配器里会走到容器旁');
  assert.equal(bodyMotionOf(SKILLS.smelt), 'horizontal', 'smelt 会走到熔炉旁');
  assert.equal(bodyMotionOf(SKILLS.sleep), 'horizontal', 'sleep 会走到床旁');
  assert.equal(bodyMotionOf(SKILLS.craft), 'horizontal', 'craft 会走到已知工作台旁');
  assert.equal(bodyMotionOf(SKILLS.pillar_one), 'vertical');
  assert.equal(bodyMotionOf(SKILLS.mine_cell), 'vertical');
  assert.equal(bodyMotionOf(SKILLS.place_support), 'none', '侧移不算带到目标位置');
});
