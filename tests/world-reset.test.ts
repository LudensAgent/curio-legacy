import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { inspectWorldReset, resetWorld } from '../src/maintenance/world-reset.ts';

function fixture(t: { after: (fn: () => void) => void }, properties = 'level-name=world\nlevel-seed=12345\nserver-port=25565\nserver-ip=\n') {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-world-reset-'));
  const server = path.join(project, 'world');
  fs.mkdirSync(server);
  fs.writeFileSync(path.join(server, 'server.properties'), properties);
  fs.writeFileSync(path.join(server, 'eula.txt'), '# Agreed\r\neula=true\r\n');
  t.after(() => fs.rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const write = (relative: string, content = 'old runtime data') => {
    const target = path.join(server, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    return target;
  };
  return { project, server, write };
}

test('预览只读：列出将删除和保留的顶层项，解析服务器监听信息', (t) => {
  const { project, server, write } = fixture(t);
  write('world/level.dat');
  write('world/region/r.0.0.mca');
  write('mods/example.jar');
  write('config/replay-server.json');
  write('recordings/old.mcpr');
  const before = fs.readFileSync(path.join(server, 'server.properties'));
  const plan = inspectWorldReset(server, project);

  assert.equal(plan.directory, fs.realpathSync(server));
  assert.equal(plan.levelName, 'world');
  assert.equal(plan.serverHost, '127.0.0.1');
  assert.equal(plan.serverPort, 25565);
  assert.equal(plan.seedCleared, true);
  assert.deepEqual(plan.removed, ['recordings', 'world']);
  assert.deepEqual(plan.retained, ['config', 'eula.txt', 'mods', 'server.properties']);
  assert.ok(fs.readFileSync(path.join(server, 'server.properties')).equals(before));
  assert.ok(fs.existsSync(path.join(server, 'world', 'level.dat')));
});

test('完整重置保留配置、eula、模组及启动依赖，所有世界/玩家/录像/日志与缓存删除', (t) => {
  const { project, server, write } = fixture(t);
  const preserved = [
    'config/replay-server.json', 'configs/mod.toml', 'defaultconfigs/mod.toml', 'mods/example.jar',
    'plugins/example.jar', 'libraries/net/minecraft/server.jar', 'versions/1.20.1/server.jar',
    '.fabric/remappedJars/server.jar', 'fabric-server.jar', 'run.bat', 'start.cmd', 'start.ps1', 'run.sh',
    'ops.json', 'banned-ips.json', 'banned-players.json', 'whitelist.json', 'permissions.json',
    'user_jvm_args.txt', 'extra.properties', 'spigot.yml', 'custom.toml', '.env', 'log4j2.xml',
  ];
  for (const name of preserved) write(name, `keep:${name}`);
  const removed = [
    'world/level.dat', 'world/level.dat_old', 'world/region/r.0.0.mca', 'world/playerdata/player.dat',
    'world/DIM-1/data/map.dat', 'world/DIM1/region/r.0.0.mca', 'world_nether/level.dat', 'world_the_end/level.dat',
    'logs/latest.log', 'recordings/session.mcpr', 'cache/data.bin', 'crash-reports/crash.txt',
    'usercache.json', 'session.lock', 'unrecognized-runtime.json', 'server.jar.backup',
  ];
  for (const name of removed) write(name);
  const eula = fs.readFileSync(path.join(server, 'eula.txt'));
  const result = resetWorld(server, project);

  assert.ok(fs.existsSync(server), '服务器根保留，可作为 Windows 进程工作目录');
  for (const name of preserved) assert.equal(fs.readFileSync(path.join(server, name), 'utf8'), `keep:${name}`, name);
  for (const name of removed) assert.equal(fs.existsSync(path.join(server, name)), false, name);
  assert.ok(fs.readFileSync(path.join(server, 'eula.txt')).equals(eula));
  assert.equal(fs.readFileSync(path.join(server, 'server.properties'), 'utf8'), 'level-name=world\nserver-port=25565\nserver-ip=\n');
  assert.ok(result.removed.includes('world'));
  assert.ok(result.removed.includes('usercache.json'));
});

test('Java Properties 种子键使用冒号、空白、Unicode 转义、续行及重复定义时全部清除', (t) => {
  const original = Buffer.concat([
    Buffer.from('# level-seed=comment stays\r\n! another comment\\\nlevel-seeds=not-the-seed\r\n', 'utf8'),
    Buffer.from([0x23, 0xff, 0xfe, 0x0a]),
    Buffer.from([
      'level-seed=123\r\n',
      '  level-seed : 456\n',
      '\tlevel-seed\t789\r',
      String.raw`\u006cevel\u002dseed=999` + '\r\n',
      'level-\\\r\n \tseed : first\\\n    second\r\n',
      'level-seed\r\n',
      'level-name=world\r\n',
      'motd=你好，保留原字节\\nhello\r\n',
      'generator-settings={}\n',
      'other-seed=unchanged',
    ].join(''), 'utf8'),
  ]);
  const { project, server, write } = fixture(t);
  fs.writeFileSync(path.join(server, 'server.properties'), original);
  write('world/level.dat');
  resetWorld(server, project);
  const expected = Buffer.concat([
    Buffer.from('# level-seed=comment stays\r\n! another comment\\\nlevel-seeds=not-the-seed\r\n'),
    Buffer.from([0x23, 0xff, 0xfe, 0x0a]),
    Buffer.from('level-name=world\r\nmotd=你好，保留原字节\\nhello\r\ngenerator-settings={}\nother-seed=unchanged'),
  ]);
  assert.ok(fs.readFileSync(path.join(server, 'server.properties')).equals(expected), '非种子配置、注释及混合换行逐字节不变');
  assert.equal(fs.existsSync(path.join(server, 'world')), false, 'level.dat 与种子必须一起移除');
});

test('无种子时同样删除旧存档，重复执行安全且默认新世界随机生成', (t) => {
  const { project, server, write } = fixture(t, 'motd=keep\n');
  write('world/level.dat', 'old-seed-is-in-level.dat');
  const first = resetWorld(server, project);
  assert.equal(first.levelName, 'world');
  assert.equal(first.seedCleared, false);
  assert.equal(fs.existsSync(path.join(server, 'world')), false);
  const second = resetWorld(server, project);
  assert.deepEqual(second.removed, []);
  assert.equal(fs.readFileSync(path.join(server, 'server.properties'), 'utf8'), 'motd=keep\n');
});

test('自定义及转义中文世界名称正确解析，整个旧存档删除且其他配置保留', (t) => {
  const { project, server, write } = fixture(t, [
    'level-name=ignored-first-name\n',
    String.raw`level\u002dname: saves/\u4e16\u754c\ 2` + '\n',
    'level-seed=old\n',
    'server-port : 25566\n',
    'server-ip = ::\n',
  ].join(''));
  write('saves/世界 2/level.dat');
  write('saves/世界 2/playerdata/player.dat');
  write('config/keep.json');
  const plan = resetWorld(server, project);
  assert.equal(plan.levelName, 'saves/世界 2');
  assert.equal(plan.serverPort, 25566);
  assert.equal(plan.serverHost, '::1');
  assert.equal(fs.existsSync(path.join(server, 'saves')), false);
  assert.ok(fs.existsSync(path.join(server, 'config', 'keep.json')));
});

test('危险 level-name 在任何数据或种子修改前拒绝，包括保留树和 Java 转义路径', (t) => {
  const { project, server, write } = fixture(t);
  write('world/level.dat');
  write('mods/keep.jar');
  write('config/keep.json');
  write('libraries/server.jar');
  write('start.jar');
  const invalid = [
    '../elsewhere', 'world/../../elsewhere', '.', '', '/outside', String.raw`C\:\\outside`,
    'mods', 'mods/saved-world', 'MODS/saved-world', 'config', 'config/saved-world',
    'server.properties', 'libraries/saved-world', 'start.jar/child',
    String.raw`\u002e\u002e/outside`, String.raw`\u006dod\u0073/world`,
    'world./child', 'world /child', 'CON/child', 'world//child',
  ];
  for (const name of invalid) {
    const before = Buffer.from(`level-name=${name}\nlevel-seed=keep\n`);
    fs.writeFileSync(path.join(server, 'server.properties'), before);
    assert.throws(() => resetWorld(server, project), /level-name/, name);
    assert.ok(fs.readFileSync(path.join(server, 'server.properties')).equals(before), name);
    assert.ok(fs.existsSync(path.join(server, 'world', 'level.dat')), name);
  }
});

test('拒绝项目根、项目外、源码树、存档根与缺少服务器标记的目录', (t) => {
  const { project, server, write } = fixture(t);
  write('world/level.dat');
  for (const directory of [project, path.dirname(project), path.parse(project).root, os.homedir()]) {
    assert.throws(() => resetWorld(directory, project), /拒绝清理|不能位于/);
  }
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-world-reset-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'server.properties'), 'level-name=world');
  fs.writeFileSync(path.join(outside, 'eula.txt'), 'eula=true');
  assert.throws(() => resetWorld(outside, project), /项目之外/);
  for (const folder of ['src', 'scripts', 'tests', 'public', 'docs', 'node_modules', '.git', 'data']) {
    const directory = path.join(project, folder);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'server.properties'), 'level-name=world');
    fs.writeFileSync(path.join(directory, 'eula.txt'), 'eula=true');
    assert.throws(() => resetWorld(directory, project), /不能位于/, folder);
  }
  assert.throws(() => resetWorld(path.join(server, 'world'), project), /不是独立.*服务器根/);
  const incomplete = path.join(project, 'incomplete-server');
  fs.mkdirSync(incomplete);
  fs.writeFileSync(path.join(incomplete, 'server.properties'), 'level-name=world');
  assert.throws(() => resetWorld(incomplete, project), /eula.txt/);
  assert.ok(fs.existsSync(path.join(server, 'world', 'level.dat')));
});

