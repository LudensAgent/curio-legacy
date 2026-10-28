import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { inspectMemoryDirectory } from '../memory/clear.ts';
import { inspectWorldReset, resetWorld } from './world-reset.ts';

/**
 * 角色档案：一个“角色”= 它的记忆和技能（DATA_DIR）+ 它活过的世界（服务器目录里属于这个世界的部分）+ 它的 Hindsight 记忆 bank。
 *
 * 运行时仍然用原来的 data/ 和 world/（启动方式不变）；agents/<日期-时间>/ 是每个角色的档案：
 *   agents/<id>/agent.json         角色信息（名字、创建时间、Hindsight bank）
 *   agents/<id>/data/              不在用时：它的 DATA_DIR
 *   agents/<id>/world/             服务器目录里属于这个世界的条目（世界存档、玩家数据、日志、录像……；配置、mods、运行库不算）
 *   agents/<id>/hindsight/bank.zip Hindsight bank 的完整导出（Hindsight 的库丢了也能从这里恢复）
 *   agents/<id>/save/              快速存档：data、世界、配置和 Hindsight；只有再次 save 才覆盖，load 可以反复读
 *   agents/<id>/.previous/         覆盖前的上一份（只留一份）
 * 正在用的角色写在 data/agent.json（跟着 data 走）和 agents/current.json。
 *
 * 切换 / 新建都是“先把当前的整个搬进它自己的档案，再把目标搬回来（或清出一个新的）”：同一块盘上是改名，不用复制几个 G 的录像。
 * 这些操作都要求 Agent 和 Minecraft 服务器已经停了（调用方先检查）。
 */
export const META = 'agent.json';

export interface AgentMeta {
  id: string;
  label?: string;
  createdAt: number;
  /** 最近一次把它存进档案的时间 */
  savedAt?: number;
  /** 这个角色专属的 Hindsight bank */
  bankId: string;
  worldId?: string;
  botUsername?: string;
  /** 从旧的、没有角色档案的 data/ 收编来的 */
  adopted?: boolean;
}

export interface AgentPaths { projectDir: string; dataDir: string; serverDir: string; agentsDir: string; envFile?: string }

/** Hindsight 的 bank 操作（导出、恢复、在不在）；本地记忆模式下不传 */
export interface BankOps {
  exists(bankId: string): Promise<boolean>;
  exportTo(bankId: string, file: string): Promise<number>;
  importFrom(file: string, bankId: string): Promise<void>;
  remove(bankId: string): Promise<void>;
}

export type Log = (line: string) => void;

const ID = /^\d{8}-\d{6}(?:-\d+)?$/;
const SERVER_CONFIG = ['server.properties', 'config', 'configs', 'defaultconfigs'];
const pad = (n: number) => String(n).padStart(2, '0');

/** 按本地时间的“日期-时间”命名：20261026-134500 */
export function agentIdAt(t: number | Date = Date.now()): string {
  const d = new Date(t);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** 新角色的专属 bank：和旧的“世界 + 名字”bank 区分开，每个角色一份 */
export function bankIdFor(worldId: string, botUsername: string, agentId: string): string {
  return `mc-${createHash('sha256').update(JSON.stringify([worldId, botUsername, agentId])).digest('hex').slice(0, 32)}`;
}

const readJson = <T>(file: string): T | null => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return null; } };
const writeJson = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
};
const exists = (p: string) => { try { fs.lstatSync(p); return true; } catch { return false; } };

