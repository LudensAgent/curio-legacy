import { spawn as spawnProcess, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { inspectWorldReset } from '../maintenance/world-reset.ts';
import { Rcon } from '../observer/rcon.ts';
import { ALL_BIOMES, BIOME_TIER, TIER_LABEL, tierDistance, type SpawnFilter } from './biome-tiers.ts';

/**
 * 启动种子筛选：开一个新世界前，用真正的服务端试种子——生成世界、读出生点、问出生点是什么群系，
 * 不是想要的难度就删掉重来；都不中就用最接近的那个种子。每试一次要启动一次服务端（几十秒）。
 * 调用方保证 Agent 和服务器都停了、而且这是一个还没生成过的新世界（地图目录不存在）。
 */
export interface SeedPickOptions {
  serverDir: string;
  projectDir: string;
  filter: SpawnFilter;
  /** 出生点多少格内必须有村庄（水平距离）；不写就不查 */
  villageWithin?: number;
  tries: number;
  java: string;
  javaArgs: string[];
  jar?: string;
  rcon: { host: string; port: number; password: string };
  /** 每次启动服务端最多等多久（毫秒） */
  bootTimeoutMs?: number;
  log?: (line: string) => void;
  /** 测试用：换掉“启动服务端、读出生点群系”这一步 */
  trial?: (seed: string) => Promise<Trial>;
}

export interface Village { x: number; z: number; dist: number }
export interface Trial { biome: string; spawn: { x: number; y: number; z: number }; village?: Village | null }
export interface SeedPick { seed: string; biome: string; spawn: { x: number; y: number; z: number }; village?: Village | null; matched: boolean; tried: { seed: string; biome: string; village?: number | null }[] }

/** 解析 locate 的回答：“The nearest #minecraft:village is at [123, ~, -456] (789 blocks away)” */
export function parseLocate(text: string, from: { x: number; z: number }): Village | null {
  const m = /\[\s*(-?\d+)\s*,\s*[^,\]]+,\s*(-?\d+)\s*\]/.exec(text);
  if (!m) return null;
  const x = Number(m[1]), z = Number(m[2]);
  const away = /\((\d+) blocks? away\)/i.exec(text);
  return { x, z, dist: away ? Number(away[1]) : Math.round(Math.hypot(x - from.x, z - from.z)) };
}

/** 随机一个 Java long 种子（带符号的 64 位整数，十进制） */
export const randomSeed = () => randomBytes(8).readBigInt64LE().toString();

/** 改 server.properties 里的 level-seed（去掉原有的，加一行新的）；其他行原样保留 */
export function setLevelSeed(serverDir: string, seed: string | null) {
  const file = path.join(serverDir, 'server.properties');
  const text = fs.readFileSync(file, 'latin1');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/).filter((l) => !/^[ \t\f]*level-seed[ \t\f]*[=:]/.test(l));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (seed !== null) lines.push(`level-seed=${seed}`);
  fs.writeFileSync(file, lines.join(eol) + eol, 'latin1');
}

export function findServerJar(serverDir: string, configured?: string): string {
  if (configured) {
    const p = path.resolve(serverDir, configured);
    if (!fs.existsSync(p)) throw new Error(`找不到服务端 jar：${p}`);
    return p;
  }
  const jars = fs.readdirSync(serverDir).filter((n) => n.endsWith('.jar'));
  const pick = jars.find((n) => /fabric-server/.test(n)) ?? jars.find((n) => /server/.test(n)) ?? jars[0];
  if (!pick) throw new Error(`服务器目录里没有 jar：${serverDir}（在 .env 里写 SERVER_JAR）`);
  return path.join(serverDir, pick);
}

function removeLevel(serverDir: string, projectDir: string) {
  const plan = inspectWorldReset(serverDir, projectDir);
  const level = path.join(plan.directory, plan.levelName);
  if (path.dirname(level) !== plan.directory) throw new Error(`地图目录不是服务器根下的一层：${level}`);
  const st = (() => { try { return fs.lstatSync(level); } catch { return null; } })();
  if (!st) return;
  if (st.isSymbolicLink()) throw new Error(`地图目录是链接，拒绝删除：${level}`);
  fs.rmSync(level, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/** 读 level.dat 里的出生点 */
async function readSpawn(levelDir: string): Promise<{ x: number; y: number; z: number }> {
  const nbt = (await import('prismarine-nbt')) as any;
  const { parsed } = await (nbt.parse ?? nbt.default.parse)(fs.readFileSync(path.join(levelDir, 'level.dat')));
  const data = parsed.value.Data.value;
  return { x: data.SpawnX.value, y: data.SpawnY.value, z: data.SpawnZ.value };
}

function waitFor(proc: ChildProcess, pattern: RegExp, timeoutMs: number, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let tail = '';
    const t = setTimeout(() => { cleanup(); reject(new Error(`等${what}超时（${Math.round(timeoutMs / 1000)} 秒）；最后的输出：${tail.slice(-300)}`)); }, timeoutMs);
    const onData = (b: Buffer) => {
      tail = (tail + b.toString()).slice(-4000);
      if (pattern.test(tail)) { cleanup(); resolve(); }
      else if (/FAILED TO BIND|Failed to start the minecraft server|Exception in server tick loop/i.test(tail)) { cleanup(); reject(new Error(`服务端启动失败：${tail.slice(-300)}`)); }
    };
    const onExit = (code: number | null) => { cleanup(); reject(new Error(`服务端提前退出（${code}）：${tail.slice(-300)}`)); };
    const cleanup = () => { clearTimeout(t); proc.stdout?.off('data', onData); proc.stderr?.off('data', onData); proc.off('exit', onExit); };
    proc.stdout?.on('data', onData); proc.stderr?.on('data', onData); proc.on('exit', onExit);
  });
}

