import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { EventBus } from '../src/events.ts';
import { startDashboard, type DashboardHandlers } from '../src/observer/dashboard.ts';

async function dashboard(t: TestContext, curateSkills?: DashboardHandlers['curateSkills']) {
  const noop = () => {};
  const server = startDashboard('127.0.0.1', 0, new EventBus(), {
    snapshot: () => ({}), pause: noop, resume: noop, replan: noop, suggest: noop, curateSkills,
  }, [], { env: { file: path.join(os.tmpdir(), randomUUID(), '.env') } });
  t.after(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  if (!server.listening) await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}/api/skills/curate`;
}

test('manual skill curation waits for its result and reports busy requests without starting another run', async (t) => {
  let finish!: (result: string) => void;
  const pending = new Promise<string>((resolve) => { finish = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let busy = false, calls = 0;
  const url = await dashboard(t, async () => {
    if (busy) return { ok: false, busy: true, error: '正在整理技能，请等待本次完成' };
    busy = true;
    calls++;
    entered();
    const result = await pending;
    busy = false;
    return { ok: true, result };
  });
  assert.equal((await fetch(url)).status, 404);
  assert.equal(calls, 0);
  const request = fetch(url, { method: 'POST' });
  await started;
  const duplicate = await fetch(url, { method: 'POST' });
  assert.equal(duplicate.status, 409);
  assert.deepEqual(await duplicate.json(), { ok: false, busy: true, error: '正在整理技能，请等待本次完成' });
  assert.equal(calls, 1);
  finish('已收起 idle-candidate；其他技能保持现状');
  const completed = await request;
  assert.equal(completed.status, 200);
  assert.deepEqual(await completed.json(), { ok: true, result: '已收起 idle-candidate；其他技能保持现状' });
  assert.equal((await fetch(url, { method: 'POST' })).status, 200);
  assert.equal(calls, 2);
});

test('manual skill curation returns errors from the handler and rejected requests', async (t) => {
  let reject = false;
  const url = await dashboard(t, async () => {
    if (reject) throw new Error('模型连接失败');
    return { ok: false, error: '整理出错：模型没有返回完整结果' };
  });
  const failed = await fetch(url, { method: 'POST' });
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { ok: false, error: '整理出错：模型没有返回完整结果' });
  reject = true;
  const rejected = await fetch(url, { method: 'POST' });
  assert.equal(rejected.status, 500);
  assert.deepEqual(await rejected.json(), { ok: false, error: '模型连接失败' });
});

test('dashboards without a curation handler explicitly report the unsupported action', async (t) => {
  const url = await dashboard(t);
  const response = await fetch(url, { method: 'POST' });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { ok: false, error: '当前运行不支持手动整理技能' });
});
