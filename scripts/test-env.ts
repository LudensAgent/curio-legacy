/**
 * test 环境入口（宿主运行环境，不等于单元测试进程）。
 *
 *   npm run test:config                    只读展示最终解析出的配置；不连接游戏、不启动服务器、不建库。
 *   npm run test:init -- --seed <服务器目录>  首次创建独立目录并复制世界种子；不覆盖已有测试状态。
 *   npm run test:start                     走 scripts/supervise.mjs 的 Curio 实际启动入口。
 *
 * test 使用独立连接配置、世界副本与运行数据；冲突或缺少必要配置时在 config 加载阶段即失败，
 * 不会回退到 local/live 的地址、数据库或数据目录。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertResetOffline } from '../src/maintenance/offline.ts';

type ConfigModule = typeof import('../src/config.ts');

async function loadConfig(): Promise<ConfigModule> {
  const mod = await import('../src/config.ts');
  return mod;
}

function argvFlag(name: string): string | undefined {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) return argv[i + 1];
    if (argv[i]!.startsWith(`${name}=`)) return argv[i]!.slice(name.length + 1);
  }
  return undefined;
}

export function readServerProperty(file: string, key: string): string | undefined {
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    if (t.slice(0, eq).trim() === key) return t.slice(eq + 1).trim();
  }
  return undefined;
}

export function setServerProperty(file: string, key: string, value: string): void {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  let found = false;
  const out = lines.map((line) => {
    const t = line.trim();
    if (t && !t.startsWith('#') && t.indexOf('=') >= 0 && t.slice(0, t.indexOf('=')).trim() === key) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) out.push(`${key}=${value}`);
  fs.writeFileSync(file, out.join('\n'));
}

/** 目录里是否存在任何世界（任意子目录含 level.dat）。空目录、只有 server.properties 不算已初始化。 */
export function hasWorldData(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  return fs.readdirSync(dir, { withFileTypes: true })
    .some((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'level.dat')));
}

/** 目标自身已有测试状态时的标记列表；空数组 = 尚未初始化。只读，不写盘。 */
export function existingTestState(config: { dataDir: string; spatialDbPath: string }, targetServerDir: string): string[] {
  const markers: string[] = [];
  if (fs.existsSync(path.join(config.dataDir, 'init.json'))) markers.push('初始化标记 init.json');
  if (fs.existsSync(path.join(config.dataDir, 'world-memory.json'))) markers.push('情境记忆 world-memory.json');
  if (fs.existsSync(config.spatialDbPath)) markers.push(`空间数据库 ${config.spatialDbPath}`);
  const targetProps = path.join(targetServerDir, 'server.properties');
  const targetLevelName = fs.existsSync(targetProps) ? (readServerProperty(targetProps, 'level-name') ?? 'world') : null;
  if (targetLevelName && fs.existsSync(path.join(targetServerDir, targetLevelName, 'level.dat'))) markers.push(`世界 ${targetLevelName}/level.dat`);
  else if (!targetLevelName && hasWorldData(targetServerDir)) markers.push('世界 level.dat');
  return markers;
}

/** 让副本的游戏与 RCON 服务配置和最终 test 配置一致；只改目标 server.properties，不改种子源，也不打印密码。 */
export function syncServerForTest(targetServerDir: string, config: { mcPort: number; rconPort: number; rconPassword: string }): void {
  const props = path.join(targetServerDir, 'server.properties');
  setServerProperty(props, 'server-port', String(config.mcPort));
  setServerProperty(props, 'enable-rcon', config.rconPassword ? 'true' : 'false');
  setServerProperty(props, 'rcon.port', String(config.rconPort));
  setServerProperty(props, 'rcon.password', config.rconPassword);
}

