import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentState } from '../src/adapter/types.ts';
import { createActivity, recordOf } from '../src/mind/activity.ts';

const state = (inventory: { name: string; count: number }[] = []) => ({
  connected: true, alive: true, observationReady: true, observationId: 1, username: 'tester',
  sessionId: 's', worldId: 'w', dim: 'the_nether', pos: { x: 0.5, y: 64, z: 0.5 },
  hp: 20, food: 20, oxygen: 20, timeOfDay: 0,
  inventory, emptySlots: 36 - inventory.length, equipment: [], held: null,
} as unknown as AgentState);

test('开路副产物不自动变成资源取得，也不把隧道施工报成资源目标失败', () => {
  const a = createActivity({
    what: '沿北向开两格高平巷', why: '', kind: 'explore', repeat: 1,
    steps: [{ skill: 'excavate_run', args: { direction: 'N', mode: 'tunnel', steps: 16 } }],
  }, '', 'llm', state());
  a.results.push({
    skill: 'excavate_run', args: {}, status: 'succeeded', summary: '挖开 6 格', at: Date.now(), durationMs: 50,
    pos: { x: 0.5, y: 64, z: -3.5 }, data: { dug: ['netherrack', 'netherrack'], moved: 2 },
  });
  const record = recordOf(a, 'done', '开到 16 格', state([{ name: 'netherrack', count: 6 }]));
  assert.equal(record.resource, undefined, '标题和步骤都没有点名资源，就不生成资源结论');
  assert.equal(record.gained.netherrack, 6, '副产物仍按实际背包增量记录');
});

test('标题点名的目标只用实际产物验收，挖掘动作本身不证明取得目标', () => {
  const a = createActivity({
    what: '找铁矿', why: '', kind: 'explore', repeat: 1,
    steps: [{ skill: 'gather', args: { block: 'iron_ore', count: 3 } }],
  }, '', 'llm', state());
  a.results.push({
    skill: 'mine_cell', args: {}, status: 'succeeded', summary: '挖掉一格', at: Date.now(), durationMs: 10,
    pos: { x: 0.5, y: 64, z: 1.5 }, data: { was: 'netherrack', dug: 1 },
  });
  const record = recordOf(a, 'done', '只挖到地狱岩', state([{ name: 'netherrack', count: 1 }]));
  assert.equal(record.resource?.intent, true);
  assert.deepEqual(record.resource?.targets, ['iron_ore']);
  assert.equal(record.resource?.acquired, false, '标题说要铁，挖到地狱岩不能冒充取得');
  assert.equal(record.resource?.goalIncomplete, true, '资源意图还在，但没有可确认的取得');
});

test('点名目标时只认目标物品：挖到别的方块不算取得', () => {
  const a = createActivity({
    what: '采铁矿', why: '', kind: 'gather', repeat: 1,
    steps: [{ skill: 'gather', args: { block: 'iron_ore', count: 3 } }],
  }, '', 'llm', state());
  a.results.push({
    skill: 'gather', args: {}, status: 'succeeded', summary: '挖到 2 块地狱岩', at: Date.now(), durationMs: 10,
    pos: { x: 0.5, y: 64, z: 1.5 }, data: { was: 'netherrack', dug: 2 },
  });
  const wrong = recordOf(a, 'done', '只挖到地狱岩', state([{ name: 'netherrack', count: 2 }]));
  assert.ok(wrong.resource?.targets?.includes('iron_ore'), '步骤点名的铁矿仍是目标');
  assert.equal(wrong.resource?.located, false);
  assert.equal(wrong.resource?.acquired, false);
  assert.equal(wrong.resource?.goalIncomplete, true);

  const right = recordOf(a, 'done', '拿到粗铁', state([{ name: 'raw_iron', count: 2 }]));
  assert.equal(right.resource?.acquired, true);
  assert.equal(right.resource?.goalIncomplete, false);
});

test('活动历史保留结构化停止原因与边界，不复制整段路线', async () => {
  const { afterStep, nextStep } = await import('../src/mind/activity.ts');
  const a = createActivity({
    what: '往北推进', why: '', kind: 'explore', repeat: 1,
    steps: [{ skill: 'advance', args: { direction: 'N', distance: 96 } }],
  }, '', 'llm', state());
  const step = nextStep(a)!;
  const boundary = { from: { x: 0, y: 64, z: -3 }, to: { x: 0, y: 64, z: -4 }, status: 'UNKNOWN' };
  const verdict = afterStep(a, step, {
    status: 'failed', failureCode: 'NOT_FOUND', summary: '搜索证据不足',
    data: { stop: { reason: 'CONFLICT', detail: '搜索与复验不一致', boundaries: [boundary, boundary, boundary, boundary] } },
  }, 10, state());
  assert.equal(verdict.kind, 'stuck');
  const recorded = a.results.at(-1)!;
  assert.equal((recorded.data?.stop as { reason?: string }).reason, 'CONFLICT', 'afterStep 保留结构化停止原因');
  const record = recordOf(a, 'stuck', '搜索证据不足', state());
  assert.equal(record.stop?.reason, 'CONFLICT');
  assert.equal(record.stop?.detail, '搜索与复验不一致');
  assert.equal(record.stop?.boundaries?.length, 3, '边界只留少量，避免活动历史复制整段路线');
});

