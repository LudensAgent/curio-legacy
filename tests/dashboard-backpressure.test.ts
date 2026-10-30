import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { EventBus } from '../src/events.ts';
import { MAX_BACKLOG, startDashboard } from '../src/observer/dashboard.ts';

const noop = () => {};
const handlers = (snapshot: () => unknown) => ({ snapshot, pause: noop, resume: noop, replan: noop, suggest: noop });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'curio-dash-'));

/** 一个只发请求、从不读响应的 SSE 客户端（像被冻结的浏览器标签） */
function stalledClient(port: number): Promise<net.Socket> {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.write(`GET /api/stream HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAccept: text/event-stream\r\n\r\n`);
      s.pause();
      resolve(s);
    });
    s.on('error', noop);
  });
}

test('an SSE client that stops reading is dropped instead of piling up memory', async (t) => {
  const bus = new EventBus();
  const big = 'x'.repeat(256 * 1024);
  const server = startDashboard('127.0.0.1', 0, bus, handlers(() => ({ big })), [], { env: { file: path.join(tmp(), '.env'), backupDir: tmp() } });
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
  const port = (server.address() as AddressInfo).port;
  const client = await stalledClient(port);
  t.after(() => { client.destroy(); server.closeAllConnections(); server.close(); });
  const closed = new Promise<void>((r) => client.once('close', () => r()));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(server.streamStats().sseClients, 1);
  // 事件帧大量涌来：积压到上限就断开，进程里不会留下超过上限太多的数据
  for (let i = 0; i < 400 && server.streamStats().sseClients; i++) {
    bus.publish('test', 'P3', big);
    assert.ok(server.streamStats().sseBacklog <= MAX_BACKLOG + 2 * big.length);
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(server.streamStats().sseClients, 0);
  assert.equal(server.streamStats().sseDropped, 1);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(bus.recent(10).some((e) => e.type === 'dashboard_slow_client'));
  client.destroy();
  await closed;
  server.close();
});

test('state frames are skipped for a client that has not drained the previous one', async (t) => {
  const bus = new EventBus();
  let snapshots = 0;
  const big = 'y'.repeat(2 * 1024 * 1024);
  const server = startDashboard('127.0.0.1', 0, bus, handlers(() => { snapshots++; return { big }; }), [], { env: { file: path.join(tmp(), '.env'), backupDir: tmp() } });
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
  const port = (server.address() as AddressInfo).port;
  const client = await stalledClient(port);
  t.after(() => { client.destroy(); server.closeAllConnections(); server.close(); });
  await new Promise((r) => setTimeout(r, 3500));
  const st = server.streamStats();
  // 首帧之后对方一直没读：状态帧仍会写入 socket 缓冲，但不会再越积越多（最多一帧），
  // 慢客户端的积压有上界；snapshot 每轮仍可能被调用（writableNeedDrain 不是可靠信号），只做宽松上限。
  assert.equal(st.sseClients, 1);
  assert.ok(st.sseBacklog < 3 * big.length, `backlog ${st.sseBacklog}`);
  assert.ok(snapshots <= 6, `snapshots ${snapshots}`);
});
