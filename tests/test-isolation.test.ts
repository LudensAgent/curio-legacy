import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assertTestIsolation, peerLayouts, resolveLayout, writableDirsOf, type Layout } from '../src/config/isolation.ts';

function testLayout(base: string, overrides: Partial<Layout> = {}): Layout {
  const d = (p: string) => path.join(base, p);
  return {
    mode: 'test',
    dataDir: d('curio/data/test'),
    serverDir: d('curio/world-test'),
    agentsDir: d('curio/agents/test'),
    llmArchiveDir: d('curio/archives/test/llm-calls'),
    observerHudConfig: d('curio/observer-hud.test.json'),
    spatialDbPath: d('curio/data/test/spatial/spatial.sqlite'),
    worldId: 'curio-test-01',
    mcHost: '127.0.0.1',
    mcPort: 25566,
    rconHost: '127.0.0.1',
    rconPort: 25576,
    dashboardPort: 3002,
    ...overrides,
  };
}

function localLayout(base: string, overrides: Partial<Layout> = {}): Layout {
  const d = (p: string) => path.join(base, p);
  return testLayout(base, {
    mode: 'local',
    dataDir: d('curio/data/local'),
    serverDir: d('curio/world'),
    agentsDir: d('curio/agents/local'),
    llmArchiveDir: d('curio/archives/local/llm-calls'),
    observerHudConfig: d('curio/observer-hud.local.json'),
    spatialDbPath: d('curio/data/local/spatial/spatial.sqlite'),
    worldId: 'curio-local',
    mcPort: 25565,
    rconPort: 25575,
    dashboardPort: 3001,
    ...overrides,
  });
}

test('resolveLayout 解析默认值：空间库默认落在数据目录下，test 控制台端口默认 3002', () => {
  const base = os.tmpdir();
  const l = resolveLayout('test', {}, base);
  assert.equal(l.dataDir, path.join(base, 'data', 'test'));
  assert.equal(l.serverDir, path.join(base, 'world'));
  assert.equal(l.spatialDbPath, path.join(base, 'data', 'test', 'spatial', 'spatial.sqlite'));
  assert.equal(l.dashboardPort, 3002);
  assert.equal(l.worldId, '127.0.0.1:25565');
  assert.ok(writableDirsOf(l).includes(path.dirname(l.spatialDbPath)));
});

test('assertTestIsolation 接受完全分离的布局', () => {
  const base = os.tmpdir();
  assert.doesNotThrow(() => assertTestIsolation(testLayout(base), [localLayout(base)], { worldIdExplicit: true }));
});

test('test 未显式配置 MEMORY_WORLD_ID 时拒绝', () => {
  const base = os.tmpdir();
  assert.throws(() => assertTestIsolation(testLayout(base), [localLayout(base)], { worldIdExplicit: false }), /MEMORY_WORLD_ID/);
});

test('test 世界身份与 local/live 相同时拒绝', () => {
  const base = os.tmpdir();
  assert.throws(
    () => assertTestIsolation(testLayout(base, { worldId: 'curio-local' }), [localLayout(base)], { worldIdExplicit: true }),
    /MEMORY_WORLD_ID.*curio-local/,
  );
});

test('test 数据目录与 local 数据目录相互包含时拒绝', () => {
  const base = os.tmpdir();
  const local = localLayout(base);
  // test 数据目录塞进 local 数据目录内部
  const nested = testLayout(base, { dataDir: path.join(local.dataDir, 'nested') });
  assert.throws(() => assertTestIsolation(nested, [local], { worldIdExplicit: true }), /可写目录.*冲突/);
});

test('test 世界目录沿用公共 SERVER_DIR（与 local 相同）时拒绝', () => {
  const base = os.tmpdir();
  const local = localLayout(base);
  const same = testLayout(base, { serverDir: local.serverDir });
  assert.throws(() => assertTestIsolation(same, [local], { worldIdExplicit: true }), /可写目录.*冲突/);
});

test('游戏连接 / RCON / 控制台端口与 local 冲突时拒绝', () => {
  const base = os.tmpdir();
  assert.throws(() => assertTestIsolation(testLayout(base, { mcPort: 25565 }), [localLayout(base)], { worldIdExplicit: true }), /游戏连接地址.*冲突/);
  assert.throws(() => assertTestIsolation(testLayout(base, { rconPort: 25575 }), [localLayout(base)], { worldIdExplicit: true }), /RCON 地址.*冲突/);
  assert.throws(() => assertTestIsolation(testLayout(base, { dashboardPort: 3001 }), [localLayout(base)], { worldIdExplicit: true }), /控制台端口.*冲突/);
});

