import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { EventBus } from '../src/events.ts';
import { SkillBook } from '../src/knowledge/skillbook.ts';
import { BehaviorEngine } from '../src/mind/behaviors.ts';
import { installSkillRestoreRequest } from '../src/mind/restore-request.ts';
import { FakeAdapter } from './fake-adapter.ts';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'skills');

test('explicit restore runs only after the dashboard listens and preserves other state and evidence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-restore-'));
  const statsFile = path.join(dir, 'stats.json'), requestFile = path.join(dir, 'request.json');
  const stats = {
    'local-path': { fired: 2, ok: 3, fail: 1, lastAt: 123, lastUsedAt: 124, disabled: true, retired: '在线观察 7 个有效游戏日没用上', retiredAt: 100, byVersion: { '1': { ok: 3, fail: 1 } } },
    'pillar-out-of-pit': { fired: 0, ok: 0, fail: 0, lastAt: 0, disabled: true, retired: '合并进其他技能', retiredAt: 200 },
  };
  fs.writeFileSync(statsFile, JSON.stringify(stats));
  fs.writeFileSync(requestFile, JSON.stringify({ entries: [{ name: 'local-path', retiredAt: 100 }] }));
  const bus = new EventBus(), server = new EventEmitter();
  const engine = new BehaviorEngine(new SkillBook(null, fixtures), new FakeAdapter(), null, bus, { perceivedEntities: () => [] }, statsFile);
  installSkillRestoreRequest(server, engine, bus, requestFile);
  assert.equal(engine.inactive('local-path'), true);
  assert.ok(fs.existsSync(requestFile), 'a process that cannot bind does not consume the request');
  server.emit('listening');
  assert.equal(engine.inactive('local-path'), false);
  assert.equal(engine.inactive('pillar-out-of-pit'), true);
  const after = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
  assert.equal(after['local-path'].lastUsedAt, 124);
  assert.deepEqual(after['local-path'].byVersion, stats['local-path'].byVersion);
  assert.equal(after['local-path'].lastRestoration.reason, '在线观察 7 个有效游戏日没用上');
  assert.equal(after['local-path'].lastRestoration.retiredAt, 100);
  assert.equal(after['local-path'].restoredAt, after['local-path'].lastRestoration.at);
  assert.deepEqual(after['pillar-out-of-pit'], stats['pillar-out-of-pit']);
  assert.equal(fs.existsSync(requestFile), false);
  assert.ok(bus.recent(20).some((e) => e.type === 'skill_restored'));
});

test('a changed retirement or non-idle reason rejects the entire request without altering history', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-restore-'));
  const statsFile = path.join(dir, 'stats.json'), requestFile = path.join(dir, 'request.json');
  const stats = {
    'local-path': { fired: 0, ok: 1, fail: 1, lastAt: 0, disabled: true, retired: '7 小时没用上', retiredAt: 100 },
    'pillar-out-of-pit': { fired: 0, ok: 0, fail: 0, lastAt: 0, disabled: true, retired: '合并进其他技能', retiredAt: 200 },
  };
  fs.writeFileSync(statsFile, JSON.stringify(stats));
  fs.writeFileSync(requestFile, JSON.stringify({ entries: [{ name: 'local-path', retiredAt: 100 }, { name: 'pillar-out-of-pit', retiredAt: 200 }] }));
  const bus = new EventBus(), server = new EventEmitter();
  const engine = new BehaviorEngine(new SkillBook(null, fixtures), new FakeAdapter(), null, bus, { perceivedEntities: () => [] }, statsFile);
  installSkillRestoreRequest(server, engine, bus, requestFile);
  server.emit('listening');
  assert.equal(engine.inactive('local-path'), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(statsFile, 'utf8')), stats);
  assert.ok(fs.existsSync(requestFile));
  assert.ok(bus.recent(20).some((e) => e.type === 'skill_restore_failed'));
  fs.writeFileSync(requestFile, JSON.stringify({ entries: [{ name: 'local-path', retiredAt: 99 }] }));
  const retry = new EventEmitter();
  installSkillRestoreRequest(retry, engine, bus, requestFile);
  retry.emit('listening');
  assert.equal(engine.inactive('local-path'), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(statsFile, 'utf8')), stats);
  assert.ok(fs.existsSync(requestFile), 'a request prepared against an older status remains available for review');
});
