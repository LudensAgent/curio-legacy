import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advancedMovesLine, moveDetails, moveDirectory, movesCatalog } from '../src/mind/prompt.ts';
import { LLM_HIDDEN, SKILLS } from '../src/skills/index.ts';

test('the empty moves query lists every callable action but hides body-only fillers', () => {
  const directory = moveDirectory();
  for (const skill of Object.values(SKILLS)) {
    if (LLM_HIDDEN.has(skill.name)) assert.doesNotMatch(directory, new RegExp(`\\b${skill.name}\\b`), `${skill.name} 是身体填充动作，不应给心智`);
    else assert.match(directory, new RegExp(`\\b${skill.name}\\b`), `缺少可调用动作 ${skill.name}`);
  }
});

test('general-purpose actions stay discoverable outside the advanced line', () => {
  const catalog = movesCatalog(28);
  for (const name of ['building_archive', 'building_review', 'material_reservations', 'base_memory', 'ranged_defend']) {
    assert.match(catalog, new RegExp(`\\b${name}\\b`), `${name} 是日常能力，不应等进下界才出现`);
  }
  const advanced = advancedMovesLine();
  assert.match(advanced, /travel_portal|observe_portal/);
  assert.doesNotMatch(advanced, /building_archive|ranged_defend/, '通用能力不塞进阶提醒');
});

test('the directory carries concrete usage for non-core actions and the query does not silently drop names', () => {
  const directory = moveDirectory();
  assert.match(directory, /- walk_to \{.*deadlineMs/);
  assert.match(directory, /- equip_armor：/, '没有参数的动作也要给用途');
  const details = moveDetails(['walk_to', 'walk_route', 'fly_to', 'trade', 'use_gui', 'spatial_query', 'building_archive']);
  assert.match(details, /- building_archive /, '第 7 个动作也要查得到，不能静默截断');
  assert.match(details, /- spatial_query /);
});
