import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deliberateSystem, glanceSystem, movesCatalog } from '../src/mind/prompt.ts';

test('both thinking tiers expose direction and water movement tools with their effects and limits', () => {
  for (const system of [deliberateSystem(''), glanceSystem('', new Set())]) {
    const lines = system.split('\n');
    const look = lines.find((line) => line.startsWith('- look '));
    const dive = lines.find((line) => line.startsWith('- dive '));
    const surface = lines.find((line) => line.startsWith('- surface '));
    const travel = lines.find((line) => line.startsWith('- travel '));
    assert.ok(look && dive && surface && travel, 'these actions must be discoverable before the agent uses them');
    assert.match(look, /"dir".*NW.*只转头不走/);
    assert.match(dive, /"xyz".*min_oxygen.*停下回报/);
    assert.match(surface, /上浮换气并游上岸.*挖开头顶方块/);
    assert.match(travel, /步行和游泳.*不制造或切换载具/);
  }
});

test('explicit and active uncommon tools remain in the light catalog without exposing hidden tools', () => {
  const selected = movesCatalog(0, new Set(['ride', 'glance']), false);
  assert.match(selected, /^- ride .*"direction".*"to"/m);
  assert.doesNotMatch(selected, /^- (?:goto|glance) /m);
  const active = glanceSystem('', new Set(['ride']));
  assert.match(active, /^- ride .*"direction".*"to"/m);
});

test('both thinking tiers distinguish current water contact, ground contact, and oxygen', () => {
  for (const system of [deliberateSystem(''), glanceSystem('', new Set())]) {
    assert.match(system, /身体状态仅表示当前快照：inWater=false.*不证明已上岸、持续站稳或完成换气/);
    assert.match(system, /onGround=true 只表示当前触地，也可能在水底/);
    assert.match(system, /氧气恢复程度看 oxygen 数值；条件及其组合由你按实际目标选择/);
  }
});
