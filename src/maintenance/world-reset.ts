import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const KEEP_DIRECTORIES = new Set(['config', 'configs', 'defaultconfigs', 'mods', 'plugins', 'libraries', 'versions', '.fabric']);
const KEEP_FILES = new Set([
  'server.properties', 'eula.txt', 'ops.json', 'banned-ips.json', 'banned-players.json', 'whitelist.json',
  'permissions.json', '.env', 'user_jvm_args.txt', 'jvm_args.txt', 'win_args.txt', 'unix_args.txt',
  'log4j2.xml', 'log4j2_server.xml',
]);
const PROTECTED_PROJECT_DIRECTORIES = ['.git', '.agents', '.codex', '.aws', 'src', 'scripts', 'tests', 'public', 'docs', 'node_modules', 'data'];
const WHITE = /[ \t\f]/;

export interface WorldResetPlan {
  /** 已校验的服务器根；不会删除这个目录。 */
  directory: string;
  /** 顶层相对名称，配置、模组和启动所需运行库均保留。 */
  retained: string[];
  /** 顶层相对名称，包括全部世界、玩家数据、日志与录像。 */
  removed: string[];
  /** 原配置是否包含将移除的 level-seed 项；不存在该项时同样使用随机种子。 */
  seedCleared: boolean;
  levelName: string;
  serverPort: number;
  serverHost: string;
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function samePath(left: string, right: string): boolean {
  return path.relative(left, right) === '';
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function lstatIfPresent(target: string): fs.Stats | undefined {
  try { return fs.lstatSync(target); } catch (error) { if (missing(error)) return undefined; throw error; }
}

function safeServerDirectory(serverDir: string, projectDir: string): string {
  const projectInput = path.resolve(projectDir);
  const project = fs.realpathSync(projectInput);
  const directory = path.resolve(serverDir);
  if (samePath(directory, path.parse(directory).root) || samePath(directory, projectInput)
    || samePath(directory, project) || contains(directory, os.homedir())
    || !contains(projectInput, directory)) {
    throw new Error(`拒绝清理危险或项目之外的服务器目录：${directory}`);
  }
  for (const name of PROTECTED_PROJECT_DIRECTORIES) {
    if (contains(path.join(projectInput, name), directory)) {
      throw new Error(`服务器目录不能位于项目源码、依赖或记忆目录：${directory}`);
    }
  }

  // 包括中间父目录：不能借助 junction 将项目内的路径解析到其他位置。
  for (let ancestor = directory; !samePath(ancestor, projectInput); ancestor = path.dirname(ancestor)) {
    const stat = fs.lstatSync(ancestor);
    if (stat.isSymbolicLink()) throw new Error(`服务器目录不能经过符号链接或 junction：${ancestor}`);
    if (!stat.isDirectory()) throw new Error(`服务器目录不是目录：${ancestor}`);
  }
  const realDirectory = fs.realpathSync(directory);
  if (!contains(project, realDirectory) || samePath(project, realDirectory)) {
    throw new Error(`服务器目录解析到项目之外，拒绝清理：${realDirectory}`);
  }
  for (const name of PROTECTED_PROJECT_DIRECTORIES) {
    if (contains(path.join(project, name), realDirectory)) {
      throw new Error(`服务器目录不能位于项目源码、依赖或记忆目录：${realDirectory}`);
    }
  }
  if (['.git', 'package.json', 'level.dat'].some((name) => lstatIfPresent(path.join(realDirectory, name)))) {
    throw new Error(`目录不是独立的 Minecraft 服务器根，拒绝清理：${realDirectory}`);
  }
  for (const marker of ['server.properties', 'eula.txt']) {
    const target = path.join(realDirectory, marker);
    const stat = lstatIfPresent(target);
    if (!stat?.isFile() || stat.isSymbolicLink()) {
      throw new Error(`服务器根必须包含真实配置文件 ${marker}：${realDirectory}`);
    }
  }
  return realDirectory;
}

interface LogicalProperty {
  start: number;
  end: number;
  key: string;
  value: string;
}

/** Java Properties 的反斜线与 Unicode 转义；输入先按 UTF-8 解码。 */
function unescapeProperty(value: string): string {
  let result = '';
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (char !== '\\') { result += char; continue; }
    const escaped = value[++i];
    if (escaped === undefined) break;
    if (escaped === 'u') {
      const hex = value.slice(i + 1, i + 5);
      if (!/^[0-9a-f]{4}$/i.test(hex)) throw new Error('server.properties 含无效 Unicode 转义，拒绝清理');
      result += String.fromCharCode(Number.parseInt(hex, 16));
      i += 4;
    } else {
      result += ({ t: '\t', r: '\r', n: '\n', f: '\f' } as Record<string, string>)[escaped] ?? escaped;
    }
  }
  return result;
}

/** 用 Latin-1 建立原字节区间，删除种子项时不重编码其他配置、注释与换行。 */
function readProperties(buffer: Buffer): LogicalProperty[] {
  const source = buffer.toString('latin1');
  const properties: LogicalProperty[] = [];
  let offset = 0;
  const nextLine = () => {
    const start = offset;
    while (offset < source.length && source[offset] !== '\r' && source[offset] !== '\n') offset++;
    const content = source.slice(start, offset);
    if (source[offset] === '\r' && source[offset + 1] === '\n') offset += 2;
    else if (offset < source.length) offset++;
    return content;
  };
  while (offset < source.length) {
    const start = offset;
    let logical = nextLine();
    const trimmed = logical.replace(/^[ \t\f]+/, '');
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
    while (true) {
      const slashes = /\\+$/.exec(logical)?.[0].length ?? 0;
      if (slashes % 2 === 0) break;
      logical = logical.slice(0, -1);
      if (offset >= source.length) break;
      logical += nextLine().replace(/^[ \t\f]+/, '');
    }
    logical = logical.replace(/^[ \t\f]+/, '');
    let keyEnd = 0;
    let valueStart = logical.length;
    let precedingBackslash = false;
    let hasSeparator = false;
    for (; keyEnd < logical.length; keyEnd++) {
      const char = logical[keyEnd]!;
      if (!precedingBackslash && (char === '=' || char === ':')) {
        valueStart = keyEnd + 1;
        hasSeparator = true;
        break;
      }
      if (!precedingBackslash && WHITE.test(char)) { valueStart = keyEnd + 1; break; }
      precedingBackslash = char === '\\' ? !precedingBackslash : false;
    }
    while (valueStart < logical.length) {
      const char = logical[valueStart]!;
      if (!WHITE.test(char)) {
        if (!hasSeparator && (char === '=' || char === ':')) hasSeparator = true;
        else break;
      }
      valueStart++;
    }
    const decode = (value: string) => unescapeProperty(Buffer.from(value, 'latin1').toString('utf8'));
    properties.push({ start, end: offset, key: decode(logical.slice(0, keyEnd)), value: decode(logical.slice(valueStart)) });
  }
  return properties;
}

function keepEntry(name: string, stat: fs.Stats): boolean {
  const lower = name.toLowerCase();
  if (KEEP_DIRECTORIES.has(lower)) return true;
  if (stat.isDirectory() && !stat.isSymbolicLink()) return false;
  return KEEP_FILES.has(lower) || /\.(?:properties|toml|ya?ml|conf|ini|cfg|jar|bat|cmd|ps1|sh)$/i.test(name);
}

function validateLevelName(directory: string, levelName: string): void {
  if (!levelName || path.posix.isAbsolute(levelName) || path.win32.isAbsolute(levelName)
    || /[\x00-\x1f<>:"|?*]/.test(levelName)) {
    throw new Error(`level-name 不安全，拒绝清理：${JSON.stringify(levelName)}`);
  }
  const segments = levelName.split(/[\\/]/);
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || /[ .]$/.test(segment)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) {
    throw new Error(`level-name 不安全，拒绝清理：${JSON.stringify(levelName)}`);
  }
  const worldPath = path.resolve(directory, ...segments);
  if (!contains(directory, worldPath) || samePath(directory, worldPath)) {
    throw new Error(`level-name 指向服务器目录之外，拒绝清理：${JSON.stringify(levelName)}`);
  }
  const first = segments[0]!;
  const firstStat = lstatIfPresent(path.join(directory, first));
  if (KEEP_DIRECTORIES.has(first.toLowerCase()) || KEEP_FILES.has(first.toLowerCase())
    || (firstStat && keepEntry(first, firstStat))) {
    throw new Error(`level-name 位于需要保留的配置、模组或启动文件中，拒绝清理：${JSON.stringify(levelName)}`);
  }
  let current = directory;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = lstatIfPresent(current);
    if (!stat) break;
    if (stat.isSymbolicLink()) throw new Error(`level-name 不能经过符号链接或 junction：${current}`);
    if (!stat.isDirectory()) throw new Error(`level-name 不是世界目录：${current}`);
  }
}

