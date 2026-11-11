import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SKILLS } from '../src/skills/index.ts';
import { validatePlanSkill, validateSkill } from '../src/skills/types.ts';
import { FakeAdapter } from './fake-adapter.ts';

/**
 * Arbiter 执行前会用 skill.validate 再校验一次计划录入时的规范化输出（见 arbiter.validate）。
 * 每个技能的校验必须接受自己返回的 args，且再校验结果不变；否则计划录入通过、执行前必定失败。
 * 新增参数时在这里补一行样例。
 */
const SAMPLES: Record<string, Record<string, unknown>[]> = {
  travel_to: [
    { to: { x: 10, y: 64, z: 0 } },
    { to: { x: 10, y: 64, z: 0 }, range: 3, swim: true },
    { to: { x: -62, y: 70, z: -41 }, dig: true, place: 'netherrack' },
    { to: { x: -62, y: 70, z: -41 }, dig: 'iron_pickaxe', place: 'any', maxEdits: 8 },
  ],
  explore_toward: [
    { direction: 'E', distance: 32 },
    { direction: 'N', distance: 48, until: 'nether_bricks', swim: true, dig: true },
    { direction: 'W', distance: 64, place: 'cobblestone', maxEdits: 4 },
  ],
};

test('移动技能的校验对自己的规范化输出幂等：计划录入后执行前的再校验不报错、结果不变', () => {
  const adapter = new FakeAdapter();
  for (const [name, samples] of Object.entries(SAMPLES)) {
    const skill = SKILLS[name];
    assert.ok(skill, `技能 ${name} 存在`);
    for (const raw of samples) {
      const planned = validatePlanSkill(skill, raw, adapter);
      assert.ok(planned.ok, `${name} 计划录入应通过：${JSON.stringify(raw)} → ${planned.ok ? '' : planned.error}`);
      const again = validateSkill(skill, planned.args, adapter);
      assert.ok(again.ok, `${name} 执行前再校验应通过：${JSON.stringify(planned.args)} → ${again.ok ? '' : again.error}`);
      assert.deepEqual(again.args, planned.args, `${name} 再校验结果应不变`);
    }
  }
});
