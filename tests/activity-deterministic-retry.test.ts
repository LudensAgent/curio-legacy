import assert from 'node:assert/strict';
import { test } from 'node:test';
import { afterStep, createActivity, nextStep } from '../src/mind/activity.ts';
import { failureFor } from '../src/mind/mind.ts';
import { fail } from '../src/skills/types.ts';
import { FakeAdapter } from './fake-adapter.ts';

function activityOf(steps: { skill: string; args?: unknown }[]) {
  const adapter = new FakeAdapter();
  return {
    adapter,
    activity: createActivity({ what: '测试', why: '', kind: 'other', steps, repeat: 1 }, '', 'llm', adapter.state()),
  };
}

const retryCount = (activity: ReturnType<typeof activityOf>['activity']) => activity.adaptations.filter((item) => item.startsWith('retry:')).length;

const positioned = (x: number, y: number, z: number) => ({ position: { x, y, z } });

test('EFFECT_NOT_CONFIRMED 的回填/未加载失败最多自动再确认一次', () => {
  const { adapter, activity } = activityOf([{ skill: 'mine_cell', args: { at: [0, -1, 0], facing: 'N' } }]);
  activity.stepStart = { pos: { x: 99, y: 64, z: 99 } };
  const first = nextStep(activity)!;
  const firstVerdict = afterStep(activity, first, fail('EFFECT_NOT_CONFIRMED', '挖后目标格仍不是空气（可能被回填）', {
    targetCell: { x: 0, y: 63, z: 0 }, was: 'sand', ...positioned(0, 64, 0),
  }), 100, adapter.state());
  assert.equal(firstVerdict.kind, 'continue', '身体已换位时允许一次复验');
  assert.equal(retryCount(activity), 1);

  const second = nextStep(activity)!;
  const secondVerdict = afterStep(activity, second, fail('EFFECT_NOT_CONFIRMED', '挖后目标格仍不是空气（可能被回填）', {
    targetCell: { x: 0, y: 63, z: 0 }, was: 'sand', ...positioned(0, 64, 1),
  }), 100, adapter.state());
  assert.equal(secondVerdict.kind, 'stuck', '即使回执里的位置变了，同一失败也不再自动重试第二次');
  assert.equal(retryCount(activity), 1);
});

test('结构化确定性停点（risk/capability/missing_support/decisionRequired/缺支撑）最多自动重试一次', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['risk', { stopKind: 'risk' }],
    ['capability', { stopKind: 'capability' }],
    ['missing_support', { stopKind: 'missing_support' }],
    ['impossible', { stopKind: 'impossible' }],
    ['decisionRequired', { decisionRequired: true }],
    ['supportMissing', { supportMissing: { at: { x: 0, y: 63, z: 0 }, item: 'cobblestone', stance: 'edge', cost: 1, reason: 'no support' } }],
  ];
  for (const [label, data] of cases) {
    const { adapter, activity } = activityOf([{ skill: 'gather', args: { block: 'stone', count: 3 } }]);
    activity.stepStart = { pos: { x: 99, y: 64, z: 99 } };
    const first = nextStep(activity)!;
    assert.equal(afterStep(activity, first, fail('PATH_NOT_FOUND', `确定性停点：${label}`, { ...data, ...positioned(0, 64, 0) }), 100, adapter.state()).kind, 'continue', `${label}：身体已换位时允许一次复验`);
    assert.equal(retryCount(activity), 1, label);

    const second = nextStep(activity)!;
    assert.equal(afterStep(activity, second, fail('PATH_NOT_FOUND', `确定性停点：${label}`, { ...data, ...positioned(0, 64, 1) }), 100, adapter.state()).kind, 'stuck', `${label}：不再自动重试第二次`);
    assert.equal(retryCount(activity), 1, label);
  }
});

test('普通暂时失败仍保留原有两次复验额度', () => {
  const { adapter, activity } = activityOf([{ skill: 'gather', args: { block: 'stone', count: 3 } }]);
  activity.stepStart = { pos: { x: 99, y: 64, z: 99 } };
  let step = nextStep(activity)!;
  assert.equal(afterStep(activity, step, fail('PATH_NOT_FOUND', '路被挡住', positioned(0, 64, 0)), 100, adapter.state()).kind, 'continue');
  step = nextStep(activity)!;
  assert.equal(afterStep(activity, step, fail('PATH_NOT_FOUND', '路被挡住', positioned(0, 64, 1)), 100, adapter.state()).kind, 'continue');
  step = nextStep(activity)!;
  assert.equal(afterStep(activity, step, fail('PATH_NOT_FOUND', '路被挡住', positioned(0, 64, 2)), 100, adapter.state()).kind, 'stuck');
  assert.equal(retryCount(activity), 2);
});

test('walk_path 从不产生 pillarClearance：该字段不再单独阻断重试判定', () => {
  const { adapter, activity } = activityOf([{ skill: 'walk_path', args: { routeId: 'rt_test' } }]);
  activity.stepStart = { pos: { x: 99, y: 64, z: 99 } };
  const step = nextStep(activity)!;
  const verdict = afterStep(activity, step, fail('EFFECT_NOT_CONFIRMED', '只走了一部分', {
    pillarClearance: true, ...positioned(0, 64, 0),
  }), 100, adapter.state());
  assert.equal(verdict.kind, 'continue', '按 EFFECT_NOT_CONFIRMED 的一次复验处理，不再走 walk_path+pillarClearance 的死分支');
  assert.equal(retryCount(activity), 1);
});

test('交给恢复技能的失败不再携带 Activity.climb 账本', () => {
  const call = failureFor as unknown as (step: unknown, result: unknown, pos: unknown, climb: unknown, climbId: unknown) => Record<string, unknown>;
  const failure = call(
    { skill: 'pillar_one', args: { item: 'cobblestone' } },
    { failureCode: 'STUCK', summary: '没垫高' },
    { x: 0, y: 64, z: 0 },
    { height: 3, spent: 0, startY: 64 },
    'st_parent',
  );
  assert.equal('climb' in failure, false);
  assert.equal('climbId' in failure, false);
});
