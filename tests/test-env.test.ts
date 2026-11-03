import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { existingTestState, hasWorldData, readServerProperty, syncServerForTest } from '../scripts/test-env.ts';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'test-env-')); }

test('existingTestState 依据目标自身的 level-name 识别已有世界（不拿种子的 level-name 查目标）', () => {
  const dir = tmp();
  const targetServer = path.join(dir, 'target');
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(path.join(targetServer, 'existing-world'), { recursive: true });
  fs.writeFileSync(path.join(targetServer, 'existing-world', 'level.dat'), 'x');
  fs.writeFileSync(path.join(targetServer, 'server.properties'), 'level-name=existing-world\nserver-port=25565\n');
  const markers = existingTestState({ dataDir, spatialDbPath: path.join(dataDir, 'spatial', 'spatial.sqlite') }, targetServer);
  assert.deepEqual(markers, ['世界 existing-world/level.dat']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('existingTestState 识别已有初始化标记、情境记忆与空间数据库', () => {
  const dir = tmp();
  const targetServer = path.join(dir, 'target');
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(path.join(dataDir, 'spatial'), { recursive: true });
  const spatial = path.join(dataDir, 'spatial', 'spatial.sqlite');
  fs.writeFileSync(spatial, 'db');
  fs.writeFileSync(path.join(dataDir, 'world-memory.json'), '{}');
  fs.writeFileSync(path.join(dataDir, 'init.json'), '{}');
  const markers = existingTestState({ dataDir, spatialDbPath: spatial }, targetServer);
  assert.deepEqual(markers, ['初始化标记 init.json', '情境记忆 world-memory.json', `空间数据库 ${spatial}`]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('existingTestState 对空目录/仅 server.properties 返回空（不算已初始化）', () => {
  const dir = tmp();
  const targetServer = path.join(dir, 'target');
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(targetServer, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(targetServer, 'server.properties'), 'server-port=25565\n');
  assert.deepEqual(existingTestState({ dataDir, spatialDbPath: path.join(dataDir, 'spatial', 'spatial.sqlite') }, targetServer), []);
  assert.equal(hasWorldData(targetServer), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('syncServerForTest 让副本的游戏与 RCON 配置和 test 一致，且不改种子源', () => {
  const dir = tmp();
  const seed = path.join(dir, 'seed');
  const target = path.join(dir, 'target');
  fs.mkdirSync(seed, { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(seed, 'server.properties'), 'level-name=world\nserver-port=25565\nenable-rcon=true\nrcon.port=25575\nrcon.password=seed-secret\n');
  fs.copyFileSync(path.join(seed, 'server.properties'), path.join(target, 'server.properties'));
  syncServerForTest(target, { mcPort: 25566, rconPort: 25576, rconPassword: 'test-secret' });
  assert.equal(readServerProperty(path.join(target, 'server.properties'), 'server-port'), '25566');
  assert.equal(readServerProperty(path.join(target, 'server.properties'), 'enable-rcon'), 'true');
  assert.equal(readServerProperty(path.join(target, 'server.properties'), 'rcon.port'), '25576');
  assert.equal(readServerProperty(path.join(target, 'server.properties'), 'rcon.password'), 'test-secret');
  // 种子源保持不变。
  assert.equal(readServerProperty(path.join(seed, 'server.properties'), 'server-port'), '25565');
  assert.equal(readServerProperty(path.join(seed, 'server.properties'), 'rcon.port'), '25575');
  assert.equal(readServerProperty(path.join(seed, 'server.properties'), 'rcon.password'), 'seed-secret');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('syncServerForTest 在无 RCON 密码时关闭 RCON', () => {
  const dir = tmp();
  const target = path.join(dir, 'target');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'server.properties'), 'server-port=25565\nenable-rcon=true\nrcon.port=25575\nrcon.password=seed-secret\n');
  syncServerForTest(target, { mcPort: 25566, rconPort: 25576, rconPassword: '' });
  assert.equal(readServerProperty(path.join(target, 'server.properties'), 'enable-rcon'), 'false');
  assert.equal(readServerProperty(path.join(target, 'server.properties'), 'rcon.password'), '');
  fs.rmSync(dir, { recursive: true, force: true });
});
