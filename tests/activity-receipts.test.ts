import assert from 'node:assert/strict';
import { test } from 'node:test';
import { afterStep, createActivity, describeActivity, nextStep, planCoverageGap, recordOf } from '../src/mind/activity.ts';

const pos = { x: 0.5, y: 64, z: 0.5 };
const state = (inventory: { name: string; count: number }[] = []) => ({ pos: { ...pos }, inventory, worldId: 'w', dim: 'overworld' }) as any;
const make = (what: string, steps: { skill: string; args?: unknown }[], extra: Record<string, unknown> = {}) =>
  createActivity({ what, why: '', kind: 'gather', repeat: 1, steps, ...extra }, '', 'llm', state());

test('计划声称走远/换地方，却只有观察或采集：报告计划覆盖缺口', () => {
  const onlyLook = make('沿地表走远找树，砍 6 根原木', [
    { skill: 'look_around', args: { for: 'log' } },
    { skill: 'gather', args: { block: 'log' } },
  ]);
  assert.match(planCoverageGap(onlyLook) ?? '', /没有会实际移动身体的动作/);

  const moved = make('沿地表走远找树，砍 6 根原木', [
    { skill: 'move_step', args: { at: [1, 0, 0] } },
    { skill: 'look_around', args: { for: 'log' } },
  ]);
  assert.equal(planCoverageGap(moved), null);

  const jumpOnly = make('走远找树', [{ skill: 'press_keys', args: { keys: { jump: true }, ms: 500 } }]);
  assert.ok(planCoverageGap(jumpOnly), '只原地跳不算移动');
  const forward = make('走远找树', [{ skill: 'press_keys', args: { keys: { forward: true }, ms: 500 } }]);
  assert.equal(planCoverageGap(forward), null);

  const approached = make('走到北边一格看得见的草地格', [
    { skill: 'approach_visible', args: { target: { pos: { x: 1, y: 64, z: 0 } } } },
  ]);
  assert.equal(planCoverageGap(approached), null, 'approach_visible 会移动身体，不算覆盖缺口');
});

test('approach_visible 已实测抵达后，不再因 exploration.min_distance 重复执行', () => {
  const args = { target: { pos: { x: 2, y: 64, z: 0 } } };
  const a = make('接近北边两格的方块', [{ skill: 'approach_visible', args }], {
    repeat: 3,
    doneWhen: { type: 'exploration', min_distance: 16 },
  });
  const step = nextStep(a)!;
  const verdict = afterStep(a, step, {
    status: 'succeeded', summary: '已接近目标', data: { outcome: 'ARRIVED', displacement: 2 },
  }, 10, state());
  assert.equal(verdict.kind, 'done');
  if (verdict.kind === 'done') {
    assert.equal(verdict.met, false, 'exploration 距离未满足仍如实记 false');
    assert.match(verdict.why, /不会产生新的探索距离/);
  }
});

test('没有实测 ARRIVED 时不按“已抵达”收工，仍交给原活动流程', () => {
  const args = { target: { pos: { x: 2, y: 64, z: 0 } } };
  const a = make('接近北边两格的方块', [{ skill: 'approach_visible', args }], {
    repeat: 3,
    doneWhen: { type: 'exploration', min_distance: 16 },
  });
  const step = nextStep(a)!;
  const verdict = afterStep(a, step, {
    status: 'succeeded', summary: '只完成部分接近', data: { outcome: 'PARTIAL' },
  }, 10, state());
  assert.notEqual(verdict.kind, 'done');
});

test('收工条件不能验收目标时记为有界尝试，资源目标未完成', () => {
  const a = make('找木料砍原木', [{ skill: 'find_item', args: { item: 'oak_log' } }], {
    doneWhen: { type: 'self_state', field: 'held', equals: 'stone_axe' },
  });
  a.attemptOnly = { reason: '收工条件开工前就已成立，不能用来验收目标', originalDoneWhen: a.doneWhen };
  delete (a as any).doneWhen;
  const record = recordOf(a, 'done', '步骤都做完了', state());
  assert.equal(record.completion, 'attempt');
  assert.equal(record.operationCompleted, true);
  assert.equal(record.resource?.intent, true);
  assert.equal(record.resource?.acquired, false);
  assert.equal(record.resource?.goalIncomplete, true);
  const described = describeActivity(a, state());
  assert.match(String(described.attempt_only), /不能用来验收目标/);
  assert.equal(described.original_done_when, a.attemptOnly!.originalDoneWhen);
});