test('OBSERVER_HUD_CONFIG 与 local 相同（同一个文件）时拒绝', () => {
  const base = os.tmpdir();
  const local = localLayout(base);
  assert.throws(() => assertTestIsolation(testLayout(base, { observerHudConfig: local.observerHudConfig }), [local], { worldIdExplicit: true }), /OBSERVER_HUD_CONFIG/);
});

test('peerLayouts 合并公共 .env 与模式文件，同时保留默认入口与模式文件', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-iso-'));
  fs.writeFileSync(path.join(root, '.env'), 'SERVER_DIR=./world\nMC_PORT=25565\nMEMORY_WORLD_ID=127.0.0.1:25565\n');
  fs.writeFileSync(path.join(root, '.env.local'), 'DATA_DIR=./data/local\nMEMORY_WORLD_ID=curio-local\nDASHBOARD_PORT=3001\n');
  const peers = peerLayouts(root, 'test');
  // 默认入口（仅公共 .env）与 .env.local 是两套独立布局，都要保留，不能按模式名去重覆盖。
  assert.equal(peers.length, 2);
  const defaultLocal = peers.find((p) => p.mode === 'local' && p.worldId === '127.0.0.1:25565')!;
  assert.equal(defaultLocal.dataDir, path.join(root, 'data', 'local'));
  assert.equal(defaultLocal.serverDir, path.join(root, 'world'));
  const localFile = peers.find((p) => p.mode === 'local' && p.worldId === 'curio-local')!;
  assert.equal(localFile.serverDir, path.join(root, 'world'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('peerLayouts 把仅由公共 .env 构成的默认 local 纳入比较（缺 .env.local 不跳过）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-iso-'));
  fs.writeFileSync(path.join(root, '.env'), 'SERVER_DIR=./world\nDATA_DIR=./data/local\nMC_PORT=25565\nRCON_PORT=25575\n');
  // 没有 .env.local：默认运行环境仍存在。
  const peers = peerLayouts(root, 'test');
  assert.equal(peers.length, 1);
  assert.equal(peers[0].mode, 'local');
  assert.equal(peers[0].dataDir, path.join(root, 'data', 'local'));
  assert.equal(peers[0].serverDir, path.join(root, 'world'));
  assert.equal(peers[0].mcPort, 25565);
  fs.rmSync(root, { recursive: true, force: true });
});

