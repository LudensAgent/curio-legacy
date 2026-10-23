import assert from 'node:assert/strict';
import net from 'node:net';
import { test, type TestContext } from 'node:test';
import { assertResetOffline, type ResetEndpoint } from '../src/maintenance/offline.ts';

async function listening(t: TestContext, host = '127.0.0.1') {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => { server.off('error', reject); resolve(); });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  return { server, port: (server.address() as net.AddressInfo).port };
}

function refuse(t: TestContext, calls: net.NetConnectOpts[]) {
  t.mock.method(net, 'createConnection', (options: net.NetConnectOpts) => {
    calls.push(options);
    const socket = new net.Socket();
    queueMicrotask(() => socket.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })));
    return socket;
  });
}

test('重置离线检查：临时 Agent 服务监听时拒绝，断开探测连接', async (t) => {
  const { port } = await listening(t);
  await assert.rejects(assertResetOffline([{ host: '127.0.0.1', port, label: 'Agent 面板' }]), /Agent 面板.*正在监听.*先停止/);
});

test('重置离线检查：临时 Minecraft 服务关闭后允许', async (t) => {
  const { server, port } = await listening(t);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await assertResetOffline([{ host: '127.0.0.1', port, label: 'Minecraft 服务器' }]);
});

test('重置离线检查：所有端点先验证，非法参数不触网', async (t) => {
  let calls = 0;
  t.mock.method(net, 'createConnection', () => { calls++; throw new Error('must not connect'); });
  const valid = { host: '127.0.0.1', port: 25565, label: 'Minecraft' };
  for (const port of [0, -1, 65536, 3.5, Number.NaN, '25565']) {
    await assert.rejects(assertResetOffline([valid, { ...valid, port } as ResetEndpoint]), /端口必须/);
  }
  for (const host of ['', ' ', '[]', 'bad\nhost', null]) {
    await assert.rejects(assertResetOffline([{ ...valid, host } as ResetEndpoint]), /地址无效/);
  }
  await assert.rejects(assertResetOffline([{ ...valid, label: '' }]), /服务名称/);
  await assert.rejects(assertResetOffline(null as unknown as ResetEndpoint[]), /服务列表/);
  assert.equal(calls, 0);
});

test('重置离线检查：通配地址映射 loopback 并对端点去重', async (t) => {
  const calls: net.NetConnectOpts[] = [];
  refuse(t, calls);
  await assertResetOffline([
    { host: '0.0.0.0', port: 25565, label: 'Minecraft' },
    { host: '127.0.0.1', port: 25565, label: 'Minecraft 重复' },
    { host: '::', port: 3000, label: 'Agent IPv6' },
    { host: '[::1]', port: 3000, label: 'Agent IPv6 重复' },
    { host: 'LOCALHOST', port: 3100, label: 'Agent' },
    { host: 'localhost', port: 3100, label: 'Agent 重复' },
  ]);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((call) => (call as net.TcpNetConnectOpts).host), ['127.0.0.1', '::1', 'localhost']);
});

test('重置离线检查：0.0.0.0 不能绕过正在监听的本地服务器', async (t) => {
  const { port } = await listening(t);
  await assert.rejects(assertResetOffline([{ host: '0.0.0.0', port, label: 'Minecraft' }]), /正在监听/);
});

test('重置离线检查：DNS、权限及其他连接错误不等于离线', async (t) => {
  for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'EACCES', 'EPERM', 'ETIMEDOUT', 'ECONNRESET']) {
    await t.test(code, async (subtest) => {
      let socket: net.Socket | undefined;
      subtest.mock.method(net, 'createConnection', () => {
        socket = new net.Socket();
        queueMicrotask(() => socket!.emit('error', Object.assign(new Error('failure'), { code })));
        return socket;
      });
      await assert.rejects(assertResetOffline([{ host: 'test.invalid', port: 25565, label: 'Minecraft' }]), new RegExp(`无法确认.*${code}.*拒绝清理`));
      assert.equal(socket?.destroyed, true);
    });
  }
});

test('重置离线检查：同步连接异常拒绝且不会遗留计时器', async (t) => {
  t.mock.method(net, 'createConnection', () => { throw Object.assign(new Error('invalid options'), { code: 'ERR_INVALID_ARG_VALUE' }); });
  await assert.rejects(assertResetOffline([{ host: '127.0.0.1', port: 3000, label: 'Agent' }]), /无法确认.*ERR_INVALID_ARG_VALUE/);
});

test('重置离线检查：多地址聚合错误必须每次均为拒绝连接', async (t) => {
  for (const allRefused of [false, true]) {
    await t.test(allRefused ? '均被拒绝' : '混合权限错误', async (subtest) => {
      subtest.mock.method(net, 'createConnection', () => {
        const socket = new net.Socket();
        const failures = ['ECONNREFUSED', allRefused ? 'ECONNREFUSED' : 'EACCES'].map((code) => Object.assign(new Error('failure'), { code }));
        queueMicrotask(() => socket.emit('error', Object.assign(new AggregateError(failures), { code: 'ECONNREFUSED' })));
        return socket;
      });
      const pending = assertResetOffline([{ host: 'localhost', port: 3000, label: 'Agent' }]);
      if (allRefused) await pending;
      else await assert.rejects(pending, /无法确认.*拒绝清理/);
    });
  }
});

test('重置离线检查：无响应在约 800ms 后拒绝并释放 socket', async (t) => {
  const socket = new net.Socket();
  t.mock.method(net, 'createConnection', () => socket);
  const start = Date.now();
  await assert.rejects(assertResetOffline([{ host: '127.0.0.1', port: 3000, label: 'Agent' }]), /连接检查超时/);
  assert.ok(Date.now() - start >= 650);
  assert.ok(Date.now() - start < 5000);
  assert.equal(socket.destroyed, true);
});

test('重置离线检查：未建立连接就关闭时无法确认离线', async (t) => {
  const socket = new net.Socket();
  t.mock.method(net, 'createConnection', () => { queueMicrotask(() => socket.emit('close')); return socket; });
  await assert.rejects(assertResetOffline([{ host: '127.0.0.1', port: 3000, label: 'Agent' }]), /连接提前关闭/);
  assert.equal(socket.destroyed, true);
});
