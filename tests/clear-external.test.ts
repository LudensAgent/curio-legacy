import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { clearAllMemory } from '../src/memory/clear-external.ts';
import { readMemoryRegistry, registerMemoryBackend } from '../src/memory/registry.ts';
import { memorySettings } from '../src/memory/settings.ts';

function setup(t: TestContext) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-clear-external-'));
  const data = path.join(project, 'data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'world-memory.json'), 'history');
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  return { project, data, settings: memorySettings({ MEMORY_PROVIDER: 'hindsight' }) };
}

test('clear all: remote success is verified before deleting local history; registrations survive provider changes', async (t) => {
  const x = setup(t);
  const older = memorySettings({ MEMORY_WORLD_ID: 'old-world' });
  registerMemoryBackend(x.data, { baseUrl: older.baseUrl, bankId: older.bankId });
  const cleared: string[] = [];
  const result = await clearAllMemory(x.data, x.project, { ...x.settings, provider: 'local' }, (entry) => ({
    async clear(signal) {
      assert.ok(!signal.aborted);
      assert.ok(fs.existsSync(path.join(x.data, 'world-memory.json')));
      cleared.push(entry.bankId);
    },
  }));
  assert.deepEqual(cleared, [older.bankId]);
  assert.equal(result.banksCleared, 1);
  assert.ok(!fs.existsSync(x.data));
});

test('clear all: remote errors preserve local history and registry for retry', async (t) => {
  const x = setup(t);
  registerMemoryBackend(x.data, x.settings);
  await assert.rejects(clearAllMemory(x.data, x.project, x.settings, () => ({
    async clear() { throw new Error('cannot verify deletion'); },
  })), /cannot verify/);
  assert.equal(fs.readFileSync(path.join(x.data, 'world-memory.json'), 'utf8'), 'history');
  assert.equal(readMemoryRegistry(x.data).length, 1);
});

test('clear all: reject dangerous local targets and foreign banks before any remote request', async (t) => {
  const x = setup(t);
  let calls = 0;
  const factory = () => ({ async clear() { calls++; } });
  await assert.rejects(clearAllMemory(x.project, x.project, x.settings, factory), /拒绝清空/);
  registerMemoryBackend(x.data, { baseUrl: x.settings.baseUrl, bankId: 'other-app-bank' });
  await assert.rejects(clearAllMemory(x.data, x.project, x.settings, factory), /非本应用/);
  assert.equal(calls, 0);
});

test('clear all: repeated remote cleanup is idempotent and deduplicates the active bank', async (t) => {
  const x = setup(t);
  registerMemoryBackend(x.data, x.settings);
  let calls = 0;
  const factory = () => ({ async clear() { calls++; } });
  assert.equal((await clearAllMemory(x.data, x.project, x.settings, factory)).banksCleared, 1);
  assert.equal((await clearAllMemory(x.data, x.project, x.settings, factory)).cleared, false);
  assert.equal(calls, 2);
});

test('clear all: multiple endpoints are cleaned without sending the current credentials to old hosts', async (t) => {
  const x = setup(t);
  const old = { baseUrl: 'http://localhost:7777', bankId: memorySettings({ MEMORY_WORLD_ID: 'old' }).bankId };
  registerMemoryBackend(x.data, old);
  registerMemoryBackend(x.data, x.settings);
  const calls: string[] = [];
  const factory = (entry: { baseUrl: string }) => ({ async clear() { calls.push(entry.baseUrl); } });
  await assert.rejects(clearAllMemory(x.data, x.project, x.settings, factory), /HINDSIGHT_URL/);
  assert.deepEqual(calls, [x.settings.baseUrl]);
  assert.deepEqual(readMemoryRegistry(x.data), [old]);
  assert.ok(fs.existsSync(x.data));
  await clearAllMemory(x.data, x.project, { ...x.settings, provider: 'local', baseUrl: old.baseUrl }, factory);
  assert.ok(!fs.existsSync(x.data));
  assert.deepEqual(calls, [x.settings.baseUrl, old.baseUrl]);
});
