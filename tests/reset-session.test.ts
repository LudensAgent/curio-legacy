import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { resetTestSession } from '../src/maintenance/reset.ts';
import { registerMemoryBackend } from '../src/memory/registry.ts';
import { memorySettings } from '../src/memory/settings.ts';

function fixture(t: TestContext) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-session-reset-'));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  const dataDir = path.join(projectDir, 'data');
  const serverDir = path.join(projectDir, 'world');
  for (const directory of [dataDir, serverDir, path.join(serverDir, 'world'), path.join(serverDir, 'mods')]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'history.json'), 'old memories');
  fs.writeFileSync(path.join(serverDir, 'eula.txt'), 'eula=true\n');
  fs.writeFileSync(path.join(serverDir, 'server.properties'), 'level-name=world\nlevel-seed=old-seed\nserver-port=25565\n');
  fs.writeFileSync(path.join(serverDir, 'world', 'level.dat'), 'old world');
  fs.writeFileSync(path.join(serverDir, 'mods', 'test.jar'), 'mod');
  const options = { dataDir, projectDir, serverDir, memory: memorySettings({ MEMORY_PROVIDER: 'hindsight' }), full: true };
  return { ...options, options };
}

test('reset: dry-run is read-only and never probes or contacts services', async (t) => {
  const x = fixture(t);
  const original = fs.readFileSync(path.join(x.serverDir, 'server.properties'));
  const outcome = await resetTestSession({ ...x.options, dryRun: true }, {
    backendFactory: () => { throw new Error('No remote calls during preview'); },
    ensureOffline: async () => { throw new Error('No TCP probes during preview'); },
  });
  assert.equal(outcome.dryRun, true);
  assert.equal(outcome.result, null);
  assert.equal(outcome.plan.memory.banks.length, 1, 'Active Hindsight bank is included even without a registry');
  assert.ok(outcome.plan.world?.removed.includes('world'));
  assert.ok(original.equals(fs.readFileSync(path.join(x.serverDir, 'server.properties'))));
  assert.equal(fs.readFileSync(path.join(x.dataDir, 'history.json'), 'utf8'), 'old memories');
  assert.deepEqual(fs.readdirSync(x.dataDir), ['history.json']);
});

test('reset: verify remote cleanup before deleting local memories and generating a fresh random world', async (t) => {
  const x = fixture(t);
  const sequence: string[] = [];
  const outcome = await resetTestSession(x.options, {
    ensureOffline: async (endpoints) => { sequence.push('offline'); assert.equal(endpoints[0].label, 'Minecraft 服务器'); },
    backendFactory: () => ({ async clear() {
      sequence.push('remote');
      assert.ok(fs.existsSync(path.join(x.serverDir, 'world', 'level.dat')));
      assert.ok(fs.existsSync(path.join(x.dataDir, 'history.json')));
      assert.match(fs.readFileSync(path.join(x.serverDir, 'server.properties'), 'utf8'), /old-seed/);
    } }),
  });
  assert.deepEqual(sequence, ['offline', 'remote']);
  assert.equal(outcome.result?.memory.banksCleared, 1);
  assert.deepEqual(fs.readdirSync(x.dataDir), []);
  assert.ok(!fs.existsSync(path.join(x.serverDir, 'world')));
  assert.ok(!fs.readFileSync(path.join(x.serverDir, 'server.properties'), 'utf8').includes('old-seed'));
  assert.equal(fs.readFileSync(path.join(x.serverDir, 'eula.txt'), 'utf8'), 'eula=true\n');
  assert.equal(fs.readFileSync(path.join(x.serverDir, 'mods', 'test.jar'), 'utf8'), 'mod');
});

test('reset: remote failure keeps the world, its seed and local memories unchanged', async (t) => {
  const x = fixture(t);
  const original = fs.readFileSync(path.join(x.serverDir, 'server.properties'));
  await assert.rejects(resetTestSession(x.options, {
    ensureOffline: async () => {},
    backendFactory: () => ({ async clear() { throw new Error('Hindsight unavailable'); } }),
  }), /Hindsight unavailable/);
  assert.ok(original.equals(fs.readFileSync(path.join(x.serverDir, 'server.properties'))));
  assert.equal(fs.readFileSync(path.join(x.serverDir, 'world', 'level.dat'), 'utf8'), 'old world');
  assert.equal(fs.readFileSync(path.join(x.dataDir, 'history.json'), 'utf8'), 'old memories');
});

test('reset: invalid world settings are rejected before any remote deletion', async (t) => {
  const x = fixture(t);
  fs.writeFileSync(path.join(x.serverDir, 'server.properties'), 'level-name=../outside\nlevel-seed=old-seed\n');
  let calls = 0;
  await assert.rejects(resetTestSession(x.options, {
    ensureOffline: async () => {}, backendFactory: () => ({ async clear() { calls++; } }),
  }));
  assert.equal(calls, 0);
  assert.ok(fs.existsSync(path.join(x.dataDir, 'history.json')));
});

test('reset: active services block every cleanup step', async (t) => {
  const x = fixture(t);
  let calls = 0;
  await assert.rejects(resetTestSession(x.options, {
    ensureOffline: async () => { throw new Error('Agent still running'); },
    backendFactory: () => ({ async clear() { calls++; } }),
  }), /still running/);
  assert.equal(calls, 0);
  assert.ok(fs.existsSync(path.join(x.serverDir, 'world', 'level.dat')));
  assert.ok(fs.existsSync(path.join(x.dataDir, 'history.json')));
});

test('reset: other endpoints block full reset without touching memories or worlds', async (t) => {
  const x = fixture(t);
  registerMemoryBackend(x.dataDir, { baseUrl: 'http://localhost:7777', bankId: x.memory.bankId });
  let calls = 0;
  await assert.rejects(resetTestSession(x.options, {
    ensureOffline: async () => {}, backendFactory: () => ({ async clear() { calls++; } }),
  }), /HINDSIGHT_URL/);
  assert.equal(calls, 0);
  assert.ok(fs.existsSync(path.join(x.serverDir, 'world', 'level.dat')));
});
