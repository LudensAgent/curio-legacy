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
    danmakuArchiveDir: d('curio/archives/test/danmaku'),
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
    danmakuArchiveDir: d('curio/archives/local/danmaku'),
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

test('peerLayouts 合并公共 .env 与模式文件，缺少的 peer 跳过', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-iso-'));
  fs.writeFileSync(path.join(root, '.env'), 'SERVER_DIR=./world\nMC_PORT=25565\nMEMORY_WORLD_ID=127.0.0.1:25565\n');
  fs.writeFileSync(path.join(root, '.env.local'), 'DATA_DIR=./data/local\nMEMORY_WORLD_ID=curio-local\nDASHBOARD_PORT=3001\n');
  fs.writeFileSync(path.join(root, '.env.live'), 'DATA_DIR=./data/live\nMC_HOST=192.168.1.50\nDASHBOARD_PORT=3000\n');
  const peers = peerLayouts(root, '', 'test');
  assert.equal(peers.length, 2);
  const local = peers.find((p) => p.mode === 'local')!;
  assert.equal(local.dataDir, path.join(root, 'data', 'local'));
  assert.equal(local.serverDir, path.join(root, 'world'));
  assert.equal(local.worldId, 'curio-local');
  const live = peers.find((p) => p.mode === 'live')!;
  assert.equal(live.mcHost, '192.168.1.50');
  assert.equal(live.worldId, '127.0.0.1:25565'); // 继承公共 .env
  fs.rmSync(root, { recursive: true, force: true });
});
