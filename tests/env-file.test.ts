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

test('模式文件在公共 .env 之上覆盖，公共值仍然生效', async (t) => {
  const root = project(t);
  fs.writeFileSync(path.join(root, '.env'), 'LLM_MODEL=base-model\nHINDSIGHT_URL=http://base-host:8888\nDATA_DIR=./base-data\nMC_HOST=192.168.1.50\n');
  fs.writeFileSync(path.join(root, '.env.local'), 'MC_HOST=127.0.0.1\nDATA_DIR=./data/local\n');
  process.env.ENV_FILE = '.env.local';
  const { config, envFile, requireLocalMode } = await loadConfig();
  assert.equal(envFile, path.join(root, '.env.local'));
  assert.equal(config.mode, 'local');
  assert.equal(config.dataDir, path.join(root, 'data', 'local'));      // 模式文件覆盖公共
  assert.equal(config.mc.host, '127.0.0.1');                            // 模式文件覆盖公共
  assert.equal(config.llm.model, 'base-model');                         // 公共值仍然生效
  assert.equal(config.memory.baseUrl, 'http://base-host:8888');         // 公共值仍然生效
  assert.equal(process.env.LLM_MODEL, 'base-model');                    // 公共配置已合并进进程
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
  assert.equal(config.dataDir, path.join(root, 'data', 'local'));
  assert.equal(config.dashboard.port, 3001);
});

test('界面默认只在窗口边界短暂停留，显式等待值仍然生效', async (t) => {
  project(t);
  const defaults = await loadConfig();
  assert.deepEqual(defaults.config.ui, { pacingMs: 150, openHoldMs: 250, closeHoldMs: 450 });
  process.env.UI_PACING_MS = '250';
  process.env.UI_OPEN_HOLD_MS = '600';
  process.env.UI_CLOSE_HOLD_MS = '800';
  const overridden = await loadConfig();
  assert.deepEqual(overridden.config.ui, { pacingMs: 250, openHoldMs: 600, closeHoldMs: 800 });
});

test('未填写目录时按模式读取独立角色与记忆身份，直播文件名保持直播默认值', async (t) => {
  const root = project(t);
  for (const mode of ['local', 'live']) {
    const directory = path.join(root, 'data', mode);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'agent.json'), JSON.stringify({
      worldId: 'saved-world', botUsername: 'TestBot', bankId: `mc-${(mode === 'local' ? 'a' : 'b').repeat(32)}`,
    }));
    fs.writeFileSync(path.join(root, `.env.${mode}`), 'CURIO_MODE=local\nMEMORY_WORLD_ID=saved-world\nBOT_USERNAME=TestBot\n');
    process.env.ENV_FILE = `.env.${mode}`;
    const { config } = await loadConfig();
    assert.equal(config.mode, mode);
    assert.equal(config.dataDir, directory);
    assert.equal(config.memory.bankId, `mc-${(mode === 'local' ? 'a' : 'b').repeat(32)}`);
    assert.equal(config.dashboard.port, mode === 'local' ? 3001 : 3000);
    assert.equal(config.llmArchiveDir, path.join(root, 'archives', mode, 'llm-calls'));
    assert.equal(config.observerHudConfig, path.join(root, 'live', mode === 'live' ? 'observer-hud.json' : 'observer-hud.local.json'));
  }
});
