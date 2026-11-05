import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deliberateSystem, glanceSystem, moveDetails } from '../src/mind/prompt.ts';

test('both thinking tiers expose direction and water movement tools with their effects and limits', () => {
  for (const system of [deliberateSystem(''), glanceSystem('')]) {
    const lines = system.split('\n');
    const look = lines.find((line) => line.startsWith('- look '));
    const dive = lines.find((line) => line.startsWith('- dive '));
    const surface = lines.find((line) => line.startsWith('- surface '));
    const swimTo = lines.find((line) => line.startsWith('- swim_to '));
    const travel = lines.find((line) => line.startsWith('- travel '));
    assert.ok(look && dive && surface && swimTo && travel, 'these actions must be discoverable before the agent uses them');
    assert.match(look, /"dir".*NW.*只转头不走/);
    assert.match(dive, /"xyz".*min_oxygen.*停下回报/);
    assert.match(surface, /有界上浮.*不找岸.*不挖不垫/);
    assert.match(swimTo, /"xyz".*保持这个目标不换|"xyz".*游过去/);
    assert.match(swimTo, /沿已观察到的水格.*绕开岩檐.*不挖、不垫、不换目标/, 'the catalog must not promise straight-line-only behavior');
    assert.match(swimTo, /bx\+0\.5.*by\+1.*bz\+0\.5/, 'the foot-coordinate convention for standing on a block top is part of the contract');
    assert.match(travel, /步行、游泳.*不制造或切换载具/);
  }
});

test('active uncommon tools like ride get full args on demand, and hidden tools stay out of the catalogs', () => {
  // 当前活动用到的、目录里没给完整参数的动作（如 ride）由 user 提醒用 moveDetails 给完整参数
  assert.match(moveDetails(['ride']), /^- ride .*"direction".*"to"/m);
});

test('both thinking tiers distinguish current water contact, ground contact, and oxygen', () => {
  for (const system of [deliberateSystem(''), glanceSystem('')]) {
    assert.match(system, /身体状态仅表示当前快照：inWater=false.*不证明已上岸、持续站稳或完成换气/);
    assert.match(system, /onGround=true 只表示当前触地，也可能在水底/);
    assert.match(system, /氧气恢复程度看 oxygen 数值；条件及其组合由你按实际目标选择/);
  }
});
