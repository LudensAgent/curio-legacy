import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { addInto, RunStats } from '../src/observer/run-stats.ts';

const fakeMetrics = () => ({ counters: { deaths: 0, tasks: { succeeded: 0, failed: 0, cancelled: 0 }, failCodes: {} as Record<string, number> }, distance: 0, startedAt: Date.now() }) as any;
const fakePlanner = () => ({ stats: { calls: 0, ok: 0, errors: 0, invalid: 0, budgetFallbacks: 0, tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, unreportedCalls: 0 }, tiers: { light: 0, full: 0, escalated: 0 }, tierLatency: { light: { sum: 0, n: 0 }, full: { sum: 0, n: 0 } }, latencies: [] } }) as any;

test('一次测试的累计数字：重启后接着加（死亡、token、调用、失败码、路程、运行时长），数据目录清掉才从零开始', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-run-'));
  const file = path.join(dir, 'run-stats.json');
  const m1 = fakeMetrics(), p1 = fakePlanner(), c1 = fakePlanner();
  m1.startedAt = Date.now() - 600_000;
  const r1 = new RunStats(file, m1, { main: p1, coder: c1 });
  m1.counters.deaths = 3; m1.counters.tasks.failed = 5; m1.counters.failCodes.PATH_NOT_FOUND = 4; m1.distance = 1234.5;
  p1.stats.calls = 10; p1.stats.tokenUsage.totalTokens = 50_000; c1.stats.tokenUsage.totalTokens = 20_000;
  assert.equal(r1.totalTokens(), 70_000, '心智和后台写技能的 token 一起算');
  r1.save();
  // 重启：新进程里刚死了一次
  const m2 = fakeMetrics(), p2 = fakePlanner(), c2 = fakePlanner();
  m2.counters.deaths = 1;
  const r2 = new RunStats(file, m2, { main: p2, coder: c2 });
  assert.equal(m2.counters.deaths, 4);
  assert.equal(m2.counters.failCodes.PATH_NOT_FOUND, 4);
  assert.equal(m2.distance, 1235);
  assert.equal(p2.stats.calls, 10);
  assert.equal(r2.totalTokens(), 70_000);
  assert.ok(Date.now() - m2.startedAt >= 599_000, '累计运行时长接着算');
  fs.rmSync(dir, { recursive: true });
  const m3 = fakeMetrics();
  new RunStats(file, m3, { main: fakePlanner() });
  assert.equal(m3.counters.deaths, 0, '新的一次测试从零开始');
  const t = { a: 1, b: { c: 2 } } as any;
  addInto(t, { a: 2, b: { c: 3, d: 1 }, e: 'x' });
  assert.deepEqual(t, { a: 3, b: { c: 5, d: 1 } });
});
