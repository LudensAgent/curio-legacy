import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GameAdapter } from '../src/adapter/types.ts';
import { approachVisible } from '../src/skills/movement/index.ts';

// 参数校验不读适配器；给一个只满足类型的空壳，避免测试夹具干扰。
const adapter = {} as GameAdapter;

// Arbiter 会在执行前对步骤参数再校验一次。validatePlanSkill 保存的是第一次校验的规范化结果，
// 所以每个技能的 validate 必须能接受自己的输出，否则第一次通过、执行前必失败。
test('approach_visible 的校验对规范化参数幂等', () => {
  for (const target of [
    { pos: { x: 1, y: 64, z: 0 } },
    { block: { x: 2, y: 64, z: 0 } },
    { entity: { name: 'cow' } },
  ]) {
    const first = approachVisible.validate({ target, radius: 8, maxSteps: 4 }, adapter);
    assert.ok(first.ok, first.ok ? '' : first.error);
    const second = approachVisible.validate(first.args, adapter);
    assert.ok(second.ok, `规范化参数再校验失败：${second.ok ? '' : second.error}`);
  }
});

test('kind 与唯一目标键一致时接受，不一致或缺少目标时仍然拒绝', () => {
  assert.equal(approachVisible.validate({ target: { kind: 'position', pos: { x: 1, y: 64, z: 0 } } }, adapter).ok, true);
  assert.equal(approachVisible.validate({ target: { kind: 'entity', entity: { name: 'cow' } } }, adapter).ok, true);
  assert.equal(approachVisible.validate({ target: { kind: 'position', block: { x: 1, y: 64, z: 0 } } }, adapter).ok, false);
  assert.equal(approachVisible.validate({ target: { kind: 'position' } }, adapter).ok, false);
});
