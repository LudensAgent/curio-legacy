import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentEvent } from '../src/events.ts';
import { Attention } from '../src/mind/attention.ts';

const event = (data: Record<string, unknown>, msg = '空间记忆裁剪'): AgentEvent => ({
  ts: Date.now(), type: 'spatial_retention', severity: 'P2', msg, data,
});

test('删除后的裁剪事实会作为低噪事实被注意到，且说明未记录语义', () => {
  const n = new Attention().fromEvent(event({
    deleted: 3, rejected: 0, dims: ['overworld'], observedCells: 900,
  }));
  assert.ok(n);
  assert.match(n!.what, /overworld/);
  assert.match(n!.what, /3 个 Section/);
  assert.match(n!.what, /约 900 格/);
  assert.match(n!.what, /未记录/);
  assert.match(n!.what, /不是空气/);
  assert.match(n!.what, /当前路线保留/);
  assert.doesNotMatch(n!.what, /应该|建议/);
});

test('保留集占满目标的裁剪事实也会被注意到', () => {
  const n = new Attention().fromEvent(event({
    deleted: 0, reason: 'keep_exceeds_target', keepSections: 40, keepObservedCells: 9000,
  }, '空间记忆裁剪：保留集本身已达到目标水位，这一轮没有删除；保留的 40 个 Section（约 9000 格）仍然记得'));
  assert.ok(n);
  assert.match(n!.what, /没有删除/);
});
