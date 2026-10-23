import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Arbiter, TaskSource } from '../src/arbiter/arbiter.ts';
import type { Executive } from '../src/brain/executive.ts';
import type { Reflex } from '../src/brain/reflex.ts';
import { EventBus } from '../src/events.ts';
import { Metrics } from '../src/observer/metrics.ts';
import type { Planner } from '../src/planner/planner.ts';
import { FakeAdapter } from './fake-adapter.ts';

function fixture() {
  const adapter = new FakeAdapter();
  const bus = new EventBus();
  let source: TaskSource | null = null;
  const arbiter = { info: () => source ? { source } : null, blockedActions: 0 };
  const executive = { paused: false, inFlight: false, staleDropped: 0 };
  const planner = { stats: { latencies: [] as number[] } };
  const reflex = { stuckCount: 0, triggers: 0 };
  const metrics = new Metrics(adapter, arbiter as unknown as Arbiter, executive as unknown as Executive,
    planner as unknown as Planner, reflex as unknown as Reflex, bus);
  return { adapter, bus, executive, metrics, task: (next: TaskSource | null) => { source = next; } };
}

test('thinking continuity and thinking seconds expire with the same ten-minute window as idle seconds', (t) => {
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  const w = fixture();
  w.executive.inFlight = true;
  w.metrics.sample(); // Earlier model request was idle.
  now += 600_000;
  assert.equal(w.metrics.snapshot().llmThinkingSec, 1, 'the window includes its exact boundary');
  now++;
  w.task('llm');
  w.metrics.sample();
  const current = w.metrics.snapshot();
  assert.equal(current.idle10m, 0);
  assert.equal(current.llmThinkingSec, 1);
  assert.equal(current.llmContinuity, 1, 'old idle thinking must not depress current continuity');
  now += 600_001;
  assert.equal(w.metrics.snapshot().llmThinkingSec, 0);
  assert.equal(w.metrics.snapshot().llmContinuity, null, 'expired requests supply no current evidence');
});

test('thinking continuity counts task, filler and reflex activity and excludes paused or offline time', (t) => {
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  const w = fixture();
  const sample = () => { now += 1000; w.metrics.sample(); };
  w.executive.inFlight = true;
  sample();
  for (const source of ['llm', 'filler', 'reflex'] as const) { w.task(source); sample(); }
  w.executive.paused = true;
  sample();
  w.executive.paused = false;
  w.adapter.connected = false;
  sample();
  w.adapter.connected = true;
  w.adapter.hp = 0;
  sample();
  w.adapter.hp = 20;
  w.executive.inFlight = false;
  w.task(null);
  sample();
  const snapshot = w.metrics.snapshot();
  assert.equal(snapshot.llmThinkingSec, 4);
  assert.equal(snapshot.llmContinuity, 0.75);
  assert.deepEqual(snapshot.window10m, { task: 1, filler: 1, reflex: 1, idle: 2, paused: 1, offline: 2 });
});

test('skill success rate excludes filler results and cancelled tasks from its denominator', () => {
  const w = fixture();
  const end = (source: TaskSource, status: 'succeeded' | 'failed' | 'cancelled') =>
    w.bus.publish('task_end', 'P3', `[${source}] look_around → ${status}`, { source, status });
  end('filler', 'succeeded');
  end('filler', 'failed');
  end('filler', 'cancelled');
  end('llm', 'succeeded');
  end('llm', 'succeeded');
  end('rule', 'succeeded');
  end('reflex', 'succeeded');
  end('llm', 'failed');
  end('user', 'cancelled');
  const snapshot = w.metrics.snapshot();
  assert.deepEqual(snapshot.tasks, { succeeded: 4, failed: 1, cancelled: 1 });
  assert.equal(snapshot.taskSuccessRate, 0.8);
});

test('short attempts have separate counters from completed goals and preserve legacy goal events', () => {
  const w = fixture();
  for (const status of ['succeeded', 'succeeded', 'failed', 'interrupted', 'deferred']) {
    w.bus.publish('attempt_end', 'P3', `一次短期尝试 ${status}`, { status });
  }
  assert.deepEqual(w.metrics.snapshot().attempts, { succeeded: 2, failed: 1, other: 2 });
  assert.deepEqual(w.metrics.snapshot().goals, { succeeded: 0, failed: 0, other: 0 });
  w.bus.publish('goal_end', 'P2', '工程已按实际背包验收', { status: 'succeeded', scope: 'project' });
  w.bus.publish('goal_end', 'P1', '兼容模式旧目标失败', { status: 'failed' });
  const snapshot = w.metrics.snapshot();
  assert.deepEqual(snapshot.goals, { succeeded: 1, failed: 1, other: 0 });
  assert.deepEqual(snapshot.attempts, { succeeded: 2, failed: 1, other: 2 });
  assert.deepEqual(snapshot.tasks, { succeeded: 0, failed: 0, cancelled: 0 });
});