test('放置/装备的 item 是耗材或持物，不是采集目标', () => {
  const a = createActivity({
    what: '用圆石补支撑', why: '', kind: 'build', repeat: 1,
    steps: [{ skill: 'place_support', args: { item: 'cobblestone' } }],
  }, '', 'llm', state([{ name: 'cobblestone', count: 1 }]));
  a.results.push({
    skill: 'place_support', args: {}, status: 'succeeded', summary: '放了圆石', at: Date.now(), durationMs: 10,
    pos: { x: 0.5, y: 64, z: 1.5 }, data: { placed: 'cobblestone', effect: { kind: 'support_formed', confirmed: true } },
  });
  const record = recordOf(a, 'done', '补好支撑', state());
  assert.equal(record.lost.cobblestone, 1, '耗材照实记在 lost');
  assert.equal(record.resource, undefined, '耗材不能被当成资源取得目标');
});

test('背包里多了开路副产物不算空间/目标进展', async () => {
  const { progressSignals } = await import('../src/mind/activity.ts');
  const side = progressSignals({ exploration: { found: [] } }, { newChunks: false, planAdvanced: false, frontierAdvanced: false });
  assert.equal(side.progressed, false, '副产物不清空间停滞');
  assert.equal(progressSignals({ exploration: { found: ['oak_log'] } }, { newChunks: false, planAdvanced: false, frontierAdvanced: false }).progressed, true, '看见目标算进展');
  assert.equal(progressSignals({ exploration: { found: [] }, resource: { intent: true, acquired: true, located: true, goalIncomplete: false } }, { newChunks: false, planAdvanced: false, frontierAdvanced: false }).progressed, true, '取得点名目标算进展');
  assert.equal(progressSignals({ exploration: { found: [] } }, { newChunks: true, planAdvanced: false, frontierAdvanced: false }).progressed, true, '新区块算进展');
});

test('混合施工+移动不因标题材料词产生资源目标；嵌套条件里的目标能递归提取', () => {
  const mixed = createActivity({
    what: '用木板补路再走两格', why: '', kind: 'build', repeat: 1,
    steps: [{ skill: 'place_support', args: { item: 'oak_planks' } }, { skill: 'move_step', args: { at: [1, 0, 0] } }],
  }, '', 'llm', state([{ name: 'oak_planks', count: 2 }]));
  const record = recordOf(mixed, 'done', '补好路并走了两格', state());
  assert.equal(record.resource, undefined, '施工+移动不是采集目标');
  assert.equal(record.lost.oak_planks, 2);

  const nested = createActivity({
    what: '准备材料', why: '', kind: 'build', repeat: 1,
    steps: [{ skill: 'place_support', args: { item: 'cobblestone' } }],
    doneWhen: { type: 'all_of', conditions: [{ type: 'inventory_min', item: 'iron_ingot', count: 3 }, { type: 'position_y', max: 64 }] },
  }, '', 'llm', state([{ name: 'cobblestone', count: 1 }]));
  const nestedRecord = recordOf(nested, 'stuck', '没拿到铁', state());
  assert.ok(nestedRecord.resource?.targets?.includes('iron_ingot'), 'all_of 里的资源目标要递归提取');
});

test('标题里的工具/耗材词不参与资源目标推断', () => {
  const tunnel = createActivity({
    what: '用铁镐向北挖通通道', why: '', kind: 'explore', repeat: 1,
    steps: [{ skill: 'excavate_run', args: { direction: 'N', mode: 'tunnel', steps: 16, tool: 'iron_pickaxe' } }],
  }, '', 'llm', state());
  assert.equal(recordOf(tunnel, 'done', '挖了 16 格', state()).resource, undefined, '铁镐不是取得目标');

  const patch = createActivity({
    what: '补木板后继续挖两格', why: '', kind: 'build', repeat: 1,
    steps: [{ skill: 'place_support', args: { item: 'oak_planks' } }, { skill: 'excavate_run', args: { direction: 'N', steps: 2 } }],
  }, '', 'llm', state([{ name: 'oak_planks', count: 1 }]));
  assert.equal(recordOf(patch, 'done', '补好并挖了两格', state()).resource, undefined, '木板是耗材');
});

test('explore_toward.until 进入目标记录，未发现时留下目标缺口', () => {
  const a = createActivity({
    what: '向北探索找下界砖', why: '', kind: 'explore', repeat: 1,
    steps: [{ skill: 'explore_toward', args: { direction: 'N', distance: 96, until: 'nether_bricks|log' } }],
  }, '', 'llm', state());
  a.results.push({ skill: 'explore_toward', args: {}, status: 'succeeded', summary: '走了 96 格，没看见目标', at: Date.now(), durationMs: 100,
    pos: { x: 0.5, y: 64, z: -95.5 }, data: { travelled: 96, found: undefined } });
  const record = recordOf(a, 'done', '走到 96 格', state());
  assert.deepEqual(record.resource?.targets, ['nether_bricks', 'log']);
  assert.equal(record.resource?.located, false);
  assert.equal(record.resource?.goalIncomplete, true, '有 until 目标但没发现，记录为缺口');
});

test('只找不取的 until 目标以“看见”验收，找到后不算未完成', () => {
  const a = createActivity({
    what: '向北探索找下界砖', why: '', kind: 'explore', repeat: 1,
    steps: [{ skill: 'explore_toward', args: { direction: 'N', distance: 96, until: 'nether_bricks' } }],
  }, '', 'llm', state());
  a.results.push({ skill: 'explore_toward', args: {}, status: 'succeeded', summary: '看见下界砖', at: Date.now(), durationMs: 100,
    pos: { x: 0.5, y: 64, z: -50.5 }, data: { travelled: 50, found: 'nether_bricks' } });
  const record = recordOf(a, 'done', '看见下界砖', state());
  assert.equal(record.resource?.mode, 'find');
  assert.equal(record.resource?.located, true);
  assert.equal(record.resource?.acquired, null);
  assert.equal(record.resource?.goalIncomplete, false, '看见目标即完成寻找类目标');
});
