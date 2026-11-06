import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { OpenAICompatibleProvider } from '../src/planner/llm.ts';

const cfg = (baseUrl: string) => ({ provider: 'openai' as const, providerLabel: 'x', baseUrl, apiKey: '', model: 'm', temperature: 0.5, jsonMode: true, timeoutMs: 5000, maxTokens: 100, maxCallsPerHour: 10, fakeDelayMs: 0, stream: false });

test('LLM 瞬时故障（DNS/连接/5xx）退避重试一次后成功，不打扰调用方', async () => {
  let n = 0;
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      n++;
      if (n === 1) { res.writeHead(503); return res.end('overloaded'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":1}' }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const p = new OpenAICompatibleProvider(cfg(`http://127.0.0.1:${(srv.address() as any).port}`));
  const c = await p.complete([{ role: 'user', content: 'hi' }], AbortSignal.timeout(10000));
  srv.close();
  assert.equal(c.text, '{"ok":1}');
  assert.equal(n, 2, '第一次 503 后退避重试成功');
});

test('LLM 瞬时故障持续存在：退避重试 3 次后放弃并抛出', async () => {
  let n = 0;
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { n++; res.writeHead(503); res.end('overloaded'); });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const p = new OpenAICompatibleProvider(cfg(`http://127.0.0.1:${(srv.address() as any).port}`));
  await assert.rejects(() => p.complete([{ role: 'user', content: 'hi' }], AbortSignal.timeout(15000)), /HTTP 503/);
  srv.close();
  assert.equal(n, 4, '首次 + 3 次退避重试');
});

test('LLM 连接被拒（ECONNREFUSED）也算瞬时故障：退避重试后放弃', async () => {
  // 占一个端口号再立刻关掉，指向它得到稳定的 ECONNREFUSED（和 DNS 一样「请求根本没到服务端」）
  const tmp = http.createServer(() => {});
  await new Promise<void>((r) => tmp.listen(0, '127.0.0.1', r));
  const port = (tmp.address() as any).port;
  await new Promise<void>((r) => tmp.close(() => r()));
  const p = new OpenAICompatibleProvider(cfg(`http://127.0.0.1:${port}`));
  await assert.rejects(() => p.complete([{ role: 'user', content: 'hi' }], AbortSignal.timeout(15000)), /ECONNREFUSED|fetch failed/);
});