/** 用真正的服务端生成一次世界，读出生点和那里的群系，再关掉 */
async function serverTrial(opts: SeedPickOptions, seed: string): Promise<Trial> {
  const plan = inspectWorldReset(opts.serverDir, opts.projectDir);
  const jar = findServerJar(plan.directory, opts.jar);
  const proc = spawnProcess(opts.java, [...opts.javaArgs, '-jar', jar, 'nogui'], { cwd: plan.directory, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const exited = new Promise<void>((r) => proc.once('exit', () => r()));
  const rcon = new Rcon(opts.rcon.host, opts.rcon.port, opts.rcon.password, 60_000); // locate 找村庄可能要十几秒
  try {
    await waitFor(proc, /Done \([\d.,]+s\)!/, opts.bootTimeoutMs ?? 240_000, '服务端生成世界');
    let connected = false;
    for (let i = 0; i < 10 && !connected; i++) { try { await rcon.connect(); connected = true; } catch { await new Promise((r) => setTimeout(r, 1000)); } }
    if (!connected) throw new Error('连不上 RCON：检查 server.properties 的 enable-rcon / rcon.port / rcon.password 和 .env 的 RCON_*');
    await rcon.send('save-all flush');
    await new Promise((r) => setTimeout(r, 1500));
    const spawn = await readSpawn(path.join(plan.directory, plan.levelName));
    let biome = 'unknown';
    for (const b of ALL_BIOMES) {
      const r = await rcon.send(`execute if biome ${spawn.x} ${spawn.y} ${spawn.z} minecraft:${b}`);
      if (/passed/i.test(r)) { biome = b; break; }
    }
    // 要求附近有村庄：从出生点找最近的村庄（locate 最远找 100 区块，足够判断 512 格以内）
    let village: Village | null | undefined;
    if (opts.villageWithin) {
      const r = await rcon.send(`execute positioned ${spawn.x} ${spawn.y} ${spawn.z} run locate structure #minecraft:village`);
      village = parseLocate(r, spawn);
    }
    return { biome, spawn, ...(village !== undefined ? { village } : {}) };
  } finally {
    try { await rcon.send('stop'); } catch { proc.stdin?.write('stop\n'); }
    rcon.close();
    const killed = setTimeout(() => proc.kill(), 60_000);
    await exited;
    clearTimeout(killed);
  }
}

export async function pickSeed(opts: SeedPickOptions): Promise<SeedPick> {
  const log = opts.log ?? (() => {});
  const plan = inspectWorldReset(opts.serverDir, opts.projectDir);
  if (fs.existsSync(path.join(plan.directory, plan.levelName))) throw new Error(`地图 ${plan.levelName} 已经存在：种子筛选只给还没生成的新世界用`);
  const trial = opts.trial ?? ((seed: string) => serverTrial(opts, seed));
  const tried: SeedPick['tried'] = [];
  const within = opts.villageWithin ?? 0;
  const villageOk = (r: Trial) => !within || (!!r.village && r.village.dist <= within);
  let best: (SeedPick & { d: number }) | null = null;
  for (let i = 0; i < Math.max(1, opts.tries); i++) {
    const seed = randomSeed();
    setLevelSeed(plan.directory, seed);
    log(`第 ${i + 1}/${opts.tries} 个种子 ${seed}：启动服务端生成世界…`);
    let r: Trial;
    try { r = await trial(seed); }
    catch (e) { removeLevel(plan.directory, opts.projectDir); setLevelSeed(plan.directory, null); throw e; }
    tried.push({ seed, biome: r.biome, ...(within ? { village: r.village ? r.village.dist : null } : {}) });
    const d = tierDistance(r.biome, opts.filter);
    const vOk = villageOk(r);
    const vText = within ? (r.village ? `，最近的村庄在 (${r.village.x},${r.village.z})，${r.village.dist} 格${vOk ? '' : `（超过 ${within}）`}` : '，附近找不到村庄') : '';
    log(`  出生点 (${r.spawn.x},${r.spawn.y},${r.spawn.z}) 是 ${r.biome}（${BIOME_TIER[r.biome] ? TIER_LABEL[BIOME_TIER[r.biome]] : '未知'}）${vText}${d === 0 && vOk ? '，符合' : '，不符合'}`);
    const pick = { seed, biome: r.biome, spawn: r.spawn, ...(within ? { village: r.village ?? null } : {}) };
    if (d === 0 && vOk) return { ...pick, matched: true, tried };
    // 村庄是强制的：没村庄的种子不能当“最接近的”备选
    if (vOk && (!best || d < best.d)) best = { ...pick, matched: false, tried, d };
    removeLevel(plan.directory, opts.projectDir);
  }
  if (!best) {
    setLevelSeed(plan.directory, null);
    throw new Error(`试了 ${tried.length} 个种子，出生点 ${within} 格内都没有村庄（要求村庄是强制的）；把 WORLD_SEED_TRIES 调大再试，或放宽 WORLD_VILLAGE_RADIUS / 关掉 WORLD_REQUIRE_VILLAGE`);
  }
  // 都不完全中：用最接近的那个种子（同一个种子会生成同一个世界，下次启动服务端时生成）
  setLevelSeed(plan.directory, best.seed);
  log(`试了 ${tried.length} 个都不符合「${opts.filter.describe}」${within ? `（有 ${within} 格内村庄的里面）` : ''}，用最接近的 ${best.seed}（${best.biome}）`);
  const { d: _d, ...pick } = best;
  return { ...pick, tried };
}