test('查询记录/到达都不算定位资源；真正看见或采到才算', () => {
  const queryOnly = make('找木料', [{ skill: 'find_item', args: { item: 'oak_log' } }]);
  queryOnly.results.push({ skill: 'find_item', args: {}, status: 'succeeded', summary: '记录里没有', at: Date.now(), durationMs: 2, pos: { ...pos } });
  const noSource = recordOf(queryOnly, 'done', '查询完成', state());
  assert.equal(noSource.resource?.located, false);
  assert.equal(noSource.resource?.acquired, false);
  assert.equal(noSource.resource?.goalIncomplete, true);

  const looked = make('找木料', [{ skill: 'look_around', args: { for: 'oak_log' } }]);
  looked.results.push({ skill: 'look_around', args: {}, status: 'succeeded', summary: '看见 oak_log', at: Date.now(), durationMs: 2, pos: { ...pos }, data: { found: 'oak_log' } });
  assert.equal(recordOf(looked, 'done', '看见目标', state()).resource?.located, true);

  const gathered = make('砍木料', [{ skill: 'gather', args: { block: 'log' } }]);
  gathered.results.push({ skill: 'gather', args: {}, status: 'succeeded', summary: '采集了 2 个 log', at: Date.now(), durationMs: 2, pos: { ...pos }, data: { dug: 2 } });
  const got = recordOf(gathered, 'done', '采集完成', state([{ name: 'oak_log', count: 2 }]));
  assert.equal(got.resource?.acquired, true);
  assert.equal(got.resource?.goalIncomplete, false);
});

test('失败回执保留动作发生时的世界/维度与实测时间，不用活动结束位置回填', () => {
  const a = make('授权寻路', [{ skill: 'travel_to', args: { to: { x: 10, z: 0 }, allowDig: false } }]);
  const step = nextStep(a)!;
  afterStep(a, step, { status: 'failed', failureCode: 'PATH_NOT_FOUND', summary: '按当前授权没找到路线' }, 10, { ...state(), worldId: 'w', dim: 'the_nether' });
  const failed = a.results.at(-1)!;
  const record = recordOf(a, 'stuck', '没有走通', state());
  assert.equal(record.failure?.skill, 'travel_to');
  assert.equal(record.failure?.at, failed.at);
  assert.equal(record.failure?.worldId, 'w');
  assert.equal(record.failure?.dim, 'the_nether');
  assert.equal((record.failure?.args as { allowDig?: boolean }).allowDig, false);
  assert.equal(record.failure?.summary, '按当前授权没找到路线');
});

test('continue_effect 按正在执行的步骤和剩余 index/repeat 说明继续会做什么', () => {
  const steps = [
    { skill: 'gather', args: { block: 'oak_log', count: 4 } },
    { skill: 'craft', args: { item: 'oak_planks', count: 1 } },
  ];
  const running = (skill: string, args: unknown) => ({ skill, args, source: 'llm', startedAt: Date.now() });

  const finalStep = make('砍木头再做木板', steps, { repeat: 2 });
  finalStep.iteration = 0;
  finalStep.index = 2; // 两步都已派发，第一步仍在执行
  const finalEffect = describeActivity(finalStep, state(), undefined, running('craft', { item: 'oak_planks', count: 1 })).continue_effect as Record<string, unknown>;
  assert.equal(finalEffect.position, 'in_flight_final_step');
  assert.equal(finalEffect.remaining_steps_after_running, 2, '不含正在执行的终步，但还有一整轮');
  assert.equal(finalEffect.remaining_rounds, 1);
  assert.match(String(finalEffect.executes_if_continue), /本轮已无已排后续步骤.*若没有失败\/取消.*还有 1 轮/);
  assert.equal(finalEffect.done_when_can_stop_early, false);

  const withFollowing = make('砍木头再做木板', steps, { repeat: 2 });
  withFollowing.index = 1;
  const followingEffect = describeActivity(withFollowing, state(), undefined, running('gather', { block: 'oak_log', count: 4 })).continue_effect as Record<string, unknown>;
  assert.equal(followingEffect.position, 'in_flight_with_following_steps');
  assert.equal(followingEffect.remaining_steps_after_running, 3);
  assert.match(String(followingEffect.executes_if_continue), /若没有失败\/取消.*本轮剩余 1 步.*还有 1 轮/);

  const between = make('砍木头再做木板', steps, { repeat: 3 });
  between.index = 1;
  const betweenEffect = describeActivity(between, state()).continue_effect as Record<string, unknown>;
  assert.equal(betweenEffect.position, 'between_steps');
  assert.match(String(betweenEffect.executes_if_continue), /下一步「craft/);
  assert.equal(betweenEffect.remaining_steps, 5, '本轮剩 1 步 + 后面 2 轮各 2 步');
  assert.equal(betweenEffect.remaining_rounds, 2);

  const roundEnd = make('砍木头再做木板', steps, { repeat: 2 });
  roundEnd.iteration = 0;
  roundEnd.index = 2;
  const roundEndEffect = describeActivity(roundEnd, state()).continue_effect as Record<string, unknown>;
  assert.match(String(roundEndEffect.executes_if_continue), /本轮结束，进入下一轮第 1 步/);
});

