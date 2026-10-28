import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

let imports = 0;
const loadConfig = () => import(new URL(`../src/config.ts?env-file-test=${++imports}`, import.meta.url).href) as Promise<typeof import('../src/config.ts')>;

function project(t: TestContext) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'curio-env-file-')));
  const cwd = process.cwd();
  const env = { ...process.env };
  const args = [...process.execArgv];
  t.after(() => {
    process.chdir(cwd);
    Object.keys(process.env).forEach((key) => { delete process.env[key]; });
    Object.assign(process.env, env);
    process.execArgv.splice(0, process.execArgv.length, ...args);
    fs.rmSync(root, { recursive: true, force: true });
  });
  process.chdir(root);
  Object.keys(process.env).forEach((key) => { delete process.env[key]; });
  process.execArgv.splice(0);
  return root;
}

test('所选本地配置不混入默认 .env 的模型、服务和数据目录', async (t) => {
  const root = project(t);
  fs.writeFileSync(path.join(root, '.env'), 'LLM_MODEL=base-model\nHINDSIGHT_URL=http://base-host:8888\nDATA_DIR=./base-data\n');
  fs.writeFileSync(path.join(root, '.env.local'), 'MC_HOST=127.0.0.1\nDATA_DIR=./data/local\n');
  process.env.ENV_FILE = '.env.local';
  const { config, envFile, requireLocalMode } = await loadConfig();
  assert.equal(envFile, path.join(root, '.env.local'));
  assert.equal(config.mode, 'local');
  assert.equal(config.dataDir, path.join(root, 'data', 'local'));
  assert.equal(config.memory.baseUrl, 'http://127.0.0.1:8888');
  assert.equal(process.env.LLM_MODEL, undefined);
  assert.doesNotThrow(() => requireLocalMode('存读档'));
});

test('Node --env-file 选中的直播文件保持直播模式，拒绝本地管理', async (t) => {
  const root = project(t);
  fs.writeFileSync(path.join(root, '.env.live'), 'CURIO_MODE=local\nMC_HOST=192.168.1.50\nDATA_DIR=./data/live\n');
  process.env.ENV_FILE = '.env.other';
  process.execArgv.push('--env-file=.env.live');
  const { config, envFile, requireLocalMode } = await loadConfig();
  assert.equal(envFile, path.join(root, '.env.live'));
  assert.equal(config.mode, 'live');
  assert.equal(config.mc.host, '192.168.1.50');
  assert.equal(config.dataDir, path.join(root, 'data', 'live'));
  assert.throws(() => requireLocalMode('存读档'), /直播配置.*存读档.*本地配置/);
});

test('显式配置缺失或模式无效时报错，默认无 .env 仍可本地启动', async (t) => {
  const root = project(t);
  process.env.ENV_FILE = '.env.missing';
  await assert.rejects(loadConfig(), /找不到配置文件/);
  process.env.ENV_FILE = '.env.custom';
  fs.writeFileSync(path.join(root, '.env.custom'), 'CURIO_MODE=unknown\n');
  await assert.rejects(loadConfig(), /CURIO_MODE/);
  delete process.env.ENV_FILE;
  delete process.env.CURIO_MODE;
  const { config } = await loadConfig();
  assert.equal(config.mode, 'local');
  assert.equal(config.mc.host, '127.0.0.1');
});
