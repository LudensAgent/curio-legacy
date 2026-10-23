import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { clearMemory } from '../src/memory/clear.ts';

function fixture(t: { after: (fn: () => void) => void }) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-clear-memory-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  return project;
}

test('完全清空：记忆、技能、日志、所有备份和诊断均删除，配置与游戏存档保留', (t) => {
  const project = fixture(t);
  const data = path.join(project, 'data');
  for (const file of ['world-memory.json', 'world-memory.json.tmp', 'world-memory.json.corrupt-123', 'skill-library.json', 'logs/events-20261023.jsonl', 'logs/llm-20261023.jsonl', 'vision-check/frame.json', 'old-history/nested/backup.json']) {
    const dest = path.join(data, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, 'old history');
  }
  fs.writeFileSync(path.join(project, '.env'), 'DATA_DIR=./data');
  fs.mkdirSync(path.join(project, 'world'));
  fs.writeFileSync(path.join(project, 'world', 'level.dat'), 'game world');

  assert.equal(clearMemory(data, project).cleared, true);
  assert.deepEqual(fs.readdirSync(data), [], '保留 DATA_DIR 根以兼容 Windows 目录占用');
  assert.equal(fs.readFileSync(path.join(project, '.env'), 'utf8'), 'DATA_DIR=./data');
  assert.equal(fs.readFileSync(path.join(project, 'world', 'level.dat'), 'utf8'), 'game world');
  assert.equal(clearMemory(data, project).cleared, false, '重复执行空目录无需删除根目录');
});

test('不存在的数据目录不会创建，已有空目录保留且不报告删除', (t) => {
  const project = fixture(t);
  const data = path.join(project, 'data');
  assert.equal(clearMemory(data, project).cleared, false);
  assert.equal(fs.existsSync(data), false);
  fs.mkdirSync(data);
  assert.equal(clearMemory(data, project).cleared, false);
  assert.deepEqual(fs.readdirSync(data), []);
});

test('根目录占用不会触发删除根，每个子项配置重试并强制删除', (t) => {
  const project = fixture(t);
  const data = path.join(project, 'data');
  fs.mkdirSync(path.join(data, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(data, 'logs', 'history.jsonl'), 'history');
  fs.writeFileSync(path.join(data, 'memory.json'), '{}');
  const originalRm = fs.rmSync;
  const targets: string[] = [];
  const mock = t.mock.method(fs, 'rmSync', (target, options) => {
    const resolved = path.resolve(String(target));
    assert.notEqual(resolved, data, '绝不删除可能被占用的 DATA_DIR 根');
    assert.equal(path.dirname(resolved), data, '删除目标只能是 DATA_DIR 的子项');
    assert.deepEqual(options, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    targets.push(resolved);
    originalRm(target, options);
  });
  try {
    assert.equal(clearMemory(data, project).cleared, true);
    assert.equal(targets.length, 2);
    assert.deepEqual(fs.readdirSync(data), []);
  } finally {
    mock.mock.restore();
  }
});

test('持续占用或权限错误准确报错并提示退出 Agent，不报告成功', (t) => {
  const project = fixture(t);
  const data = path.join(project, 'data');
  fs.mkdirSync(data);
  const file = path.join(data, 'memory.json');
  fs.writeFileSync(file, '{}');
  for (const code of ['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']) {
    const blocked = Object.assign(new Error('blocked'), { code });
    const mock = t.mock.method(fs, 'rmSync', () => { throw blocked; });
    try {
      assert.throws(() => clearMemory(data, project), (error: any) => {
        assert.equal(error.cause, blocked);
        assert.match(error.message, new RegExp(code));
        assert.match(error.message, /退出 Agent/);
        return true;
      });
      assert.equal(fs.readFileSync(file, 'utf8'), '{}');
    } finally {
      mock.mock.restore();
    }
  }
});

test('清空过程中仍有程序写入时失败，避免留下历史却报告成功', (t) => {
  const project = fixture(t);
  const data = path.join(project, 'data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'old.json'), '{}');
  const originalRm = fs.rmSync;
  const mock = t.mock.method(fs, 'rmSync', (target, options) => {
    originalRm(target, options);
    fs.writeFileSync(path.join(data, 'new.json'), 'concurrent write');
  });
  try {
    assert.throws(() => clearMemory(data, project), /仍有文件.*退出 Agent/);
    assert.equal(fs.readFileSync(path.join(data, 'new.json'), 'utf8'), 'concurrent write');
  } finally {
    mock.mock.restore();
  }
});

test('危险路径、文件及其他项目/游戏目录拒绝清空', (t) => {
  const project = fixture(t);
  for (const name of ['src', 'scripts', 'tests', 'public', 'docs', 'node_modules', '.git', 'world']) {
    const dir = path.join(project, name, 'nested');
    fs.mkdirSync(dir, { recursive: true });
    assert.throws(() => clearMemory(dir, project), /拒绝清空|不能位于/);
    assert.ok(fs.existsSync(dir));
  }
  for (const dir of [project, path.dirname(project), path.parse(project).root, os.homedir()]) {
    assert.throws(() => clearMemory(dir, project), /拒绝清空/);
  }
  const file = path.join(project, 'not-a-directory');
  fs.writeFileSync(file, 'keep');
  assert.throws(() => clearMemory(file, project), /不是目录/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep');
  for (const marker of ['.git', 'package.json', 'server.properties', 'level.dat']) {
    const dir = fs.mkdtempSync(path.join(project, 'other-'));
    fs.writeFileSync(path.join(dir, marker), 'keep');
    assert.throws(() => clearMemory(dir, project), /拒绝清空/);
    assert.equal(fs.readFileSync(path.join(dir, marker), 'utf8'), 'keep');
  }
});

test('链接保护：DATA_DIR 链接拒绝清空，目录内链接不会删除外部内容', (t) => {
  const project = fixture(t);
  const outside = path.join(project, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  const link = path.join(project, 'linked-data');
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => clearMemory(link, project), /符号链接|junction/);

  const data = path.join(project, 'data');
  fs.mkdirSync(data);
  fs.symlinkSync(outside, path.join(data, 'logs'), process.platform === 'win32' ? 'junction' : 'dir');
  clearMemory(data, project);
  assert.deepEqual(fs.readdirSync(data), []);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
});

test('CLI 从 .env 读取自定义 DATA_DIR，清空可重复执行且危险路径返回失败', async (t) => {
  const project = fixture(t);
  const data = path.join(project, 'custom-memory');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'world-memory.json'), '{}');
  fs.writeFileSync(path.join(project, '.env'), 'DATA_DIR=./custom-memory\n');
  const env = { ...process.env };
  delete env.DATA_DIR;
  const unusedPort = net.createServer();
  await new Promise<void>((resolve) => unusedPort.listen(0, '127.0.0.1', resolve));
  env.DASHBOARD_PORT = String((unusedPort.address() as net.AddressInfo).port);
  env.DASHBOARD_HOST = '127.0.0.1';
  await new Promise<void>((resolve, reject) => unusedPort.close((error) => error ? reject(error) : resolve()));
  env.MEMORY_PROVIDER = 'local';
  const script = fileURLToPath(new URL('../scripts/clear-memory.ts', import.meta.url));
  const run = () => spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), script], { cwd: project, env, encoding: 'utf8' });

  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /已完全清空/);
  assert.deepEqual(fs.readdirSync(data), []);
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /已为空/);

  fs.writeFileSync(path.join(project, '.env'), `DATA_DIR=${fileURLToPath(new URL('../', import.meta.url)).replaceAll('\\', '/')}\n`);
  const rejected = run();
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /拒绝清空/);
});
