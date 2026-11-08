import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createActivity, describeActivity, planCoverageGap, recordOf } from '../src/mind/activity.ts';

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
