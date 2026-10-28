import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { buffer } from 'node:stream/consumers';
import { test } from 'node:test';
import { hindsightBankOps } from '../src/memory/hindsight.ts';

test('Hindsight bank restore uses an existing operation bank and preserves the snapshot for repeated loads', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-bank-transfer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, 'bank.zip');
  const contents = Buffer.from('saved bank archive');
  fs.writeFileSync(archive, contents);
  const bankId = 'mc-74f09d5f63f0480efbf2285f7c2a1946';
  const operationBankId = `${bankId}-import`;
  const banks = new Set([bankId]);
  const calls: string[] = [];
  let imports = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url!, 'http://localhost');
      const requestBank = url.pathname.split('/')[4];
      const body = await buffer(request);
      let status = 200;
      let result: unknown;
      if (request.method === 'DELETE') {
        assert.equal(requestBank, bankId);
        banks.delete(bankId);
        calls.push('remove');
        result = { success: true };
      } else if (request.method === 'GET' && url.pathname === '/v1/default/banks') {
        const matching = [...banks].filter(id => id.includes(url.searchParams.get('q') ?? ''));
        result = { banks: matching.map(bank_id => ({ bank_id })), total: matching.length, limit: 100, offset: 0 };
      } else if (request.method === 'PUT') {
        assert.equal(requestBank, operationBankId);
        assert.deepEqual(JSON.parse(body.toString('utf8')), {});
        banks.add(requestBank);
        calls.push('create-operation-bank');
        result = { bank_id: requestBank };
      } else if (request.method === 'POST' && url.pathname.endsWith('/transfer/import')) {
        const target = url.searchParams.get('target_bank_id');
        if (!banks.has(requestBank)) {
          status = 404;
          result = { detail: `Bank '${requestBank}' not found` };
        } else if (target && banks.has(target)) {
          status = 400;
          result = { detail: `Target bank '${target}' already exists` };
        } else {
          assert.equal(requestBank, operationBankId);
          assert.equal(target, bankId);
          assert.notEqual(requestBank, target);
          assert.match(request.headers['content-type'] ?? '', /^multipart\/form-data;/);
          assert.ok(body.includes(contents), '上传的内容来自原始存档 ZIP');
          banks.add(bankId);
          imports++;
          calls.push('import-target');
          result = { operation_id: `restore-${imports}` };
        }
      } else if (request.method === 'GET' && url.pathname.endsWith(`/operations/restore-${imports}`)) {
        assert.equal(requestBank, operationBankId);
        assert.ok(banks.has(requestBank));
        calls.push('poll-operation-bank');
        result = { operation_id: `restore-${imports}`, status: 'completed' };
      } else {
        assert.fail(`Unexpected request: ${request.method} ${url.pathname}`);
      }
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result));
    })().catch(error => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ detail: String(error) }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const bank = hindsightBankOps({ baseUrl: `http://127.0.0.1:${address.port}`, apiKey: '' });
  for (const round of [1, 2]) {
    await bank.remove(bankId);
    await bank.importFrom(archive, bankId);
    assert.ok(banks.has(bankId), `第 ${round} 次恢复目标记忆库成功`);
    assert.deepEqual(fs.readFileSync(archive), contents, '读档保留原始 ZIP');
  }
  assert.equal(imports, 2);
  assert.ok(banks.has(operationBankId), '操作宿主保留，供后台任务及状态查询使用');
  assert.deepEqual(calls, [1, 2].flatMap(() => [
    'remove', 'create-operation-bank', 'import-target', 'poll-operation-bank',
  ]));
});
