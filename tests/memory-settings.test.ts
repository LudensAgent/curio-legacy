import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memorySettings } from '../src/memory/settings.ts';

test('memory settings: opt-in provider, stable world/agent bank and explicit budgets', () => {
  const settings = memorySettings({});
  assert.equal(settings.provider, 'local');
  assert.equal(settings.timeoutMs, 1500);
  assert.equal(settings.retainTimeoutMs, 60000);
  assert.equal(settings.maxContextBytes, 6000);
  assert.match(settings.bankId, /^mc-[a-f0-9]{32}$/);
  assert.equal(settings.bankId, memorySettings({}).bankId);
  assert.notEqual(settings.bankId, memorySettings({ MEMORY_WORLD_ID: 'new-save' }).bankId);
  assert.notEqual(settings.bankId, memorySettings({ BOT_USERNAME: 'Other' }).bankId);
  assert.equal(memorySettings({ HINDSIGHT_URL: 'http://localhost:8888///' }).baseUrl, 'http://localhost:8888');
});

test('memory settings: reject unsafe endpoints and malformed limits', () => {
  for (const url of ['file:///local', 'http://user:secret@localhost', 'http://localhost?key=secret', 'http://localhost/#secret']) {
    assert.throws(() => memorySettings({ HINDSIGHT_URL: url }));
  }
  for (const env of [
    { MEMORY_PROVIDER: 'unknown' }, { MEMORY_WORLD_ID: '' }, { BOT_USERNAME: '' },
    { MEMORY_TIMEOUT_MS: '0' }, { MEMORY_RETAIN_TIMEOUT_MS: 'NaN' }, { MEMORY_CONTEXT_MAX_BYTES: '999999' },
  ]) assert.throws(() => memorySettings(env));
});