test('服务器目录或配置文件为符号链接/junction 时拒绝；中间链接同样拒绝', (t) => {
  const { project, server } = fixture(t);
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  const rootLink = path.join(project, 'linked-server');
  fs.symlinkSync(server, rootLink, linkType);
  assert.throws(() => resetWorld(rootLink, project), /符号链接|junction/);
  const parent = path.join(project, 'servers');
  fs.mkdirSync(parent);
  const nested = path.join(parent, 'server');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, 'server.properties'), 'level-name=world\n');
  fs.writeFileSync(path.join(nested, 'eula.txt'), 'eula=true\n');
  const parentLink = path.join(project, 'linked-parent');
  fs.symlinkSync(parent, parentLink, linkType);
  assert.throws(() => resetWorld(path.join(parentLink, 'server'), project), /符号链接|junction/);

  // 目录形式的链接不需要 Windows 创建文件 symlink 的额外权限。
  fs.rmSync(path.join(nested, 'eula.txt'));
  fs.symlinkSync(server, path.join(nested, 'eula.txt'), linkType);
  assert.throws(() => resetWorld(nested, project), /真实配置文件 eula.txt/);
  assert.ok(fs.existsSync(path.join(server, 'server.properties')));
});

test('待删目录内 junction 只移除链接，不访问或删除外部目标', (t) => {
  const { project, server, write } = fixture(t);
  const outside = path.join(project, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep outside');
  write('world/level.dat');
  write('logs/latest.log');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(outside, path.join(server, 'recordings'), linkType);
  fs.symlinkSync(outside, path.join(server, 'logs', 'external-link'), linkType);

  resetWorld(server, project);
  assert.equal(fs.existsSync(path.join(server, 'recordings')), false);
  assert.equal(fs.existsSync(path.join(server, 'logs')), false);
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep outside');
});

test('配置世界本身或父目录指向链接时先拒绝，外部旧世界与本地数据均保留', (t) => {
  const { project, server, write } = fixture(t);
  const outside = path.join(project, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'level.dat'), 'keep outside');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  write('logs/latest.log');
  const linkedWorld = path.join(server, 'world');
  fs.symlinkSync(outside, linkedWorld, linkType);
  try {
    const before = fs.readFileSync(path.join(server, 'server.properties'));
    assert.throws(() => resetWorld(server, project), /level-name 不能经过/);
    assert.ok(fs.readFileSync(path.join(server, 'server.properties')).equals(before));
    assert.ok(fs.existsSync(path.join(server, 'logs', 'latest.log')));
    assert.equal(fs.readFileSync(path.join(outside, 'level.dat'), 'utf8'), 'keep outside');
  } finally {
    // Windows rmSync 在同时遍历目标和指向目标的 junction 时可能受删除顺序影响。
    fs.rmSync(linkedWorld, { force: true });
  }
});