test('test 沿用公共 .env 的 local 目录时，与默认 local peer 冲突被拒绝', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-iso-'));
  fs.writeFileSync(path.join(root, '.env'), 'SERVER_DIR=./world\nDATA_DIR=./data/local\nMC_PORT=25565\nRCON_PORT=25575\nMEMORY_WORLD_ID=curio-local\n');
  const peers = peerLayouts(root, 'test');
  // test 只显式指定世界身份，其它沿用公共 .env 的 local 配置。
  const test = resolveLayout('test', { MEMORY_WORLD_ID: 'curio-test-01' }, root);
  assert.throws(() => assertTestIsolation(test, peers, { worldIdExplicit: true }), /可写目录.*冲突/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('resolveLayout 对显式相对路径也以 baseDir 为锚点，与调用进程的工作目录无关', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-iso-'));
  const l = resolveLayout('test', {
    DATA_DIR: './data/test', SERVER_DIR: './world-test', AGENTS_DIR: './agents/test',
    SPATIAL_DB_PATH: './data/test/spatial/spatial.sqlite',
  }, base);
  assert.equal(l.dataDir, path.join(base, 'data', 'test'));
  assert.equal(l.serverDir, path.join(base, 'world-test'));
  assert.equal(l.agentsDir, path.join(base, 'agents', 'test'));
  assert.equal(l.spatialDbPath, path.join(base, 'data', 'test', 'spatial', 'spatial.sqlite'));
  fs.rmSync(base, { recursive: true, force: true });
});

test('默认 local 与 .env.local 同名时都参与比较，test 沿用默认 local 目录被拒绝', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-iso-'));
  fs.writeFileSync(path.join(root, '.env'), 'SERVER_DIR=./world\nDATA_DIR=./data/local\nMC_PORT=25565\nRCON_PORT=25575\n');
  fs.writeFileSync(path.join(root, '.env.local'), 'SERVER_DIR=./world-local\n');
  const peers = peerLayouts(root, 'test');
  assert.equal(peers.length, 2); // 默认 local + .env.local 两套布局都保留
  // test 显式指定世界身份，SERVER_DIR 沿用公共 .env 的 world（与默认 local 相同），必须被拒绝。
  const test = resolveLayout('test', { MEMORY_WORLD_ID: 'curio-test-01', SERVER_DIR: './world', DATA_DIR: './data/test', MC_PORT: '25566', RCON_PORT: '25576' }, root);
  assert.throws(() => assertTestIsolation(test, peers, { worldIdExplicit: true }), /可写目录.*冲突/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('localhost 与 127.0.0.1 视为同一回环地址，游戏与 RCON 端口冲突都被拒绝', () => {
  const base = os.tmpdir();
  const local = localLayout(base, { mcHost: 'localhost' });
  assert.throws(() => assertTestIsolation(testLayout(base, { mcPort: 25565 }), [local], { worldIdExplicit: true }), /游戏连接地址.*冲突/);
  const localRcon = localLayout(base, { rconHost: 'localhost' });
  assert.throws(() => assertTestIsolation(testLayout(base, { rconPort: 25575 }), [localRcon], { worldIdExplicit: true }), /RCON 地址.*冲突/);
});

test('IPv6 回环 ::1 与 localhost / 127.0.0.1 视为同一主机，游戏与 RCON 端口冲突都被拒绝', () => {
  const base = os.tmpdir();
  const local = localLayout(base, { mcHost: 'localhost' });
  assert.throws(() => assertTestIsolation(testLayout(base, { mcHost: '::1', mcPort: 25565 }), [local], { worldIdExplicit: true }), /游戏连接地址.*冲突/);
  const localRcon = localLayout(base, { rconHost: '[::1]' });
  assert.throws(() => assertTestIsolation(testLayout(base, { rconHost: '127.0.0.1', rconPort: 25575 }), [localRcon], { worldIdExplicit: true }), /RCON 地址.*冲突/);
});

test('通配地址 :: 与 ::1 / 127.0.0.1 一次性归一为同一回环，端口冲突不被漏检', () => {
  const base = os.tmpdir();
  const local = localLayout(base, { mcHost: '::' });
  assert.throws(() => assertTestIsolation(testLayout(base, { mcHost: '::1', mcPort: 25565 }), [local], { worldIdExplicit: true }), /游戏连接地址.*冲突/);
  const localV4 = localLayout(base, { rconHost: '::' });
  assert.throws(() => assertTestIsolation(testLayout(base, { rconHost: '127.0.0.1', rconPort: 25575 }), [localV4], { worldIdExplicit: true }), /RCON 地址.*冲突/);
});

test('OBSERVER_HUD_CONFIG 在 Windows 上大小写不同也视为同一文件', { skip: process.platform !== 'win32' }, () => {
  const base = os.tmpdir();
  const local = localLayout(base);
  const test = testLayout(base, { observerHudConfig: local.observerHudConfig.toUpperCase() });
  assert.throws(() => assertTestIsolation(test, [local], { worldIdExplicit: true }), /OBSERVER_HUD_CONFIG/);
});

test('assertTestIsolation 强制所有可写目录落在指定根目录内', () => {
  const base = os.tmpdir();
  const root = path.join(base, 'test-setver');
  const inside = testLayout(base, {
    serverDir: root,
    dataDir: path.join(root, 'curio-data'),
    agentsDir: path.join(root, 'curio-data', 'agents'),
    llmArchiveDir: path.join(root, 'curio-data', 'archives', 'llm-calls'),
    observerHudConfig: path.join(root, 'observer-hud.test.json'),
    spatialDbPath: path.join(root, 'curio-data', 'spatial', 'spatial.sqlite'),
  });
  assert.doesNotThrow(() => assertTestIsolation(inside, [localLayout(base)], { worldIdExplicit: true, rootDir: root }));
  const outside = testLayout(base, { dataDir: path.join(base, 'elsewhere') });
  assert.throws(() => assertTestIsolation(outside, [localLayout(base)], { worldIdExplicit: true, rootDir: root }), /指定根目录/);
});