function checkedChild(directory: string, target: string): string {
  const absolute = path.resolve(target);
  if (!contains(directory, absolute) || samePath(directory, absolute)) {
    throw new Error(`拒绝删除服务器根或其外部路径：${absolute}`);
  }
  const realParent = fs.realpathSync(path.dirname(absolute));
  if (!contains(directory, realParent) || !samePath(realParent, path.dirname(absolute))) {
    throw new Error(`删除路径的父目录经过链接或位于服务器之外：${absolute}`);
  }
  return absolute;
}

function preflightTree(directory: string, target: string): void {
  const absolute = checkedChild(directory, target);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isDirectory()) return;
  for (const child of fs.readdirSync(absolute)) preflightTree(directory, path.join(absolute, child));
}

function prepareWorldReset(serverDir: string, projectDir: string) {
  const directory = safeServerDirectory(serverDir, projectDir);
  const original = fs.readFileSync(path.join(directory, 'server.properties'));
  const properties = readProperties(original);
  const values = new Map(properties.map((item) => [item.key, item.value]));
  const levelName = values.get('level-name') ?? 'world';
  validateLevelName(directory, levelName);
  const port = values.get('server-port') ?? '25565';
  const serverPort = /^\+?\d+$/.test(port) ? Number(port) : NaN;
  if (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65535) {
    throw new Error('server-port 无效，拒绝清理以免漏检运行中的服务器');
  }
  const configuredHost = values.get('server-ip') ?? '';
  const serverHost = configuredHost === '' || configuredHost === '0.0.0.0' ? '127.0.0.1'
    : configuredHost === '::' ? '::1' : configuredHost;
  if (/\s|\0/.test(serverHost)) throw new Error('server-ip 无效，拒绝清理');
  const seedRanges = properties.filter((item) => item.key === 'level-seed');
  const seedCleared = seedRanges.length > 0;
  const chunks: Buffer[] = [];
  let keptOffset = 0;
  for (const item of seedRanges) { chunks.push(original.subarray(keptOffset, item.start)); keptOffset = item.end; }
  chunks.push(original.subarray(keptOffset));
  const withoutSeed = Buffer.concat(chunks);
  const retained: string[] = [];
  const removed: string[] = [];
  for (const name of fs.readdirSync(directory).sort()) {
    const target = checkedChild(directory, path.join(directory, name));
    const stat = fs.lstatSync(target);
    if (keepEntry(name, stat)) retained.push(name);
    else { preflightTree(directory, target); removed.push(name); }
  }
  const plan: WorldResetPlan = { directory, retained, removed, seedCleared, levelName, serverPort, serverHost };
  return { plan, original, withoutSeed };
}