test('非法 Properties 或监听配置拒绝重置，避免错误解析种子或漏检活跃服务器', (t) => {
  const { project, server, write } = fixture(t);
  write('world/level.dat');
  const invalid = [
    String.raw`level-name=world
level-seed=\u00xx`,
    'server-port=bad\n', 'server-port=0\n', 'server-port=65536\n', 'server-ip=localhost other\n',
  ];
  for (const content of invalid) {
    fs.writeFileSync(path.join(server, 'server.properties'), content);
    assert.throws(() => resetWorld(server, project), /Unicode|server-port|server-ip/);
    assert.equal(fs.readFileSync(path.join(server, 'server.properties'), 'utf8'), content);
    assert.ok(fs.existsSync(path.join(server, 'world', 'level.dat')));
  }
});

test('服务器根作为当前工作目录时仍能清理，避免 Windows 删除目录根的 EPERM', (t) => {
  const { project, server, write } = fixture(t);
  write('world/level.dat');
  const cwd = process.cwd();
  try {
    process.chdir(server);
    resetWorld(server, project);
    assert.equal(process.cwd(), server);
    assert.equal(fs.existsSync(path.join(server, 'world')), false);
    assert.ok(fs.existsSync(path.join(server, 'eula.txt')));
  } finally {
    process.chdir(cwd);
  }
});
