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
import { readProperties, readServerPropertyValues, validateLevelName } from '../src/maintenance/world-reset.ts';

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

/** 读取 server.properties 的最终值（同名键取最后一个，处理转义与分隔符），与 world-reset 的解析口径一致。 */
export function readServerProperty(file: string, key: string): string | undefined {
  return readServerPropertyValues(file).get(key);
}

/** parent 与 child 相同，或 child 位于 parent 内部。 */
function sameOrNested(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

/** 与 world-reset 的 unescapeProperty 互逆：转义值里的反斜线与控制字符，保证写回后读回值不变。 */
function escapePropertyValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\f/g, '\\f');
}

/**
 * 按 Java Properties 语义写入单个键：移除所有同名逻辑项（= / : 分隔、重复键、续行、转义键）后，
 * 在末尾追加一条规范的 key=value（同名键最后一个生效）。值经转义，写回后读回一致。
 */
export function setServerProperty(file: string, key: string, value: string): void {
  const buffer = fs.readFileSync(file);
  const matches = readProperties(buffer).filter((item) => item.key === key);
  const chunks: Buffer[] = [];
  let offset = 0;
  for (const item of matches) { chunks.push(buffer.subarray(offset, item.start)); offset = item.end; }
  chunks.push(buffer.subarray(offset));
  const without = Buffer.concat(chunks);
  const eol = buffer.includes('\r\n') ? '\r\n' : '\n';
  const entry = Buffer.from(`${key}=${escapePropertyValue(value)}${eol}`);
  const needBreak = without.length > 0 && without[without.length - 1] !== 0x0a;
  fs.writeFileSync(file, Buffer.concat([without, needBreak ? Buffer.from(eol) : Buffer.alloc(0), entry]));
}

/** copySeed 会跳过的运行期目录；检测已有世界时同样跳过，口径一致。 */
const COPY_EXCLUDE = new Set(['logs', 'recordings', '.cache', 'session.lock']);

/** 目录里所有含 level.dat 的世界目录（相对路径，可嵌套）。空目录、只有 server.properties 返回空。 */
export function worldDirsIn(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const found: string[] = [];
  const walk = (current: string, rel: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.isDirectory() || COPY_EXCLUDE.has(entry.name)) continue;
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      if (fs.existsSync(path.join(current, entry.name, 'level.dat'))) found.push(childRel);
      walk(path.join(current, entry.name), childRel);
    }
  };
  walk(dir, '');
  return found;
}

/** 目录里是否存在任何世界（任意深度子目录含 level.dat）。空目录、只有 server.properties 不算已初始化。 */
export function hasWorldData(dir: string): boolean {
  return worldDirsIn(dir).length > 0;
}

/** 目标服务器目录不能包含符号链接或 junction：copySeed 会沿它写入链接指向的外部目录，覆盖其他环境的世界。 */
export function assertNoLinksIn(dir: string): void {
  if (!fs.existsSync(dir)) return;
  if (fs.lstatSync(dir).isSymbolicLink()) throw new Error(`test 世界目录不能是符号链接或 junction：${dir}`);
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`test 世界目录不能包含符号链接或 junction：${child}`);
      if (entry.isDirectory()) walk(child);
    }
  };
  walk(dir);
}

/** 目标自身已有测试状态时的标记列表；空数组 = 尚未初始化。只读，不写盘。 */
export function existingTestState(config: { dataDir: string; spatialDbPath: string }, targetServerDir: string): string[] {
  const markers: string[] = [];
  if (fs.existsSync(path.join(config.dataDir, 'init.json'))) markers.push('初始化标记 init.json');
  if (fs.existsSync(path.join(config.dataDir, 'world-memory.json'))) markers.push('情境记忆 world-memory.json');
  if (fs.existsSync(config.spatialDbPath)) markers.push(`空间数据库 ${config.spatialDbPath}`);
  // 目标服务器目录里任何世界数据都算已初始化：不能只按 server.properties 当前 level-name 判断，
  // 否则 level-name 指向别处时，旧的 world 会被种子复制覆盖并混入旧 region 区块。
  for (const name of worldDirsIn(targetServerDir)) markers.push(`世界 ${name}/level.dat`);
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
  const seedResolved = path.resolve(seedDir);
  const targetResolved = path.resolve(targetServerDir);
  if (sameOrNested(seedResolved, targetResolved) || sameOrNested(targetResolved, seedResolved)) {
    throw new Error('种子源与 test 世界目录不能相同或相互包含，否则复制会把刚创建的目标再次当作源递归展开');
  }
  const levelName = readServerProperty(seedProps, 'level-name') ?? 'world';
  // level-name 必须位于种子服务器目录内部：拒绝绝对路径、.. 段或指向种子目录之外，否则副本仍指向共享世界而非独立副本。
  validateLevelName(seedDir, levelName);
  const seedWorld = path.resolve(seedDir, levelName);
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

  // 目标里不能有符号链接或 junction：copySeed 会沿它写入链接指向的外部目录（如 local 世界），不能把跳过链接当成目标为空。
  assertNoLinksIn(targetServerDir);

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
