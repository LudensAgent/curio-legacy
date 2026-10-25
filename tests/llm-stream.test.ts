import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { LlmTrace } from '../src/planner/llm-trace.ts';
import { OpenAICompatibleProvider } from '../src/planner/llm.ts';

const cfg = (baseUrl: string) => ({ provider: 'openai' as const, providerLabel: 'x', baseUrl, apiKey: '', model: 'm', temperature: 0.5, jsonMode: true, timeoutMs: 5000, maxTokens: 100, maxCallsPerHour: 10, fakeDelayMs: 0, stream: true });

test('LLM 流式：逐块回调思考与正文，结束时带 usage；追踪器记录完整调用', async () => {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      assert.equal(JSON.parse(body).stream, true);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      send({ choices: [{ delta: { reasoning_content: '想一想' } }] });
      send({ choices: [{ delta: { content: '{"goal":' } }] });
      send({ choices: [{ delta: { content: '"x"}' }, finish_reason: 'stop' }] });
      send({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as any).port;
  const trace = new LlmTrace();
  const events: any[] = [];
  trace.on('llm', (e) => events.push(e));
  const id = trace.begin({ reason: 'no_goal', attempt: 0, provider: 'p' }, [{ role: 'user', content: 'hi' }]);
  const c = await new OpenAICompatibleProvider(cfg(`http://127.0.0.1:${port}`)).complete([{ role: 'user', content: 'hi' }], AbortSignal.timeout(5000), null, (d) => trace.delta(id, d));
  trace.end(id, { status: 'ok', text: c.text, latencyMs: c.latencyMs, usage: c.usage, finishReason: c.finishReason });
  srv.close();
  assert.equal(c.text, '{"goal":"x"}');
  assert.equal(c.finishReason, 'stop');
  assert.equal(c.usage?.total_tokens, 15);
  const rec = trace.recent()[0];
  assert.equal(rec.reasoning, '想一想');
  assert.equal(rec.content, '{"goal":"x"}');
  assert.deepEqual(events.map((e) => e.kind), ['request', 'delta', 'done']);
});

test('LLM 流式：服务端不支持（HTTP 400）→ 自动回退为普通请求', async () => {
  let n = 0;
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      n++;
      if (JSON.parse(body).stream) { res.writeHead(400); return res.end('stream not supported'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":1}' }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const p = new OpenAICompatibleProvider(cfg(`http://127.0.0.1:${(srv.address() as any).port}`));
  const c = await p.complete([{ role: 'user', content: 'hi' }], AbortSignal.timeout(5000), null, () => {});
  await p.complete([{ role: 'user', content: 'hi' }], AbortSignal.timeout(5000), null, () => {});
  srv.close();
  assert.equal(c.text, '{"ok":1}');
  assert.equal(n, 3, '第二次直接走普通请求');
});

test('个别任务可以放大输出上限（建筑设计 4 倍），其余照旧', async () => {
  const seen: number[] = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push(JSON.parse(body).max_tokens);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const p = new OpenAICompatibleProvider({ ...cfg(`http://127.0.0.1:${(srv.address() as any).port}`), stream: false });
  await p.complete([{ role: 'user', content: 'hi' }], AbortSignal.timeout(5000), { tier: 'full', maxTokensScale: 4 });
  await p.complete([{ role: 'user', content: 'hi' }], AbortSignal.timeout(5000), { tier: 'full' });
  srv.close();
  assert.deepEqual(seen, [400, 100]);
});