/** 完全只读；包括保留目录/世界名称冲突与链接的检查。 */
export function inspectWorldReset(serverDir: string, projectDir: string): WorldResetPlan {
  return prepareWorldReset(serverDir, projectDir).plan;
}

function removeTree(directory: string, target: string): void {
  const absolute = checkedChild(directory, target);
  const stat = lstatIfPresent(absolute);
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    // 不加 recursive：junction 和符号链接本身可以删，目标目录绝不遍历。
    fs.rmSync(absolute, { force: true, maxRetries: 5, retryDelay: 100 });
    return;
  }
  if (stat.isDirectory()) {
    for (const child of fs.readdirSync(absolute)) removeTree(directory, path.join(absolute, child));
    checkedChild(directory, absolute);
    const current = fs.lstatSync(absolute);
    if (current.isSymbolicLink()) throw new Error(`清理时目录变成链接，已停止：${absolute}`);
    fs.rmSync(absolute, { recursive: true, maxRetries: 5, retryDelay: 100 });
  } else {
    fs.rmSync(absolute, { force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** 离线重置。调用方必须先停止服务器；绝不删除服务器根，也不会复用旧 level.dat。 */
export function resetWorld(serverDir: string, projectDir: string): WorldResetPlan {
  const { plan, original, withoutSeed } = prepareWorldReset(serverDir, projectDir);
  const propertiesPath = path.join(plan.directory, 'server.properties');
  if (plan.seedCleared) {
    if (!fs.readFileSync(propertiesPath).equals(original)) throw new Error('server.properties 在检查后发生变化，已停止清理');
    const temporary = checkedChild(plan.directory, path.join(plan.directory, `.server.properties-reset-${randomUUID()}.tmp`));
    let created = false;
    try {
      fs.writeFileSync(temporary, withoutSeed, { flag: 'wx', mode: fs.statSync(propertiesPath).mode });
      created = true;
      fs.renameSync(temporary, propertiesPath);
    } finally {
      if (created && lstatIfPresent(temporary)) fs.rmSync(temporary, { force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
  for (const name of plan.removed) removeTree(plan.directory, path.join(plan.directory, name));
  for (const name of plan.removed) {
    if (lstatIfPresent(checkedChild(plan.directory, path.join(plan.directory, name)))) {
      throw new Error(`清理后运行数据仍存在，服务器可能仍在写入：${name}`);
    }
  }
  if (readProperties(fs.readFileSync(propertiesPath)).some((item) => item.key === 'level-seed')) {
    throw new Error('清理后 level-seed 再次出现，服务器或其他进程可能仍在写入');
  }
  return plan;
}