function move(from: string, to: string) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try { fs.renameSync(from, to); } catch (e: any) {
    if (e?.code !== 'EXDEV') throw e;
    fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

function slot(paths: AgentPaths, id: string) {
  if (!ID.test(id)) throw new Error(`角色 ID 不对：${id}（应为 日期-时间，如 20261026-134500）`);
  const dir = path.join(paths.agentsDir, id);
  return { dir, meta: path.join(dir, META), data: path.join(dir, 'data'), world: path.join(dir, 'world'), bank: path.join(dir, 'hindsight', 'bank.zip'), save: path.join(dir, 'save'), previous: path.join(dir, '.previous') };
}

/** 档案里已有的 data/ 或 world/ 先挪进 .previous（只留一份上一代） */
function keepPrevious(paths: AgentPaths, id: string, part: 'data' | 'world' | 'bank' | 'save') {
  const s = slot(paths, id);
  const current = part === 'bank' ? s.bank : s[part];
  if (!exists(current)) return;
  const prev = path.join(s.previous, part === 'bank' ? 'bank.zip' : part);
  if (exists(prev)) fs.rmSync(prev, { recursive: true, force: true });
  move(current, prev);
}

export function activeAgent(paths: AgentPaths): AgentMeta | null {
  const m = readJson<AgentMeta>(path.join(paths.dataDir, META));
  return m && ID.test(m.id) ? m : null;
}

export function listAgents(paths: AgentPaths): (AgentMeta & { active: boolean; hasWorld: boolean; hasBankArchive: boolean; stats?: Record<string, unknown> | null })[] {
  const active = activeAgent(paths);
  const ids = new Set<string>(exists(paths.agentsDir) ? fs.readdirSync(paths.agentsDir).filter((n) => ID.test(n)) : []);
  if (active) ids.add(active.id);
  return [...ids].sort().map((id) => {
    const s = slot(paths, id);
    const isActive = active?.id === id;
    const meta = (isActive ? active : readJson<AgentMeta>(s.meta)) ?? { id, createdAt: 0, bankId: '' };
    const dataDir = isActive ? paths.dataDir : s.data;
    const run = readJson<Record<string, any>>(path.join(dataDir, 'run-stats.json'));
    return { ...meta, active: isActive, hasWorld: isActive || exists(s.world), hasBankArchive: exists(s.bank) || exists(path.join(s.save, 'hindsight', 'bank.zip')),
      stats: run ? { uptimeH: Math.round((run.uptimeSec ?? 0) / 360) / 10, deaths: run.deaths ?? run.totals?.deaths ?? null } : null };
  });
}

/**
 * 旧的 data/ 还没有角色信息：收编成一个角色（ID 用这次测试开始的时间），沿用原来的 bank，记忆一点不丢。
 */
export function adoptCurrent(paths: AgentPaths, ident: { worldId: string; botUsername: string; legacyBankId: string }, log: Log = () => {}): AgentMeta {
  const have = activeAgent(paths);
  if (have) return have;
  fs.mkdirSync(paths.dataDir, { recursive: true });
  const run = readJson<{ startedAt?: number }>(path.join(paths.dataDir, 'run-stats.json'));
  let id = agentIdAt(run?.startedAt ?? Date.now());
  while (exists(slot(paths, id).dir)) id = `${id.split('-').slice(0, 2).join('-')}-${Number(id.split('-')[2] ?? 1) + 1}`;
  const meta: AgentMeta = { id, label: '收编的旧角色', createdAt: run?.startedAt ?? Date.now(), bankId: ident.legacyBankId, worldId: ident.worldId, botUsername: ident.botUsername, adopted: true };
  writeJson(path.join(paths.dataDir, META), meta);
  writeJson(slot(paths, id).meta, meta);
  log(`把现在的 data/ 收编为角色 ${id}（沿用原来的 Hindsight bank）`);
  return meta;
}

/** 服务器目录里属于“这个世界”的条目（世界存档、玩家数据、日志、录像……）；配置、mods、运行库留在原处 */
export function worldEntries(paths: AgentPaths): string[] {
  return inspectWorldReset(paths.serverDir, paths.projectDir).removed;
}

/** 在用的角色存一份快照（复制，不搬走）；录像默认不复制（几个 G），要的话 withRecordings */
export async function saveActive(paths: AgentPaths, ident: { worldId: string; botUsername: string; legacyBankId: string }, opts: { bank?: BankOps; bankSettings?: { baseUrl: string; apiKey: string }; withRecordings?: boolean; log?: Log } = {}): Promise<AgentMeta> {
  const log = opts.log ?? (() => {});
  const meta = adoptCurrent(paths, ident, log);
  const s = slot(paths, meta.id);
  const tmp = path.join(s.dir, `.saving-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  await exportBank(meta, path.join(tmp, 'hindsight', 'bank.zip'), paths, opts.bank, log);
  fs.cpSync(paths.dataDir, path.join(tmp, 'data'), { recursive: true });
  const entries = worldEntries(paths).filter((n) => opts.withRecordings || n !== 'recordings');
  fs.mkdirSync(path.join(tmp, 'world'), { recursive: true });
  for (const n of entries) fs.cpSync(path.join(paths.serverDir, n), path.join(tmp, 'world', n), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'config', 'server'), { recursive: true });
  SERVER_CONFIG.filter((n) => exists(path.join(paths.serverDir, n))).forEach((n) => {
    fs.cpSync(path.join(paths.serverDir, n), path.join(tmp, 'config', 'server', n), { recursive: true });
  });
  const env = paths.envFile ?? path.join(paths.projectDir, '.env');
  if (exists(env)) fs.copyFileSync(env, path.join(tmp, 'config', '.env'));
  if (opts.bank && opts.bankSettings) writeJson(path.join(tmp, 'config', 'hindsight.json'), opts.bankSettings);
  const saved = { ...meta, savedAt: Date.now() };
  writeJson(path.join(tmp, META), { ...saved, hindsight: !!opts.bank, dataDir: path.resolve(paths.dataDir), serverDir: path.resolve(paths.serverDir), envFile: path.resolve(env) });
  writeJson(path.join(tmp, 'data', META), saved);
  keepPrevious(paths, meta.id, 'save');
  move(tmp, s.save);
  writeJson(path.join(paths.dataDir, META), saved);
  writeJson(s.meta, saved);
  log(`已快速存档 ${meta.id}：data/、配置和世界（${entries.join('、') || '无'}）${opts.withRecordings ? '' : '，录像没复制'}`);
  return saved;
}

/** 读回当前角色的快速存档；复制恢复，快照留着供下一轮测试继续 load。调用方先检查离线。 */
export async function loadActive(paths: AgentPaths, opts: { bank?: BankOps; log?: Log } = {}): Promise<AgentMeta> {
  const meta = activeAgent(paths);
  if (!meta) throw new Error('当前没有角色，请先快速存档：npm run save');
  const s = slot(paths, meta.id);
  const saved = readJson<AgentMeta & { hindsight: boolean; dataDir: string; serverDir: string; envFile?: string }>(path.join(s.save, META));
  if (!saved || saved.id !== meta.id || !exists(path.join(s.save, 'data')) || !exists(path.join(s.save, 'world'))
    || !exists(path.join(s.save, 'config', 'server', 'server.properties'))) {
    throw new Error(`${meta.id} 没有完整的快速存档，请先 npm run save`);
  }
  if (saved.dataDir !== path.resolve(paths.dataDir) || saved.serverDir !== path.resolve(paths.serverDir)) {
    throw new Error('DATA_DIR 或 SERVER_DIR 与快速存档不同，请先改回存档时的目录再 load');
  }
  const env = paths.envFile ?? path.join(paths.projectDir, '.env');
  if (saved.envFile && saved.envFile !== path.resolve(env)) {
    throw new Error('配置文件与快速存档不同，请使用存档时的本地配置再 load');
  }
  if (saved.hindsight && !opts.bank) throw new Error('存档使用 Hindsight，请保持记忆服务运行并加 -- --hindsight 读档');
  const data = inspectMemoryDirectory(paths.dataDir, paths.projectDir);
  const entries = worldEntries(paths).filter((n) => n !== 'recordings' || exists(path.join(s.save, 'world', n)));
  const log = opts.log ?? (() => {});
  if (saved.hindsight && opts.bank) {
    await opts.bank.remove(saved.bankId);
    const archive = path.join(s.save, 'hindsight', 'bank.zip');
    if (exists(archive)) await opts.bank.importFrom(archive, saved.bankId);
    log('Hindsight 记忆已回到快速存档时的状态');
  }
  fs.readdirSync(data.directory).forEach((n) => fs.rmSync(path.join(data.directory, n), { recursive: true, force: true }));
  fs.cpSync(path.join(s.save, 'data'), data.directory, { recursive: true });
  entries.forEach((n) => fs.rmSync(path.join(paths.serverDir, n), { recursive: true, force: true }));
  fs.readdirSync(path.join(s.save, 'world')).forEach((n) => {
    fs.cpSync(path.join(s.save, 'world', n), path.join(paths.serverDir, n), { recursive: true });
  });
  SERVER_CONFIG.forEach((n) => {
    const target = path.join(paths.serverDir, n);
    fs.rmSync(target, { recursive: true, force: true });
    const source = path.join(s.save, 'config', 'server', n);
    if (exists(source)) fs.cpSync(source, target, { recursive: true });
  });
  const savedEnv = path.join(s.save, 'config', '.env');
  if (exists(savedEnv)) fs.copyFileSync(savedEnv, env);
  else fs.rmSync(env, { force: true });
  const { hindsight, dataDir, serverDir, envFile, ...restored } = saved;
  writeJson(s.meta, restored);
  writeJson(path.join(paths.agentsDir, 'current.json'), { active: meta.id, at: Date.now() });
  log(`已快速读档 ${meta.id}：世界、记忆、技能和配置已恢复，快照保留，可反复 load`);
  return restored;
}

async function exportBank(meta: AgentMeta, file: string, paths: AgentPaths, bank: BankOps | undefined, log: Log) {
  if (!bank) return;
  if (!(await bank.exists(meta.bankId))) {
    if (file === slot(paths, meta.id).bank) keepPrevious(paths, meta.id, 'bank');
    log(`Hindsight 里没有 ${meta.id} 的 bank（还没存过记忆），跳过导出`);
    return;
  }
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = await bank.exportTo(meta.bankId, tmp);
  if (!bytes) { fs.rmSync(tmp, { force: true }); throw new Error('Hindsight 导出是空的，停止（什么都没动）'); }
  if (file === slot(paths, meta.id).bank) keepPrevious(paths, meta.id, 'bank');
  move(tmp, file);
  log(`已导出 Hindsight 记忆（${Math.round(bytes / 1024)} KB）→ ${path.relative(paths.projectDir, file)}`);
}

/** 把在用的角色整个搬进它的档案（data/ 清空、世界条目搬走）；返回它的信息 */
async function stashActive(paths: AgentPaths, ident: { worldId: string; botUsername: string; legacyBankId: string }, bank: BankOps | undefined, log: Log): Promise<AgentMeta> {
  const meta = adoptCurrent(paths, ident, log);
  const s = slot(paths, meta.id);
  await exportBank(meta, s.bank, paths, bank, log);
  const entries = worldEntries(paths);
  const stashed = { ...meta, savedAt: Date.now() };
  writeJson(path.join(paths.dataDir, META), stashed);
  keepPrevious(paths, meta.id, 'data');
  keepPrevious(paths, meta.id, 'world');
  move(paths.dataDir, s.data);
  fs.mkdirSync(s.world, { recursive: true });
  for (const n of entries) move(path.join(paths.serverDir, n), path.join(s.world, n));
  writeJson(s.meta, stashed);
  log(`已把 ${meta.id} 收进档案（data/ 和世界：${entries.join('、') || '无'}）`);
  return stashed;
}

/** 把档案里的角色搬回 data/ 和服务器目录；Hindsight 里没有它的 bank 就从导出的 zip 恢复 */
async function restore(paths: AgentPaths, id: string, bank: BankOps | undefined, log: Log): Promise<AgentMeta> {
  const s = slot(paths, id);
  const meta = readJson<AgentMeta>(s.meta);
  if (!meta) throw new Error(`档案 ${id} 没有 ${META}`);
  if (exists(paths.dataDir) && fs.readdirSync(paths.dataDir).length) throw new Error('data/ 不是空的，不能把档案搬回来（先收起当前角色）');
  if (exists(paths.dataDir)) fs.rmdirSync(paths.dataDir);
  if (exists(s.data)) move(s.data, paths.dataDir); else fs.mkdirSync(paths.dataDir, { recursive: true });
  if (exists(s.world)) {
    for (const n of fs.readdirSync(s.world)) {
      const target = path.join(paths.serverDir, n);
      if (exists(target)) throw new Error(`服务器目录里已经有 ${n}，停止恢复（档案里的还留在 ${s.world}）`);
      move(path.join(s.world, n), target);
    }
    fs.rmSync(s.world, { recursive: true, force: true });
  }
  writeJson(path.join(paths.dataDir, META), meta);
  if (bank) {
    if (await bank.exists(meta.bankId)) log(`Hindsight 里 ${id} 的 bank 还在，直接用`);
    else if (exists(s.bank)) { log(`Hindsight 里没有 ${id} 的 bank，从 ${path.relative(paths.projectDir, s.bank)} 恢复（要重新算向量，可能要几分钟）…`); await bank.importFrom(s.bank, meta.bankId); log('Hindsight 记忆恢复完了'); }
    else log(`${id} 没有 Hindsight 记忆可恢复（从没存过）`);
  }
  writeJson(path.join(paths.agentsDir, 'current.json'), { active: id, at: Date.now() });
  return meta;
}

export async function switchAgent(paths: AgentPaths, target: string, ident: { worldId: string; botUsername: string; legacyBankId: string }, opts: { bank?: BankOps; log?: Log } = {}): Promise<{ from: AgentMeta; to: AgentMeta }> {
  const log = opts.log ?? (() => {});
  const id = resolveAgent(paths, target);
  const current = adoptCurrent(paths, ident, log);
  if (current.id === id) throw new Error(`${id} 已经是当前角色`);
  if (!exists(slot(paths, id).meta)) throw new Error(`没有角色档案 ${id}`);
  const from = await stashActive(paths, ident, opts.bank, log);
  try {
    const to = await restore(paths, id, opts.bank, log);
    log(`已切换：${from.id} → ${to.id}${to.label ? `（${to.label}）` : ''}`);
    return { from, to };
  } catch (e) {
    log(`切换失败，把 ${from.id} 搬回来：${(e as Error).message}`);
    await rollback(paths, from.id, log);
    throw e;
  }
}

export async function newAgent(paths: AgentPaths, ident: { worldId: string; botUsername: string; legacyBankId: string }, opts: { label?: string; bank?: BankOps; log?: Log; now?: number; prepareWorld?: () => Promise<unknown> } = {}): Promise<{ from: AgentMeta; to: AgentMeta }> {
  const log = opts.log ?? (() => {});
  const from = await stashActive(paths, ident, opts.bank, log);
  try {
    let id = agentIdAt(opts.now ?? Date.now());
    if (exists(slot(paths, id).dir)) id = `${id}-2`;
    const to: AgentMeta = { id, ...(opts.label ? { label: opts.label.slice(0, 60) } : {}), createdAt: Date.now(), bankId: bankIdFor(ident.worldId, ident.botUsername, id), worldId: ident.worldId, botUsername: ident.botUsername };
    fs.mkdirSync(paths.dataDir, { recursive: true });
    writeJson(path.join(paths.dataDir, META), to);
    writeJson(slot(paths, id).meta, to);
    // 世界条目已经搬走了；再按“完整重置”的规则清掉种子，下次启动服务器生成一个随机种子的新世界
    resetWorld(paths.serverDir, paths.projectDir);
    // 新世界的种子：固定种子、或按出生难度/群系试种子（配置见 .env 的 WORLD_*）
    try { await opts.prepareWorld?.(); } catch (e) { log(`挑种子没成，保持随机种子：${(e as Error).message}`); }
    writeJson(path.join(paths.agentsDir, 'current.json'), { active: id, at: Date.now() });
    log(`新角色 ${id}${to.label ? `（${to.label}）` : ''}：空的记忆和技能、新的 Hindsight bank，下次启动服务器是一个新世界`);
    return { from, to };
  } catch (e) {
    log(`新建失败，把 ${from.id} 搬回来：${(e as Error).message}`);
    if (exists(paths.dataDir)) fs.rmSync(paths.dataDir, { recursive: true, force: true });
    await rollback(paths, from.id, log);
    throw e;
  }
}

async function rollback(paths: AgentPaths, id: string, log: Log) {
  try {
    if (exists(paths.dataDir) && !fs.readdirSync(paths.dataDir).length) fs.rmdirSync(paths.dataDir);
    if (!exists(paths.dataDir)) await restore(paths, id, undefined, log);
  } catch (e) { log(`搬回也失败了，档案还在 agents/${id}：${(e as Error).message}`); }
}

/** 按 ID、ID 前缀或名字找角色 */
export function resolveAgent(paths: AgentPaths, key: string): string {
  const all = listAgents(paths);
  const k = key.trim();
  const hit = all.filter((a) => a.id === k) .concat(all.filter((a) => a.id !== k && (a.id.startsWith(k) || a.label === k)));
  if (!hit.length) throw new Error(`没有角色 ${k}；用 npm run agents:list 看看有哪些`);
  if (hit.length > 1 && hit[0].id !== k) throw new Error(`「${k}」对上了好几个：${hit.map((a) => a.id).join('、')}`);
  return hit[0].id;
}