/** 复制服务器目录作为世界种子；跳过运行期目录、锁定文件与链接，保证可写世界是真实副本。 */
const COPY_EXCLUDE = new Set(['logs', 'recordings', '.cache', 'session.lock']);
function copySeed(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const name = entry.name;
    if (name === '.DS_Store' || name.startsWith('._') || COPY_EXCLUDE.has(name)) continue;
    if (entry.isSymbolicLink()) continue;
    const s = path.join(src, name);
    const d = path.join(dst, name);
    if (entry.isDirectory()) copySeed(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

async function showConfig(): Promise<void> {
  const { config, envFile } = await loadConfig();
  const targetServerDir = config.serverDir;
  const rows: [string, string][] = [
    ['环境名称', config.mode],
    ['配置文件', envFile],
    ['游戏连接地址', `${config.mc.host}:${config.mc.port}`],
    ['RCON 地址', `${config.observer.rconHost}:${config.observer.rconPort}`],
    ['世界目录', targetServerDir],
    ['Curio 数据目录', config.dataDir],
    ['空间数据库路径', config.spatial.databasePath],
    ['日志目录', path.join(config.dataDir, 'logs')],
    ['世界身份 (MEMORY_WORLD_ID)', config.memory.worldId],
    ['角色标识 (BOT_USERNAME)', config.mc.username],
  ];
  for (const [key, value] of rows) console.log(`${key}: ${value}`);
}

async function initTest(): Promise<void> {
  const seed = argvFlag('--seed');
  if (!seed) {
    console.error('需要显式指定世界种子：npm run test:init -- --seed <服务器目录>');
    process.exitCode = 1;
    return;
  }
  const { config } = await loadConfig();
  const seedDir = path.resolve(seed);
  const targetServerDir = config.serverDir;

  const seedProps = path.join(seedDir, 'server.properties');
  if (!fs.existsSync(seedProps)) throw new Error(`种子源不是 Minecraft 服务器目录（缺 server.properties）：${seedDir}`);
  if (path.resolve(seedDir) === path.resolve(targetServerDir)) throw new Error('种子源不能等于 test 世界目录');
  const levelName = readServerProperty(seedProps, 'level-name') ?? 'world';
  const seedWorld = path.join(seedDir, levelName);
  if (!fs.existsSync(path.join(seedWorld, 'level.dat'))) throw new Error(`种子源缺少世界 level.dat：${path.join(seedWorld, 'level.dat')}`);
  const rawPort = readServerProperty(seedProps, 'server-port') ?? '25565';
  const seedPort = Number(rawPort);
  const seedIp = readServerProperty(seedProps, 'server-ip') ?? '';
  const seedHost = seedIp === '' || seedIp === '0.0.0.0' ? '127.0.0.1' : seedIp === '::' ? '::1' : seedIp;

  // 源服务器仍在写入时不做普通目录复制（副本会不一致）。
  await assertResetOffline([{ host: seedHost, port: seedPort, label: `种子源服务器 ${path.basename(seedDir)}` }]);

  // 已有测试状态不静默覆盖：按目标自身的配置与实际状态判断，不能拿种子的 level-name 去查目标。
  const existing = existingTestState({ dataDir: config.dataDir, spatialDbPath: config.spatial.databasePath }, targetServerDir);
  if (existing.length) throw new Error(`test 环境已初始化（${existing.join('、')}）。若要重来请另建实例目录或手动重置。`);

  copySeed(seedDir, targetServerDir);
  syncServerForTest(targetServerDir, { mcPort: config.mc.port, rconPort: config.observer.rconPort, rconPassword: config.observer.rconPassword });
  fs.mkdirSync(path.join(config.dataDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.dirname(config.spatial.databasePath), { recursive: true });
  fs.writeFileSync(path.join(config.dataDir, 'init.json'), JSON.stringify({
    worldId: config.memory.worldId, seedSource: seedDir, createdAt: new Date().toISOString(), mcPort: config.mc.port,
  }, null, 2) + '\n');

  console.log('test 环境已初始化：');
  console.log(`  世界目录：${targetServerDir}（server-port=${config.mc.port}）`);
  console.log(`  RCON：${config.observer.rconHost}:${config.observer.rconPort}`);
  console.log(`  数据目录：${config.dataDir}`);
  console.log(`  空间数据库：${config.spatial.databasePath}`);
  console.log(`  世界身份：${config.memory.worldId}`);
  console.log('  启动顺序：先启动 test 的 Minecraft 服务器，再 npm run test:start');
}

const cmd = process.argv.slice(2).find((a) => !a.startsWith('--'));

async function main(): Promise<void> {
  try {
    if (cmd === 'config') await showConfig();
    else if (cmd === 'init') await initTest();
    else {
      console.log('用法：npm run test:config | npm run test:init -- --seed <服务器目录> | npm run test:start');
      process.exitCode = cmd ? 1 : 0;
    }
  } catch (e) {
    console.error(`test 环境操作失败：${(e as Error).message ?? e}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
