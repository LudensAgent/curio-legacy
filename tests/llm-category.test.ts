import assert from 'node:assert/strict';
import { test } from 'node:test';
import { llmCategory } from '../src/planner/llm-trace.ts';

test('LLM 调用按发起的模块分类：心智三种、建筑师、技能三种', () => {
  assert.equal(llmCategory('mind:上一段活结束了，接下来做什么'), 'think');
  assert.equal(llmCategory('mind:手上这段活快干完了，想想接下来·瞥一眼'), 'glance');
  assert.equal(llmCategory('mind:回想'), 'reflect');
  assert.equal(llmCategory('architect'), 'architect');
  assert.equal(llmCategory('skill:总结（死亡）'), 'forge');
  assert.equal(llmCategory('skill:改进 local-path'), 'improve');
  assert.equal(llmCategory('skill:整理'), 'curate');
  assert.equal(llmCategory('something else'), 'other');
});
