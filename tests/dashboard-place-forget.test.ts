import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { EventBus } from '../src/events.ts';
import { startDashboard, type DashboardHandlers } from '../src/observer/dashboard.ts';

async function dashboard(t: TestContext, forgetPlace?: DashboardHandlers['forgetPlace']) {
  const noop = () => {};
  const server = startDashboard('127.0.0.1', 0, new EventBus(), {
    snapshot: () => ({}), pause: noop, resume: noop, replan: noop, suggest: noop, forgetPlace,
  }, [], { env: { file: path.join(os.tmpdir(), randomUUID(), '.env') } });
  t.after(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  if (!server.listening) await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}/api/memory/forget`;
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('dashboard forgets a place through the handler and reports unknown ids', async (t) => {
  const seen: string[] = [];
  const url = await dashboard(t, (id) => {
    seen.push(id);
    return id === 'lm_1'
      ? { ok: true, place: { id, kind: 'base', label: '小屋', dim: 'overworld', pos: { x: 1, y: 64, z: 2 } } }
      : { ok: false, error: '记忆里没有这个地点（可能已经删了）' };
  });

  const removed = await post(url, { id: 'lm_1' });
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { ok: true, place: { id: 'lm_1', kind: 'base', label: '小屋', dim: 'overworld', pos: { x: 1, y: 64, z: 2 } } });

  const missing = await post(url, { id: 'lm_missing' });
  assert.equal(missing.status, 400);
  assert.deepEqual(await missing.json(), { ok: false, error: '记忆里没有这个地点（可能已经删了）' });

  const empty = await post(url, { id: '  ' });
  assert.equal(empty.status, 400);
  assert.deepEqual(seen, ['lm_1', 'lm_missing']);
});

test('dashboards without a forget handler explicitly report the unsupported action', async (t) => {
  const url = await dashboard(t);
  const response = await post(url, { id: 'lm_1' });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { ok: false, error: '当前运行不支持移除地点记忆' });
});
