import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deliberateSystem, glanceSystem, RESOURCE_PRINCIPLE } from '../src/mind/prompt.ts';
import { SKILLS } from '../src/skills/index.ts';

test('系统提示与资源原则不再反复使用“由你决定/由你判断/由你定”的授权口号', () => {
  for (const [name, system] of [['deliberate', deliberateSystem('P', [])], ['glance', glanceSystem('P', [])]] as const) {
    assert.doesNotMatch(system, /由你(决定|判断|定|选择|按)/, `${name} 仍含授权口号`);
  }
  assert.doesNotMatch(RESOURCE_PRINCIPLE, /由你(决定|判断|定|选择|按)/);
  for (const skill of [SKILLS.expedition, SKILLS.navigate_to, SKILLS.swim_path, SKILLS.pillar_one]) {
    assert.doesNotMatch(skill.description, /由你(决定|判断|定|选择|按)/, `${skill.name} 说明仍含授权口号`);
  }
  assert.match(deliberateSystem('P', []), /要做什么、先做什么由你的目标与兴趣决定/, '保留一处原则级开放性');
});
