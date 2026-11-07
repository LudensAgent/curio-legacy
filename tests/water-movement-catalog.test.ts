import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deliberateSystem, glanceSystem, moveDetails } from '../src/mind/prompt.ts';
import { swimPath } from '../src/skills/movement/index.ts';

test('both thinking tiers expose direction and water movement tools with their effects and limits', () => {
  for (const system of [deliberateSystem(''), glanceSystem('')]) {
    const lines = system.split('\n');
    const look = lines.find((line) => line.startsWith('- look '));
    const swim = lines.find((line) => line.startsWith('- swim_path '));
    const boat = lines.find((line) => line.startsWith('- boat_path '));
    assert.ok(look && swim && boat, 'these actions must be discoverable before the agent uses them');
    assert.match(look, /"dir".*NW.*只转头不走/);
    assert.match(swim, /water_point.*dry_shore.*surface/);
    assert.match(swim, /不挖、不垫、不换目标/);
    assert.match(boat, /"direction".*"to"/);
    assert.match(boat, /停靠不等于到达.*不造船/);
  }
});

test('active uncommon tools like boat_path get full args on demand, and hidden tools stay out of the catalogs', () => {
  // 当前活动用到的、目录里没给完整参数的动作（如 ride）由 user 提醒用 moveDetails 给完整参数
  assert.match(moveDetails(['boat_path']), /^- boat_path .*"direction".*"to"/m);
});

test('swim_path argsDoc records delegated old names instead of silently keeping compatibility shells', () => {
  const doc = swimPath.argsDoc;
  assert.match(doc, /step\/dig_at\/place_at 不再注册/);
  assert.match(doc, /move_step\/mine_cell\/place_cell/);
  assert.match(doc, /自动 ≤4 格落差已移交 descend_to\/move_step/);
  assert.match(doc, /水中上岸由 swim_path 完成/);
  assert.match(doc, /jump\/climb_one 的替代是 pillar_one 与 move_step \[1,1,0\]/);
});

test('both thinking tiers distinguish current water contact, ground contact, and oxygen', () => {
  for (const system of [deliberateSystem(''), glanceSystem('')]) {
    assert.match(system, /身体状态仅表示当前快照：inWater=false.*不证明已上岸、持续站稳或完成换气/);
    assert.match(system, /onGround=true 只表示当前触地，也可能在水底/);
    assert.match(system, /氧气恢复程度看 oxygen 数值；条件及其组合由你按实际目标选择/);
  }
});
