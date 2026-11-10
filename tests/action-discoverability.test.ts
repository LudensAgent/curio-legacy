import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advancedMovesLine, deliberateSystem, glanceSystem, moveDetails, moveDirectory, movesCatalog } from '../src/mind/prompt.ts';
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

test('导航执行用 navigate_to/advance；plan_route 只做只读体素预览', () => {
  const catalog = movesCatalog(28);
  assert.match(catalog, /navigate_to/);
  assert.match(catalog, /advance/);
  assert.match(catalog, /plan_route/);
  assert.doesNotMatch(catalog, /walk_path/);
  assert.doesNotMatch(catalog, /plan_memory_route/);
  const directory = moveDirectory();
  assert.match(directory, /- spatial_extrema /);
  assert.doesNotMatch(directory, /walk_path/);
  assert.doesNotMatch(directory, /plan_memory_route/);
});

test('基础下行辅助不被进阶动作正则误藏', () => {
  assert.match(movesCatalog(28), /^- descend_to /m, 'descend_to 是基础移动辅助，应在静态目录里给完整参数');
  assert.doesNotMatch(advancedMovesLine(), /descend_to/, 'descend_to 不是下界/末地动作，不应等进阶情境才出现');
});

test('approach_visible 在静态指导与目录里可发现，target 三种写法可按需查', () => {
  for (const system of [deliberateSystem(''), glanceSystem('')]) assert.match(system, /approach_visible/);
  const catalog = movesCatalog(28);
  assert.match(catalog, /^- approach_visible /m);
  const details = moveDetails(['approach_visible']);
  for (const marker of ['"target"', '"pos"', '"block"', '"entity"', '"radius"']) assert.ok(details.includes(marker), `缺少 ${marker}`);
});

test('公开目录只说明直接寻路与体素导航，不再宣传旧路优先或 via', () => {
  const catalog = movesCatalog(28);
  assert.match(catalog, /excavate_run .*不会改走旁边/);
  assert.match(deliberateSystem(''), /navigate_to/);
  assert.match(moveDetails(['excavate_run']), /不会自动绕旁路.*不会改走旁边/);
  assert.match(moveDetails(['excavate_run']), /travel_to\/explore_toward 只做直接寻路/);
  assert.match(moveDetails(['excavate_run']), /不查询、不优先复用历史路线或路径片段/);
  const travel = moveDetails(['travel_to']);
  assert.match(travel, /不查询、不优先复用历史路线或路径片段/);
  assert.match(travel, /需要按已记录体素证据 3D 移动/);
  assert.doesNotMatch(travel, /via:/);
  const explore = moveDetails(['explore_toward']);
  assert.match(explore, /每段始终沿同一条冻结射线推进/);
  assert.match(explore, /不查询、不优先复用历史路线或路径片段/);
  assert.match(explore, /明确 NoPath 且原请求授权施工时/);
});

test('the directory carries concrete usage for non-core actions and the query does not silently drop names', () => {
  const directory = moveDirectory();
  assert.match(directory, /常用动作.*travel_to/);
  assert.doesNotMatch(directory, /walk_path/, 'walk_path 已退役，不再出现在目录');
  assert.match(directory, /navigate_to/, 'navigate_to 是可执行导航入口');
  assert.match(directory, /- equip_armor：/, '没有参数的动作也要给用途');
  const details = moveDetails(['plan_route', 'navigate_to', 'fly_to', 'trade', 'use_gui', 'spatial_query', 'building_archive']);
  assert.match(details, /- navigate_to \{.*sessionId/);
  assert.match(details, /- building_archive /, '第 7 个动作也要查得到，不能静默截断');
  assert.match(details, /- spatial_query /);
});
