import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assertNoLinksIn, existingTestState, hasWorldData, readServerProperty, setServerProperty, syncServerForTest } from '../scripts/test-env.ts';
import { validateLevelName } from '../src/maintenance/world-reset.ts';

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

test('readServerProperty 同名键取最后一个（Java Properties 语义），不漏检真实监听端口', () => {
  const dir = tmp();
  const props = path.join(dir, 'server.properties');
  fs.writeFileSync(props, 'server-port=25565\nserver-port=25566\n');
  assert.equal(readServerProperty(props, 'server-port'), '25566');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readServerProperty 支持 : 分隔符与反斜线转义', () => {
  const dir = tmp();
  const props = path.join(dir, 'server.properties');
  fs.writeFileSync(props, 'server-port:25565\nrcon.password=pa\\=ss\\ word\n');
  assert.equal(readServerProperty(props, 'server-port'), '25565');
  assert.equal(readServerProperty(props, 'rcon.password'), 'pa=ss word');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('existingTestState 识别目标里任何已有世界（即使 level-name 指向别处），避免种子覆盖混入旧区块', () => {
  const dir = tmp();
  const targetServer = path.join(dir, 'target');
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(path.join(targetServer, 'world'), { recursive: true });
  fs.writeFileSync(path.join(targetServer, 'world', 'level.dat'), 'old');
  // level-name 指向尚不存在的 next-world，但旧的 world 仍在；复制种子会覆盖 world/level.dat 并留下旧 region。
  fs.writeFileSync(path.join(targetServer, 'server.properties'), 'level-name=next-world\nserver-port=25565\n');
  const markers = existingTestState({ dataDir, spatialDbPath: path.join(dataDir, 'spatial', 'spatial.sqlite') }, targetServer);
  assert.deepEqual(markers, ['世界 world/level.dat']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('existingTestState 识别嵌套目录里的已有世界（level-name 带路径）', () => {
  const dir = tmp();
  const targetServer = path.join(dir, 'target');
  const dataDir = path.join(dir, 'data');
  const nested = path.join('worlds', 'survival');
  fs.mkdirSync(path.join(targetServer, nested), { recursive: true });
  fs.writeFileSync(path.join(targetServer, nested, 'level.dat'), 'old');
  fs.writeFileSync(path.join(targetServer, 'server.properties'), 'level-name=worlds/survival\nserver-port=25565\n');
  const markers = existingTestState({ dataDir, spatialDbPath: path.join(dataDir, 'spatial', 'spatial.sqlite') }, targetServer);
  assert.deepEqual(markers, [`世界 ${nested}/level.dat`]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('assertNoLinksIn 拒绝目标里的 junction，避免 copySeed 沿它写入另一环境的世界', { skip: process.platform !== 'win32' }, () => {
  const dir = tmp();
  const localWorld = path.join(dir, 'local-world');
  const target = path.join(dir, 'target');
  fs.mkdirSync(localWorld, { recursive: true });
  fs.writeFileSync(path.join(localWorld, 'level.dat'), 'local');
  fs.mkdirSync(target, { recursive: true });
  fs.symlinkSync(localWorld, path.join(target, 'world'), 'junction');
  assert.throws(() => assertNoLinksIn(target), /符号链接或 junction/);
  fs.rmSync(path.join(target, 'world'), { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('assertNoLinksIn 拒绝父目录为 junction、目标尚不存在的场景', { skip: process.platform !== 'win32' }, () => {
  const dir = tmp();
  const localServer = path.join(dir, 'local-server');
  const alias = path.join(dir, 'alias');
  fs.mkdirSync(localServer, { recursive: true });
  fs.writeFileSync(path.join(localServer, 'level.dat'), 'x');
  fs.symlinkSync(localServer, alias, 'junction');
  // 目标 alias/testserver 尚不存在，但其父目录 alias 是 junction，copySeed 会沿它写到 local-server 里。
  assert.throws(() => assertNoLinksIn(path.join(alias, 'testserver')), /符号链接或 junction/);
  fs.rmSync(alias, { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('assertNoLinksIn 对不存在的目标与普通目录不抛错', () => {
  const dir = tmp();
  const empty = path.join(dir, 'fresh');
  assert.doesNotThrow(() => assertNoLinksIn(empty)); // 尚不存在：首次初始化
  fs.mkdirSync(empty, { recursive: true });
  fs.writeFileSync(path.join(empty, 'server.properties'), 'server-port=25565\n');
  assert.doesNotThrow(() => assertNoLinksIn(empty)); // 只有普通文件
  fs.rmSync(dir, { recursive: true, force: true });
});

test('setServerProperty 按逻辑键处理 : 分隔与重复键，写回后最后一条生效', () => {
  const dir = tmp();
  const props = path.join(dir, 'server.properties');
  fs.writeFileSync(props, 'server-port=25565\nserver-port:25567\n');
  setServerProperty(props, 'server-port', '25566');
  assert.equal(readServerProperty(props, 'server-port'), '25566');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('setServerProperty 转义反斜线，密码写回后回读一致', () => {
  const dir = tmp();
  const props = path.join(dir, 'server.properties');
  fs.writeFileSync(props, 'enable-rcon=true\nrcon.port=25575\nrcon.password=old\n');
  setServerProperty(props, 'rcon.password', 'abc\\def');
  assert.equal(readServerProperty(props, 'rcon.password'), 'abc\\def');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('validateLevelName 拒绝指向服务器目录之外的 level-name（../ 与绝对路径）', () => {
  const dir = tmp();
  const server = path.join(dir, 'server');
  fs.mkdirSync(server, { recursive: true });
  assert.throws(() => validateLevelName(server, '../shared-world'), /之外|不安全/);
  assert.throws(() => validateLevelName(server, path.resolve(dir, 'outside')), /之外|不安全/);
  assert.doesNotThrow(() => validateLevelName(server, 'world'));
  fs.rmSync(dir, { recursive: true, force: true });
});