test('continue_effect 的后续步骤以 done_when/失败/取消可能提前停止为前提', () => {
  const a = make('挖到装满', [
    { skill: 'gather', args: { block: 'stone', count: 8 } },
    { skill: 'gather', args: { block: 'stone', count: 8 } },
  ], { repeat: 2, doneWhen: { type: 'inventory_full', free_slots: 0 } });
  a.index = 1;
  const effect = describeActivity(a, state()).continue_effect as Record<string, unknown>;
  assert.equal(effect.done_when_can_stop_early, true);
  assert.match(String(effect.executes_if_continue), /若收工条件未触发且没有失败\/取消/);
});

test('采集回执 data.collection 会保留到最近一步的事实里，而不是只留一句模糊成功', () => {
  const a = make('挖铁', [{ skill: 'gather', args: { block: 'iron_ore', count: 3 } }]);
  const step = nextStep(a)!;
  afterStep(a, step, {
    status: 'succeeded',
    summary: 'raw_iron 2→3（目标 3，已达成；实得 +1，挖了 1 块 iron_ore）',
    data: { dug: 1, collection: { block: 'iron_ore', items: ['raw_iron'], initial: 2, target: 3, final: 3, gained: 1, dug: 1, targetMet: true } },
  }, 10, state());
  const receipt = a.results.at(-1)?.data?.collection as Record<string, unknown>;
  assert.equal(receipt.final, 3);
  assert.equal(receipt.gained, 1);
  assert.equal(describeActivity(a, state()).last_collection, receipt);
});

test('活动结束时保留最近一次采集回执快照（含动作与时间），历史值不冒充当前背包', () => {
  const a = make('挖铁', [{ skill: 'gather', args: { block: 'iron_ore', count: 3 } }]);
  a.startInventory = {};
  const at = Date.now() - 1000;
  a.results.push({ skill: 'gather', args: { block: 'iron_ore', count: 3 }, status: 'succeeded',
    summary: 'raw_iron 2→3（目标 3，已达成）', at, durationMs: 5, pos: { ...pos },
    data: { dug: 1, collection: { block: 'iron_ore', items: ['raw_iron'], initial: 2, target: 3, final: 3, gained: 1, dug: 1, targetMet: true } } });
  const record = recordOf(a, 'done', '采集完成', state([{ name: 'raw_iron', count: 3 }]));
  assert.deepEqual(record.collection, {
    block: 'iron_ore', items: ['raw_iron'], initial: 2, target: 3, final: 3, gained: 1, dug: 1, targetMet: true,
    skill: 'gather', args: { block: 'iron_ore', count: 3 }, at,
  });
});

test('collection.dug>0 但顶层 dug=0/gained=0 时，不因历史方块数被记成已取得', () => {
  const a = make('挖铁', [{ skill: 'gather', args: { block: 'iron_ore', count: 3 } }]);
  a.startInventory = {};
  a.results.push({ skill: 'gather', args: { block: 'iron_ore', count: 3 }, status: 'failed', failureCode: 'ERROR',
    summary: '挖掉了 3 块 iron_ore 但目标物品都没进背包', at: Date.now(), durationMs: 5, pos: { ...pos },
    data: { dug: 0, lost: 3, collection: { block: 'iron_ore', items: ['raw_iron'], initial: 0, target: 3, final: 0, gained: 0, dug: 3, targetMet: false, lost: 3 } } });
  const record = recordOf(a, 'stuck', '掉落物都没捡到', state());
  assert.equal(record.resource?.intent, true);
  assert.equal(record.resource?.acquired, false, '顶层 dug 沿用产出块数语义，不能拿 collection.dug 当已取得');
  assert.equal(record.resource?.goalIncomplete, true);
  assert.equal(record.collection?.dug, 3);
});

test('实测位置决定探索覆盖：同格观察不能算远处已搜索', () => {
  const local = make('找树砍原木', [{ skill: 'look_around', args: { for: 'log' } }]);
  local.results.push({ skill: 'look_around', args: {}, status: 'failed', failureCode: 'NOT_FOUND', summary: '视野内未见', at: Date.now(), durationMs: 2, pos: { x: 0.8, y: 64, z: 0.5 } });
  const record = recordOf(local, 'done', '步骤做完', state(), { newChunks: 0 });
  assert.equal(record.exploration?.searchIntent, true);
  assert.equal(record.exploration?.localOnly, true);
  assert.ok((record.exploration?.maxHorizontal ?? 99) < 8);

  const travelled = make('找树砍原木', [{ skill: 'move_step', args: { at: [1, 0, 0] } }]);
  travelled.results.push({ skill: 'move_step', args: {}, status: 'succeeded', summary: '走了一步', at: Date.now(), durationMs: 2, pos: { x: 20.5, y: 64, z: 0.5 } });
  assert.equal(recordOf(travelled, 'done', '走远后观察', state(), { newChunks: 0 }).exploration?.localOnly, false);
});
