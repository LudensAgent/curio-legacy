import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toolRequirementText } from '../src/skills/movement/tool-requirement.ts';
import { FakeAdapter } from './fake-adapter.ts';

test('缺工具回执：格子坐标、方块、工具类别、当前主手', () => {
  const adapter = new FakeAdapter();
  const baseState = adapter.state.bind(adapter);
  Object.assign(adapter, { harvestTools: () => ['stone_pickaxe'], state: () => ({ ...baseState(), held: 'dirt' }) });
  const text = toolRequirementText(adapter, { x: 1, y: 65, z: -2 }, 'stone');
  assert.match(text, /\(1,65,-2\) 是 stone/);
  assert.match(text, /需要镐类工具/);
  assert.match(text, /当前主手是 dirt/);
  assert.match(text, /背包里没有可用的镐类工具/);
});

test('缺工具回执：工具类别未知时只说“合适的工具”，不编类别', () => {
  const adapter = new FakeAdapter();
  Object.assign(adapter, { harvestTools: () => [] });
  const text = toolRequirementText(adapter, { x: 0, y: 64, z: 0 }, 'cobweb');
  assert.match(text, /需要合适的工具/);
  assert.doesNotMatch(text, /类工具/);
});
