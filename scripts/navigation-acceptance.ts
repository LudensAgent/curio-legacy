/**
 * 小型真实导航验收 harness（N-H1，v0.11）。
 *
 * navigate_to → 当前查询 → 测量中取消 → 共享服务最终保存/关闭/重开读回。
 * 不再查询/写入历史路线片段或拓扑，也不捕获旧 route executor 的路线几何。
 * 不启动 main.ts/LLM 循环，也没有周期调度器。--help 与参数拒绝发生在任何运行时
 * import 之前；夹具 RCON 只允许 list 与 tp 本测试 Bot，TP 只算 setup。所有等待
 * 有界，失败保留原始数据。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import type { TaskInfo, TaskOutcome } from '../src/arbiter/arbiter.ts';
import { FEET_ARRIVAL_TOLERANCE, type Vec3Like } from '../src/adapter/types.ts';
import type { Rcon } from '../src/observer/rcon.ts';
import type { SharedSpatialSession as SharedSpatialSessionType, ShutdownResult } from '../src/spatial/shared-session.ts';
import { CONTRACT_VERSION } from 'curio-minecraft-3d-memory';
import type { SpatialSession } from 'curio-minecraft-3d-memory/storage/sqlite';

export const LANE = { minX: 200, maxXExclusive: 219, minZ: 216, maxZExclusive: 218, feetY: 64 } as const;
const CONTROL_KEYS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'] as const;
const WALK_BUDGET_MS = 45_000;
const QUERY_BUDGET_MS = 20_000;

export const HELP = `navigation-acceptance — bounded real navigation acceptance (N-H1)

Usage:
  node --import tsx scripts/navigation-acceptance.ts --curio=test --start=200.5,64,216.5

Options:
  --curio=test            Required; only the isolated test environment is accepted.
  --start=x,y,z           Required; explicit feet position inside the reserved dry lane
                          x[200,219), z[216,218), y=64. Values are never rounded.
  --help, -h              Print this text and exit without loading config or connecting.

A unique run DB and evidence folder are created under DATA_DIR/navigation-acceptance/<runId>.
No periodic scheduler is started. Historical route memory is neither queried nor written.`;

export type ParsedCli =
  | { ok: true; help: true; value?: never }
  | { ok: true; help: false; curio: 'test'; start: Vec3Like; startRaw: string }
  | { ok: false; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec = (v: unknown): v is Vec3Like => isRecord(v) && isNum(v.x) && isNum(v.y) && isNum(v.z);

export function parseCliArgs(argv: readonly string[]): ParsedCli {
  if (argv.includes('--help') || argv.includes('-h')) return { ok: true, help: true };
  const curio = argv.filter((a) => a.startsWith('--curio='));
  const start = argv.filter((a) => a.startsWith('--start='));
  const unknown = argv.filter((a) => !a.startsWith('--curio=') && !a.startsWith('--start='));
  if (unknown.length) return { ok: false, error: `unknown argument(s): ${unknown.join(' ')}` };
  if (curio.length !== 1) return { ok: false, error: 'exactly one --curio=test is required' };
  if (start.length !== 1) return { ok: false, error: 'exactly one --start=x,y,z is required' };
  if (curio[0] !== '--curio=test') return { ok: false, error: `only --curio=test is accepted, got ${curio[0]}` };
  const startRaw = start[0].slice('--start='.length);
  const parts = startRaw.split(',');
  if (parts.length !== 3 || parts.some((p) => p.trim() === '')) return { ok: false, error: '--start must be x,y,z' };
  const [x, y, z] = parts.map((p) => Number(p));
  if (![x, y, z].every(Number.isFinite)) return { ok: false, error: '--start coordinates must be finite' };
  if (y !== LANE.feetY) return { ok: false, error: `--start feet y must be ${LANE.feetY}` };
  if (x < LANE.minX || x >= LANE.maxXExclusive || z < LANE.minZ || z >= LANE.maxZExclusive) {
    return { ok: false, error: '--start is outside the reserved dry lane x[200,219), z[216,218)' };
  }
  return { ok: true, help: false, curio: 'test', start: { x, y, z }, startRaw };
}

export const inLane = (p: Vec3Like): boolean =>
  isVec(p) && p.y === LANE.feetY && p.x >= LANE.minX && p.x < LANE.maxXExclusive && p.z >= LANE.minZ && p.z < LANE.maxZExclusive;

const distance = (a: Vec3Like, b: Vec3Like) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
interface Tolerance { horizontalTolerance: number; feetTolerance: number }
const withinArrival = (pos: Vec3Like, target: Vec3Like, tol: Tolerance) =>
  Math.hypot(pos.x - target.x, pos.z - target.z) <= tol.horizontalTolerance && Math.abs(pos.y - target.y) <= tol.feetTolerance;

/** 成功与取消共用同一把尺：取消只需证明真实部分位移，不能比触发取消的阈值更严。 */
export const CANCEL_MOVEMENT_THRESHOLD = 0.15;

/** 当前 navigate_to 回执或旧 nav 信封；当前回执没有 nav 时从字段构造只读视图。 */
const navOf = (result: unknown): Record<string, unknown> | null => {
  if (!isRecord(result) || !isRecord(result.data)) return null;
  if (isRecord(result.data.nav)) return result.data.nav;
  const data = result.data;
  if (!isVec(data.position)) return null;
  const stop = isRecord(data.stop) ? data.stop : null;
  const arrived = data.arrived === true;
  return {
    outcome: arrived ? 'ARRIVED' : stop?.reason === 'CANCELLED' ? 'CANCELLED' : 'PARTIAL',
    confirmed: arrived,
    lastPosition: data.position,
    ...(isRecord(data.lastObservation) ? { lastObservation: data.lastObservation } : {}),
  };
};

/** navigate_to 终态：succeeded + 实测 ARRIVED/confirmed + 位移 + 运行时到达容差。 */
export function classifyWalkToResult(result: unknown, start: Vec3Like, target: Vec3Like, tol: Tolerance) {
  const p: string[] = [];
  const nav = navOf(result);
  if (!isRecord(result) || result.status !== 'succeeded') p.push('skill status is not succeeded');
  if (nav === null) p.push('missing navigate result data');
  else {
    if (nav.outcome !== 'ARRIVED') p.push(`nav.outcome=${String(nav.outcome)} (ARRIVED required)`);
    if (nav.confirmed !== true) p.push('nav.confirmed is not true');
    if (!isVec(nav.lastPosition)) p.push('missing nav.lastPosition');
    else {
      if (distance(nav.lastPosition, start) <= 0.25) p.push('no measured movement from start');
      if (!withinArrival(nav.lastPosition, target, tol)) p.push('nav.lastPosition outside runtime arrival tolerance');
    }
    if (nav.lastObservation !== undefined && !isRecord(nav.lastObservation)) p.push('nav.lastObservation malformed');
  }
  return { ok: p.length === 0, problems: p, nav };
}

/** 7 个移动控制键必须全部可读且已松开；结算与取消终态共用。 */
export function controlReleaseProblems(controls: Record<string, unknown>): string[] {
  const p: string[] = [];
  const missing = CONTROL_KEYS.filter((k) => typeof controls[k] !== 'boolean');
  if (missing.length) p.push(`missing control keys: ${missing.join(',')}`);
  const active = CONTROL_KEYS.filter((k) => controls[k] === true);
  if (active.length) p.push(`controls not released: ${active.join(',')}`);
  return p;
}

/** 取消终态：cancelled/unconfirmed、真实部分位移、7 个控制键已释放。 */
export function classifyCancellationResult(result: unknown, controls: Record<string, unknown>, reactivated: boolean, start: Vec3Like) {
  const p: string[] = [];
  const nav = navOf(result);
  if (!isRecord(result) || result.status !== 'cancelled') p.push('skill status is not cancelled');
  if (nav === null) p.push('missing navigate result data');
  else {
    if (nav.outcome !== 'CANCELLED') p.push(`nav.outcome=${String(nav.outcome)} (CANCELLED required)`);
    if (nav.confirmed !== false) p.push('cancelled nav must be unconfirmed');
    if (!isVec(nav.lastPosition)) p.push('missing cancelled nav.lastPosition');
    else if (distance(nav.lastPosition, start) <= CANCEL_MOVEMENT_THRESHOLD) p.push('no measured partial movement before cancel');
    if (nav.lastObservation !== undefined && !isRecord(nav.lastObservation)) p.push('cancelled nav.lastObservation malformed');
  }
  p.push(...controlReleaseProblems(controls));
  if (reactivated) p.push('control reactivated during bounded post-cancel window');
  return { ok: p.length === 0, problems: p, nav };
}

/** 终态实际身体：与 NavResult 分开核对位置、落地/干燥/就绪、会话作用域与全部 7 个控制键。 */
export interface TerminalBodyEvidence {
  state: {
    pos: Vec3Like; onGround: boolean; inWater: boolean; observationReady: boolean;
    worldId: string; dim: string; sessionId: string;
  };
  controls: Record<string, unknown>;
}
export function classifyTerminalBody(body: TerminalBodyEvidence | undefined, target: Vec3Like, tol: Tolerance,
  scope: { worldId: string; dim: string; sessionId: string }) {
  const p: string[] = [];
  if (body === undefined) return { ok: false, problems: ['missing terminal body snapshot'] };
  const s = body.state;
  if (!withinArrival(s.pos, target, tol)) p.push('terminal body outside runtime arrival tolerance');
  if (!s.onGround) p.push('terminal body is not grounded');
  if (s.inWater) p.push('terminal body is in water');
  if (!s.observationReady) p.push('terminal body observation is not ready');
  if (s.worldId !== scope.worldId || s.dim !== scope.dim || s.sessionId !== scope.sessionId) {
    p.push('terminal body world/dim/session differs from this run');
  }
  p.push(...controlReleaseProblems(body.controls));
  return { ok: p.length === 0, problems: p };
}

/** 初始观测批次：只取身体附近的有界局部格，交给正常 Vision.observeBlocks 视线判定。 */
export function localBodyCells(start: Vec3Like, radius = 1): Vec3Like[] {
  const feet = { x: Math.floor(start.x), y: Math.floor(start.y), z: Math.floor(start.z) };
  const seen = new Set<string>();
  const cells: Vec3Like[] = [];
  for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) for (let dy = -1; dy <= 1; dy++) {
    const pos = { x: feet.x + dx, y: feet.y + dy, z: feet.z + dz };
    const key = `${pos.x},${pos.y},${pos.z}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cells.push(pos);
  }
  return cells;
}

/**
 * 初始观测证据：`admitted` 必须取共享会话的实际准入状态，不能由 Vision 返回条数猜测；
 * Vision 的真实输出单独保留。正常 Vision.observeBlocks 仍是唯一准入/写入路径，
 * 这里不 beginSession、不填格、不强制 FRESH。
 */
export function initialObservationFacts(
  admitted: boolean,
  cells: readonly Vec3Like[],
  observations: readonly unknown[],
  at: number,
) {
  return {
    at,
    cells: JSON.parse(JSON.stringify(cells)) as Vec3Like[],
    admitted,
    vision: { returned: observations.length, observations: JSON.parse(JSON.stringify(observations)) as unknown[] },
    note: 'admitted is the actual SharedSpatialSession observationAdmitted state after normal Vision.observeBlocks; Vision output is retained separately. No manual beginSession, fill or forced freshness.',
  };
}

/** 有界实际物理帧：每帧只记录交付时的位置与控制键，不事后读状态补帧。 */
export interface PhysicsFrame {
  frame: number; at: number; position: Vec3Like; onGround: boolean; inWater: boolean;
  controls: Record<string, unknown>;
}

/**
 * 稳定落点：在真实物理帧中找一段连续、落地、干燥且位置不变的窗口，帧间时间必须自行跨越
 * 请求的稳定时长。连续性上限与 v0.11 执行器一致：相邻帧间隔不得超过 `Math.max(50, stableMs)`。
 */
export function classifySettledFrames(frames: readonly PhysicsFrame[], stableMs: number) {
  const p: string[] = [];
  if (frames.length === 0) { p.push('no physics frames observed during settle'); return { ok: false, problems: p, position: null }; }
  const maxGapMs = Math.max(50, stableMs);
  let window: PhysicsFrame[] = [];
  let stable: PhysicsFrame[] | null = null;
  for (const frame of frames) {
    if (!frame.onGround || frame.inWater) { window = []; continue; }
    if (window.length === 0) { window = [frame]; continue; }
    const previous = window[window.length - 1]!;
    const ordered = frame.at > previous.at && frame.frame > previous.frame;
    const gapOk = frame.at - previous.at <= maxGapMs;
    const samePosition = distance(frame.position, window[0]!.position) <= 1e-6;
    if (!ordered || !gapOk || !samePosition) { window = [frame]; continue; }
    window.push(frame);
    if (frame.at - window[0]!.at >= stableMs) { stable = window; break; }
  }
  if (stable === null) {
    if (frames.length < 2) p.push('fewer than 2 distinct physics frames during settle');
    else if (!frames.some((f) => f.onGround && !f.inWater)) p.push('settle frames are not grounded and dry');
    else p.push(`no stationary grounded/dry physics-frame window spans ${stableMs}ms with gaps <= ${maxGapMs}ms`);
  }
  const last = stable === null ? null : stable[stable.length - 1]!;
  return { ok: stable !== null, problems: p, position: last === null ? null : { ...last.position } };
}

/**
 * 取消后的有界实际物理帧：没有帧、覆盖不足或任一控制键按下/缺失都不能通过。
 * 只描述这些实际采样帧上的按键状态，不声称采样间隔内每一瞬间的按键都必然为松开。
 */
export function classifyPostCancelFrames(frames: readonly PhysicsFrame[], durationMs: number) {
  const p: string[] = [];
  if (frames.length === 0) { p.push('no physics frames observed after cancel'); return { ok: false, problems: p, reactivated: true }; }
  if (frames.length < 2) p.push('fewer than 2 distinct post-cancel physics frames');
  const first = frames[0]!, last = frames[frames.length - 1]!;
  if (last.at - first.at < durationMs) p.push(`post-cancel frames span ${last.at - first.at}ms < required ${durationMs}ms`);
  let reactivated = false;
  for (const f of frames) {
    const missing = CONTROL_KEYS.filter((k) => typeof f.controls[k] !== 'boolean');
    if (missing.length || CONTROL_KEYS.some((k) => f.controls[k] === true)) { reactivated = true; break; }
  }
  if (reactivated) p.push('control reactivated or unreadable during bounded post-cancel frames');
  return { ok: p.length === 0, problems: p, reactivated };
}

/** 契约信封 + 列表页：返回库原样 `data.items`，不把几何改写成观测。 */
export function validateQueryPage(value: unknown, kind: string) {
  const p: string[] = [];
  if (!isRecord(value)) return { ok: false, problems: ['query envelope is not an object'], total: null as number | null, items: [] as Record<string, unknown>[], nextAfter: undefined as string | undefined };
  if (value.contract !== CONTRACT_VERSION) p.push('contract envelope mismatch');
  if (value.readOnly !== true || value.executable !== false) p.push('query envelope readOnly/executable malformed');
  if (value.status !== 'ok') p.push(`query status ${String(value.status)}`);
  const data = isRecord(value.data) ? value.data : null;
  if (data === null) p.push('missing query data');
  else if (data.kind !== kind) p.push(`query data kind ${String(data.kind)} != ${kind}`);
  const items = data !== null && Array.isArray(data.items) ? data.items.filter(isRecord) : [];
  if (data !== null && !Array.isArray(data.items)) p.push('missing query data.items');
  const total = data !== null && typeof data.total === 'number' ? data.total : null;
  if (total === null) p.push('missing query data.total');
  const nextAfter = typeof value.nextAfter === 'string' ? value.nextAfter : undefined;
  return { ok: p.length === 0, problems: p, total, items, nextAfter };
}

/** Bot 客户端退出的有界分类（真实 bot.end 与 adapter disconnected 都观察到才算完整）。 */
export function classifyAdapterEnd(botEnd: boolean, adapterDisconnected: boolean, timedOut: boolean) {
  const p: string[] = [];
  if (!botEnd) p.push('bot end was not observed');
  if (!adapterDisconnected) p.push('adapter disconnect was not observed');
  if (timedOut) p.push('bounded end wait timed out');
  return { ok: p.length === 0, problems: p };
}

/** 清理失败也必须反映为非零退出，不能被主场景的错误掩盖。 */
export const acceptanceExitCode = (fatal: unknown, failures: readonly unknown[], cleanupErrors: readonly unknown[]) =>
  fatal !== null || failures.length > 0 || cleanupErrors.length > 0 ? 1 : 0;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (predicate()) return true; await sleep(intervalMs); }
  return predicate();
}
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs); })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
const sha256 = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const errorText = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

function collectMetadata(repoRoot: string, scriptPath: string) {
  const git = (args: string[]) => execFileSync('git', ['-c', `safe.directory=${repoRoot}`, ...args], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const top = git(['rev-parse', '--show-toplevel']);
  if (path.resolve(top).toLowerCase() !== path.resolve(repoRoot).toLowerCase()) throw new Error(`git top-level mismatch: ${top}`);
  const head = git(['rev-parse', 'HEAD']);
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error(`git HEAD is not a full 40-char hash: ${head}`);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const packagePath = path.join(repoRoot, 'node_modules', 'curio-minecraft-3d-memory', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as Record<string, unknown>;
  const version = typeof pkg.version === 'string' ? pkg.version.trim() : '';
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error('installed curio package version is missing');
  const provenanceRel = `vendor/curio-minecraft-3d-memory-${version}.provenance.json`;
  const provenanceAbs = path.join(repoRoot, provenanceRel);
  let provenance: Record<string, unknown>;
  if (!fs.existsSync(provenanceAbs)) provenance = { available: false, path: provenanceRel, reason: 'missing' };
  else {
    let tracked = false;
    try { execFileSync('git', ['-c', `safe.directory=${repoRoot}`, 'ls-files', '--error-unmatch', provenanceRel], { cwd: repoRoot, stdio: 'ignore' }); tracked = true; } catch { tracked = false; }
    provenance = tracked ? { available: true, path: provenanceRel, sha256: sha256(provenanceAbs) } : { available: false, path: provenanceRel, reason: 'untracked' };
  }
  return {
    status: 'OK', gitTop: top, branch, head, clean: git(['status', '--porcelain=v1']) === '',
    script: { path: path.relative(repoRoot, scriptPath).replaceAll('\\', '/'), sha256: sha256(scriptPath) },
    package: { name: 'curio-minecraft-3d-memory', version, provenance },
  };
}

/** 声明人数必须与解析出的名字一一对应；缺冒号、count=0 却有名字都算格式错误。 */
export function parseRconList(text: string) {
  const m = /There are (\d+) of a max of (\d+) players online/i.exec(text);
  if (!m) throw new Error(`cannot parse RCON list response: ${text}`);
  const colon = text.indexOf(':');
  if (colon < 0) throw new Error(`RCON list response has no player list separator: ${text}`);
  const count = Number(m[1]);
  const rawNames = text.slice(colon + 1).split(',').map((s) => s.trim());
  if (count === 0) {
    if (rawNames.some(Boolean)) throw new Error(`RCON list declared 0 players but listed names: ${text}`);
    return { count, max: Number(m[2]), names: [] as string[], raw: text };
  }
  if (rawNames.some((s) => s === '')) throw new Error(`RCON list has an empty player entry: ${text}`);
  if (rawNames.length !== count) throw new Error(`RCON list declared ${count} players but parsed ${rawNames.length} names: ${text}`);
  return { count, max: Number(m[2]), names: rawNames, raw: text };
}

/** 连接前只要名单里已有任意一个同名测试 Bot 就拒绝：再连一个同名客户端会把已在线的踢下线。 */
export function preflightBotConflict(names: readonly string[], botName: string): string | null {
  const occurrences = names.filter((n) => n === botName).length;
  return occurrences > 0
    ? `configured test bot ${botName} already listed before connection (${occurrences}); connecting would kick it`
    : null;
}

function controlsSnapshot(adapter: { bot: unknown }) {
  const bot = isRecord(adapter.bot) ? adapter.bot : null;
  const state = bot !== null && isRecord(bot.controlState) ? bot.controlState : null;
  const values: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const key of CONTROL_KEYS) {
    if (state !== null && typeof state[key] === 'boolean') values[key] = state[key];
    else missing.push(key);
  }
  return { ok: missing.length === 0, values, missing };
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  if (!cli.ok) { console.error(`navigation-acceptance: ${cli.error}`); process.exitCode = 2; return; }
  if (cli.help) { console.log(HELP); return; }
  const scriptPath = fileURLToPath(import.meta.url);
  const repoRoot = path.resolve(path.dirname(scriptPath), '..');
  const { config } = await import('../src/config.ts');
  if (config.mode !== 'test') { console.error(`navigation-acceptance: only test mode is accepted, got ${config.mode}`); process.exitCode = 3; return; }

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const evidenceDir = path.join(config.dataDir, 'navigation-acceptance', runId);
  fs.mkdirSync(evidenceDir, { recursive: true });
  const evidence: Record<string, unknown> = {
    schema: 'navigation-acceptance', runId, startedAt: Date.now(), mode: config.mode, evidenceDir,
    host: { mcHost: config.mc.host, mcPort: config.mc.port, username: config.mc.username, version: config.mc.version, rconHost: config.observer.rconHost, rconPort: config.observer.rconPort },
    scheduler: 'not-started', note: 'No periodic scheduler. RCON fixture teleports are setup only, never navigation success. No historical route memory is queried or written.',
    scenarios: {} as Record<string, unknown>, tasks: [] as unknown[],
    rcon: { records: [] as unknown[] },
  };
  const rconRecords = (evidence.rcon as { records: unknown[] }).records;
  const writeEvidence = () => fs.writeFileSync(path.join(evidenceDir, 'evidence.json'), JSON.stringify(evidence, null, 2));
  const scenarios = evidence.scenarios as Record<string, unknown>;
  const scenario = (name: string, extra: Record<string, unknown> = {}) => {
    const s: Record<string, unknown> = { name, status: 'NOT_RUN', problems: [] as string[], ...extra };
    scenarios[name] = s; writeEvidence(); return s;
  };
  const finish = (s: Record<string, unknown>) => { s.status = (s.problems as string[]).length === 0 ? 'PASS' : 'FAIL'; s.finishedAt = Date.now(); writeEvidence(); };
  const addProblem = (s: Record<string, unknown>, message: string) => { (s.problems as string[]).push(message); writeEvidence(); };
  const cleanupErrors: Array<{ step: string; error: unknown }> = [];
  let fatal: unknown = null;
  writeEvidence();

  const { EventBus } = await import('../src/events.ts');
  const { MineflayerAdapter } = await import('../src/adapter/mineflayer.ts');
  const { Vision } = await import('../src/perception/vision.ts');
  const { WorldMemory } = await import('../src/memory/store.ts');
  const { Arbiter } = await import('../src/arbiter/arbiter.ts');
  const { SharedSpatialSession } = await import('../src/spatial/shared-session.ts');
  const { Rcon } = await import('../src/observer/rcon.ts');
  const shutdownMod = await import('../src/spatial/host-shutdown.ts');
  const storage = await import('curio-minecraft-3d-memory/storage/sqlite');
  const tolerance = {
    horizontalTolerance: FEET_ARRIVAL_TOLERANCE.horizontal,
    feetTolerance: FEET_ARRIVAL_TOLERANCE.vertical,
  };

  try { evidence.metadata = collectMetadata(repoRoot, scriptPath); }
  catch (e) { evidence.metadata = { status: 'FAIL', error: shutdownMod.errorFacts(e) }; fatal = new Error(`metadata unavailable: ${errorText(e)}`); writeEvidence(); }

  const bus = new EventBus();
  const adapter = new MineflayerAdapter(config, bus);
  let spatial: SharedSpatialSessionType | null = null;
  let memory: InstanceType<typeof WorldMemory> | null = null;
  let arbiter: InstanceType<typeof Arbiter> | null = null;
  let rcon: Rcon | null = null;
  let shutdownResult: ShutdownResult | null = null;
  let shutdownCallError: unknown = null;
  let botEnded = false, adapterDisconnected = false, eventSequence = 0;
  let doneListener: ((outcome: TaskOutcome) => void) | null = null;
  let disconnectListener: (() => void) | null = null;
  let botEndListener: (() => void) | null = null;
  let botOwned = false;
  let connectAttempted = false;
  let spawnObserved = false;
  type OwnedBot = { once(event: 'end', listener: () => void): void; removeListener(event: 'end', listener: () => void): void };
  let ownedBot: OwnedBot | null = null;
  let dim = 'unknown';
  let measuredStart: Vec3Like | null = null;
  let voxelFact: Record<string, unknown> | null = null;
  const outcomes = new Map<string, TaskOutcome>();
  const waiters = new Map<string, { resolve: (outcome: TaskOutcome) => void; timer: NodeJS.Timeout }>();

  try {
    if (fatal !== null) throw fatal;
    spatial = await SharedSpatialSession.open({ worldId: config.memory.worldId, databasePath: path.join(evidenceDir, 'spatial.sqlite'), timeoutMs: 5000 });
    memory = new WorldMemory(null);
    const vision = new Vision(adapter, config.vision, spatial);
    arbiter = new Arbiter(adapter, memory, bus, vision, spatial);
    rcon = new Rcon(config.observer.rconHost, config.observer.rconPort, config.observer.rconPassword);

    doneListener = (outcome: TaskOutcome) => {
      outcomes.set(outcome.task.id, outcome);
      (evidence.tasks as unknown[]).push({ sequence: ++eventSequence, at: Date.now(), outcome: clone(outcome) });
      writeEvidence();
      const waiter = waiters.get(outcome.task.id);
      if (waiter) { clearTimeout(waiter.timer); waiters.delete(outcome.task.id); waiter.resolve(outcome); }
    };
    arbiter.on('done', doneListener);

    const startTask = (skill: string, args: unknown, budgetMs: number) => {
      const started = arbiter!.start({ skill, args }, 'user');
      if ('error' in started) throw new Error(`${skill} rejected: ${started.error}`);
      const info = started as TaskInfo;
      const done = new Promise<TaskOutcome | null>((resolve) => {
        const timer = setTimeout(() => { waiters.delete(info.id); resolve(null); }, budgetMs);
        waiters.set(info.id, { resolve: (outcome) => { clearTimeout(timer); resolve(outcome); }, timer });
      });
      const settled = outcomes.get(info.id);
      if (settled !== undefined) {
        const waiter = waiters.get(info.id);
        if (waiter !== undefined) clearTimeout(waiter.timer);
        waiters.delete(info.id);
        return { info, done: Promise.resolve(settled) };
      }
      return { info, done };
    };

    const sendRcon = async (command: string) => {
      if (!(command === 'list' || /^tp [A-Za-z0-9_]{1,16} -?\d+(?:\.\d+)? -?\d+(?:\.\d+)? -?\d+(?:\.\d+)?$/.test(command))) throw new Error(`RCON command not allowed: ${command}`);
      const rec: Record<string, unknown> = { sequence: ++eventSequence, at: Date.now(), command };
      try { rec.response = await rcon!.send(command); rconRecords.push(rec); writeEvidence(); return rec.response as string; }
      catch (e) { rec.error = shutdownMod.errorFacts(e); rconRecords.push(rec); writeEvidence(); throw e; }
    };

    // 当前身体样本：每 50ms 读取一次适配器实际状态；不是事后补帧，也不读隐藏地形。
    let frameCounter = 0;
    const nextBodyFrame = async (timeoutMs: number) => {
      await sleep(Math.max(1, Math.min(50, timeoutMs)));
      const state = adapter.state();
      return { position: { ...state.pos }, onGround: state.onGround, inWater: state.inWater };
    };
    const collectPhysicsFrames = async (spanMs: number, hardCapMs: number): Promise<PhysicsFrame[]> => {
      const frames: PhysicsFrame[] = [];
      const startedAt = Date.now();
      let firstAt: number | null = null;
      while (Date.now() - startedAt < hardCapMs) {
        const entity = await nextBodyFrame(Math.min(1000, hardCapMs - (Date.now() - startedAt)));
        const at = Date.now();
        firstAt ??= at;
        frames.push({ frame: ++frameCounter, at, position: { ...entity.position }, onGround: entity.onGround, inWater: entity.inWater, controls: controlsSnapshot(adapter).values });
        if (at - firstAt >= spanMs) break;
      }
      return frames;
    };

    const settleBody = async (timeoutMs: number) => {
      const frames: PhysicsFrame[] = [];
      const startedAt = Date.now();
      let settled = classifySettledFrames(frames, 300);
      while (!settled.ok && Date.now() - startedAt < timeoutMs) {
        const entity = await nextBodyFrame(Math.min(1000, timeoutMs - (Date.now() - startedAt)));
        if (entity === null) break;
        frames.push({ frame: ++frameCounter, at: Date.now(), position: { ...entity.position }, onGround: entity.onGround, inWater: entity.inWater, controls: controlsSnapshot(adapter).values });
        settled = classifySettledFrames(frames, 300);
      }
      if (!settled.ok || settled.position === null) throw new Error(`bounded body settle failed: ${settled.problems.join(', ')}`);
      if (!adapter.state().observationReady) throw new Error('body settled only after observationReady was lost');
      return settled.position;
    };

    const fixtureTeleport = async (position: Vec3Like, label: string) => {
      if (arbiter!.info() !== null) throw new Error(`refusing fixture tp while a task is active (${label})`);
      const name = config.mc.username;
      if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) throw new Error(`unsafe bot username: ${name}`);
      if (adapter.state().username !== name) throw new Error(`connected bot identity ${adapter.state().username} is not configured test user ${name}`);
      if (!isVec(position) || !inLane(position)) throw new Error(`refusing to tp outside lane: ${JSON.stringify(position)}`);
      const list = parseRconList(await sendRcon('list'));
      if (list.names.filter((n) => n === name).length !== 1) throw new Error(`fixture tp requires RCON to list ${name} exactly once`);
      const command = `tp ${name} ${String(position.x)} ${String(position.y)} ${String(position.z)}`;
      (scenarios.fixture ??= { requests: [] as unknown[], responses: [] as unknown[] });
      const fixture = scenarios.fixture as Record<string, unknown>;
      (fixture.requests as unknown[]).push({ label, at: Date.now(), command, position: clone(position), sequence: eventSequence + 1 });
      const response = await sendRcon(command);
      (fixture.responses as unknown[]).push({ label, at: Date.now(), response });
      writeEvidence();
      const reached = await waitFor(() => { const s = adapter!.state(); return s.observationReady && s.onGround && distance(s.pos, position) <= 0.75; }, 10_000);
      if (!reached) throw new Error(`fixture tp did not settle at ${label}`);
      const settled = await settleBody(15_000);
      const interference = adapter.nearbyEntities(24)
        .filter((e) => e.kind === 'player' && e.name !== name && inLane(e.pos))
        .map((e) => ({ name: e.name, pos: { ...e.pos }, dist: e.dist }));
      if (interference.length) {
        fixture.interference = [...((fixture.interference as unknown[] | undefined) ?? []), { label, at: Date.now(), players: interference }];
        writeEvidence();
        throw new Error(`fixture interference in reserved measurement lane at ${label}: ${interference.map((p) => p.name).join(',')}`);
      }
      return settled;
    };

    const captureVoxelFact = (voxel: { cellAt(dim: string, x: number, y: number, z: number): unknown }, dimension: string, points: readonly Vec3Like[]) => {
      const seen = new Set<string>();
      for (const point of points) for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = -2; dy <= 1; dy++) {
        const x = Math.floor(point.x) + dx, y = Math.floor(point.y) + dy, z = Math.floor(point.z) + dz;
        const key = `${x},${y},${z}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const cell = voxel.cellAt(dimension, x, y, z);
        if (!isRecord(cell) || cell.observed !== true || !isRecord(cell.evidence)) continue;
        const observation = cell.evidence.observation;
        if (cell.evidence.freshness !== 'FRESH' || !isRecord(observation)) continue;
        return { dim: dimension, pos: { x, y, z }, freshness: 'FRESH', observation: clone(observation), revision: cell.evidence.revision, validUntil: cell.evidence.validUntil };
      }
      return null;
    };

    disconnectListener = () => { adapterDisconnected = true; };
    adapter.on('disconnected', disconnectListener);

    const botName = config.mc.username;
    if (!/^[A-Za-z0-9_]{1,16}$/.test(botName)) throw new Error(`unsafe bot username: ${botName}`);
    const preflight = parseRconList(await sendRcon('list'));
    evidence.preflight = { at: Date.now(), ...preflight, sequence: (rconRecords.at(-1) as Record<string, unknown> | undefined)?.sequence };
    writeEvidence();
    const preflightConflict = preflightBotConflict(preflight.names, botName);
    if (preflightConflict !== null) throw new Error(preflightConflict);

    let spawnTimer: NodeJS.Timeout | null = null;
    let spawnListener: (() => void) | null = null;
    const spawn = new Promise<void>((resolve, reject) => {
      spawnTimer = setTimeout(() => reject(new Error('bounded spawn wait timed out')), 30_000);
      spawnListener = () => { spawnObserved = true; resolve(); };
      adapter.once('spawn', spawnListener);
    });
    const ownBot = () => {
      if (ownedBot !== null || !adapter.bot) return;
      ownedBot = adapter.bot as unknown as OwnedBot;
      botOwned = true;
      botEndListener = () => { botEnded = true; };
      ownedBot!.once('end', botEndListener);
    };
    try {
      connectAttempted = true;
      adapter.connect();
      ownBot();
      await spawn;
      ownBot();
    } finally {
      if (spawnTimer !== null) { clearTimeout(spawnTimer); spawnTimer = null; }
      if (spawnListener !== null) { adapter.off('spawn', spawnListener); spawnListener = null; }
    }
    const ready = await waitFor(() => adapter.state().observationReady, 30_000);
    if (!ready) throw new Error('bounded observationReady wait timed out');

    const postConnect = parseRconList(await sendRcon('list'));
    evidence.postConnect = { at: Date.now(), ...postConnect, sequence: (rconRecords.at(-1) as Record<string, unknown> | undefined)?.sequence };
    writeEvidence();
    if (postConnect.names.filter((n) => n === botName).length !== 1) {
      throw new Error(`post-connect RCON list must contain owned bot ${botName} exactly once; got ${JSON.stringify(postConnect.names)}`);
    }
    dim = adapter.state().dim;
    evidence.dim = dim;

    measuredStart = await fixtureTeleport(cli.start, 'initial-safe-start');
    evidence.measuredStart = clone(measuredStart);
    writeEvidence();

    const initialCells = localBodyCells(measuredStart);
    const initialObservations = vision.observeBlocks(initialCells);
    evidence.initialObservation = initialObservationFacts(spatial.observationAdmitted, initialCells, initialObservations, Date.now());
    writeEvidence();

    const s1 = scenario('navigate_to');
    try {
      const start = measuredStart;
      if (start === null) throw new Error('missing measured start');
      const target = { x: start.x + 2, y: start.y, z: start.z };
      s1.measuredStart = clone(start); s1.target = clone(target);
      if (!inLane(start) || !inLane(target)) throw new Error('navigate_to start/target outside reserved lane');
      const scope = { worldId: adapter.state().worldId, dim: adapter.state().dim, sessionId: adapter.state().sessionId };
      s1.scope = clone(scope);
      const request = { to: clone(target), maxSteps: 16, deadlineMs: Date.now() + WALK_BUDGET_MS };
      s1.request = clone(request);
      const task = startTask('navigate_to', request, WALK_BUDGET_MS + 5000);
      s1.task = clone(task.info); writeEvidence();
      const outcome = await task.done;
      s1.outcome = outcome === null ? null : clone(outcome);
      const terminalState = adapter.state();
      const terminalControls = controlsSnapshot(adapter);
      s1.body = clone(terminalState); s1.controls = terminalControls;
      if (outcome === null) throw new Error('navigate_to timed out before terminal outcome');
      const verdict = classifyWalkToResult(outcome.result, start, target, tolerance);
      const bodyVerdict = classifyTerminalBody({ state: terminalState, controls: terminalControls.values }, target, tolerance, scope);
      s1.verdict = verdict; s1.bodyVerdict = bodyVerdict;
      if (!verdict.ok || !bodyVerdict.ok) throw new Error([...verdict.problems, ...bodyVerdict.problems].join(', '));
    } catch (e) { addProblem(s1, errorText(e)); } finally { finish(s1); }

    const s2 = scenario('spatial_query_cells');
    try {
      const at = measuredStart ?? { x: 0, y: 64, z: 0 };
      const request = { kind: 'cells', dim, positions: [{ x: Math.floor(at.x), y: Math.floor(at.y) - 1, z: Math.floor(at.z) }] };
      const task = startTask('spatial_query', request, QUERY_BUDGET_MS);
      const outcome = await task.done;
      s2.task = clone(task.info); s2.request = clone(request);
      s2.outcome = outcome === null ? null : clone(outcome);
      if (outcome === null) throw new Error('spatial_query timed out');
      if (outcome.result.status !== 'succeeded') throw new Error(`spatial_query status ${outcome.result.status}`);
      const envelope = isRecord(outcome.result.data) ? outcome.result.data : null;
      if (envelope === null) throw new Error('spatial_query missing envelope');
      if (envelope.status !== 'ok') throw new Error(`spatial_query status ${String(envelope.status)}`);
      const data = isRecord(envelope.data) ? envelope.data : null;
      if (data === null || data.kind !== 'cells') throw new Error('spatial_query data is not cells');
      const cell = Array.isArray(data.cells) ? data.cells.find(isRecord) : undefined;
      if (cell === undefined || cell.observed !== true) throw new Error('ground cell is not observed');
      s2.cell = clone(cell);
    } catch (e) { addProblem(s2, errorText(e)); } finally { finish(s2); }

    const s3 = scenario('cancel_after_movement');
    let cancelTask: { info: TaskInfo; done: Promise<TaskOutcome | null> } | null = null;
    try {
      const start = await settleBody(15_000);
      const target = { x: start.x + (start.x + 3 < LANE.maxXExclusive ? 3 : -3), y: start.y, z: start.z };
      if (!inLane(target)) throw new Error('cancel walk target outside reserved lane');
      const request = { to: clone(target), maxSteps: 16, deadlineMs: Date.now() + 15_000 };
      s3.request = clone(request); s3.measuredStart = clone(start); s3.target = clone(target);
      cancelTask = startTask('navigate_to', request, 20_000);
      s3.task = clone(cancelTask.info); writeEvidence();
      const taskId = cancelTask.info.id;
      const moved = await waitFor(() => {
        const p = adapter.state().pos;
        return distance(p, start) > CANCEL_MOVEMENT_THRESHOLD;
      }, 15_000, 25);
      if (!moved) throw new Error('no measured body movement before cancel');
      if (outcomes.has(taskId)) throw new Error('walk task reached a terminal outcome before cancellation was triggered');
      const cancelAt = Date.now();
      arbiter!.cancel('navigation acceptance cancel');
      const controlsAtCancel = controlsSnapshot(adapter);
      s3.cancellation = { sequence: ++eventSequence, at: cancelAt, reason: 'navigation acceptance cancel', controlsAtCancel };
      writeEvidence();
      const outcome = await cancelTask.done;
      s3.outcome = outcome === null ? null : clone(outcome);
      const controlsAtTerminal = controlsSnapshot(adapter);
      s3.controlsAtTerminal = controlsAtTerminal; writeEvidence();
      const terminalControlProblems = controlReleaseProblems(controlsAtTerminal.values);
      if (terminalControlProblems.length) throw new Error(`terminal controls: ${terminalControlProblems.join(', ')}`);
      const postCancelFrames = await collectPhysicsFrames(600, 2500);
      const postCancel = classifyPostCancelFrames(postCancelFrames, 600);
      s3.postCancelWindow = { durationMs: 600, frames: postCancelFrames, verdict: postCancel };
      if (!postCancel.ok) throw new Error(postCancel.problems.join(', '));
      if (outcome === null) throw new Error('cancelled task timed out before terminal outcome');
      const verdict = classifyCancellationResult(outcome.result, controlsAtCancel.values, postCancel.reactivated, start);
      s3.verdict = verdict;
      if (!verdict.ok) throw new Error(verdict.problems.join(', '));
    } catch (e) { addProblem(s3, errorText(e)); }
    finally {
      if (cancelTask !== null && arbiter?.info()?.id === cancelTask.info.id) arbiter.cancel('acceptance cleanup');
      finish(s3);
    }

    if (spatial !== null && measuredStart !== null) {
      voxelFact = captureVoxelFact(spatial.session.voxel, dim, [measuredStart]) as Record<string, unknown> | null;
      evidence.voxelFact = voxelFact === null ? { status: 'not-captured' } : voxelFact;
      writeEvidence();
    }
  } catch (e) {
    fatal = e;
    evidence.fatalError = shutdownMod.errorFacts(e);
    writeEvidence();
  }

  const s4 = scenario('shutdown_reopen');
  let reopened: SpatialSession | null = null;
  try {
    const active = arbiter?.info() ?? null;
    evidence.shutdownGate = { activeTaskId: active?.id ?? null, at: Date.now() };
    writeEvidence();
    if (arbiter !== null) {
      try { arbiter.setPaused(true); }
      catch (e) { addProblem(s4, `shutdown gate pause/cancel failed: ${errorText(e)}`); cleanupErrors.push({ step: 'shutdown-gate', error: e }); }
      if (active !== null) {
        const settled = await waitFor(() => outcomes.has(active.id), 15_000);
        if (!settled) addProblem(s4, `active task ${active.id} did not settle after pause/cancel`);
      }
    }
    if (spatial === null) addProblem(s4, 'shared session was never opened');
    else {
      try { shutdownResult = await withTimeout(spatial.shutdown(), 30_000, 'bounded shutdown wait'); }
      catch (e) { shutdownCallError = e; }
      const diagnostics = shutdownResult === null ? null : shutdownMod.spatialShutdownDiagnostics(shutdownResult, spatial.worldId);
      const state = spatial.getPersistenceState();
      s4.shutdown = {
        diagnostics, callError: shutdownCallError === null ? null : shutdownMod.errorFacts(shutdownCallError),
        finalState: {
          lifecycle: state.lifecycle, dirty: state.dirty, voxelRevision: state.voxelRevision, confirmedVoxelRevision: state.confirmedVoxelRevision,
          journalRevision: state.journalRevision, confirmedJournalRevision: state.confirmedJournalRevision,
          ledgerRevision: state.ledgerRevision, confirmedLedgerRevision: state.confirmedLedgerRevision,
          factsRevision: state.factsRevision, confirmedFactsRevision: state.confirmedFactsRevision,
          lastConfirmedCheckpointId: state.lastConfirmedCheckpointId,
        },
        checkpoint: shutdownResult?.checkpoint ?? null, close: shutdownResult?.close ?? null,
      };
      writeEvidence();
      if (shutdownResult === null) addProblem(s4, 'shared.shutdown did not return a result');
      else {
        if (diagnostics === null || !diagnostics.ok) addProblem(s4, `shutdown diagnostics: ${(diagnostics?.problems ?? ['missing']).join(',')}`);
        const checkpoint = shutdownResult.checkpoint;
        if (checkpoint === null) addProblem(s4, 'missing final checkpoint');
        else {
          if (state.dirty) addProblem(s4, 'final persistence state is dirty');
          if (state.lastConfirmedCheckpointId !== checkpoint.checkpointId) addProblem(s4, 'final checkpoint id was not confirmed');
          const revisions: Array<[string, number, number, number]> = [
            ['voxel', checkpoint.voxelRevision, state.voxelRevision, state.confirmedVoxelRevision],
            ['journal', checkpoint.journalRevision, state.journalRevision, state.confirmedJournalRevision],
            ['ledger', checkpoint.ledgerRevision, state.ledgerRevision, state.confirmedLedgerRevision],
            ['facts', checkpoint.factsRevision, state.factsRevision, state.confirmedFactsRevision],
          ];
          for (const [name, cp, current, confirmed] of revisions) if (cp !== current || cp !== confirmed) addProblem(s4, `${name} revision not current+confirmed`);
        }
        const close = shutdownResult.close;
        if (close === null) addProblem(s4, 'missing close result');
        else if (!close.completed || close.error !== null || close.unconfirmedRequest || close.dirty) addProblem(s4, 'close was not cleanly completed');
        if (shutdownResult.error !== null) addProblem(s4, 'primary save error present');
        if (shutdownResult.cancelError !== null) addProblem(s4, 'cancel error present');
        if (shutdownResult.closeError !== null) addProblem(s4, 'close error present');
      }
    }

    if (voxelFact === null) addProblem(s4, 'no captured voxel evidence; voxel persistence is unverified');
    const closeConfirmed = shutdownResult !== null && shutdownResult.close !== null
      && shutdownResult.close.completed && shutdownResult.close.error === null
      && !shutdownResult.close.unconfirmedRequest && !shutdownResult.close.dirty;
    if ((s4.problems as string[]).length === 0 && closeConfirmed) {
      reopened = await withTimeout(storage.openSpatialSession({ databasePath: spatial!.databasePath, worldId: spatial!.worldId, timeoutMs: 10_000 }), 30_000, 'bounded reopen wait');
      s4.reopened = true;
      if (voxelFact !== null) {
        const pos = voxelFact.pos as Vec3Like, factDim = voxelFact.dim as string;
        const cell = reopened.voxel.cellAt(factDim, pos.x, pos.y, pos.z);
        const ev = isRecord(cell) && cell.observed === true && isRecord(cell.evidence) ? cell.evidence : null;
        s4.reopenedVoxel = cell;
        if (ev === null) addProblem(s4, 'captured voxel fact disappeared after reopen');
        else {
          if (ev.freshness !== 'STALE') addProblem(s4, 'reopened voxel freshness is not STALE');
          if (!isDeepStrictEqual(voxelFact.observation, ev.observation)) addProblem(s4, 'voxel observation changed after reopen');
        }
      }
      // 旧路线行即使存在也不由本验收读取或改写；只核对摘要仍可读。
      s4.legacyStoreSummary = { ...reopened.legacyStoreSummary };
    } else s4.reopenSkipped = closeConfirmed ? 'missing mandatory original evidence; reopen is not allowed for a PASS' : 'first close not confirmed; reopen is not allowed';
  } catch (e) {
    addProblem(s4, errorText(e));
  } finally {
    if (reopened !== null) {
      try {
        const second = await withTimeout(reopened.close(), 15_000, 'bounded second close wait');
        s4.secondClose = second;
        if (!second.completed || second.error !== null || second.unconfirmedRequest || second.dirty) { addProblem(s4, 'second close was not cleanly completed'); cleanupErrors.push({ step: 'second-close', error: new Error('second close was not cleanly completed') }); }
      } catch (e) { s4.secondCloseError = shutdownMod.errorFacts(e); addProblem(s4, `second close failed: ${errorText(e)}`); cleanupErrors.push({ step: 'second-close', error: e }); }
    }
    finish(s4);
  }

  if (spatial !== null && shutdownResult === null) {
    try {
      const cleanupResult = await withTimeout(spatial.shutdown(), 30_000, 'bounded cleanup shutdown wait');
      shutdownResult = cleanupResult;
      const diagnostics = shutdownMod.spatialShutdownDiagnostics(cleanupResult, spatial.worldId);
      s4.cleanupShutdown = diagnostics;
      if (!diagnostics.ok) cleanupErrors.push({ step: 'shutdown', error: new Error(diagnostics.problems.join(',')) });
    } catch (e) { cleanupErrors.push({ step: 'shutdown', error: e }); }
  }
  for (const [id, waiter] of waiters) { clearTimeout(waiter.timer); waiters.delete(id); }
  if (arbiter !== null && doneListener !== null) arbiter.off('done', doneListener);
  if (arbiter !== null) arbiter.dispose();
  if (rcon !== null) { try { rcon.close(); } catch (e) { cleanupErrors.push({ step: 'close-rcon', error: e }); } }
  if (memory !== null) { try { memory.close(); } catch (e) { cleanupErrors.push({ step: 'close-memory', error: e }); } }
  if (connectAttempted) {
    try {
      adapter.quit();
      const ended = await waitFor(() => botEnded && adapterDisconnected, 5000);
      const classification = classifyAdapterEnd(botEnded, adapterDisconnected, !ended);
      evidence.adapterEnd = { ...classification, connectAttempted, spawnObserved, botOwned, botEnded, adapterDisconnected };
      if (!classification.ok) cleanupErrors.push({ step: 'adapter-end', error: new Error(classification.problems.join(', ')) });
    } catch (e) { cleanupErrors.push({ step: 'adapter-quit', error: e }); }
  } else evidence.adapterEnd = { status: 'not-owned: no Bot client was connected by this harness', connectAttempted, spawnObserved };
  if (disconnectListener !== null) adapter.off('disconnected', disconnectListener);
  if (botEndListener !== null) (ownedBot as OwnedBot | null)?.removeListener('end', botEndListener);

  evidence.rcon = { records: rconRecords };
  evidence.finishedAt = Date.now();
  const failures = Object.values(scenarios).flatMap((s) => isRecord(s) && Array.isArray(s.problems) ? s.problems.map((p) => ({ scenario: s.name, problem: p })) : []);
  evidence.failures = failures;
  evidence.cleanupErrors = cleanupErrors.map((item) => ({ step: item.step, error: shutdownMod.errorFacts(item.error) }));
  evidence.ok = acceptanceExitCode(fatal, failures, cleanupErrors) === 0;
  writeEvidence();
  process.exitCode = acceptanceExitCode(fatal, failures, cleanupErrors);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => { console.error(`navigation-acceptance: ${errorText(e)}`); process.exitCode = 1; });
}
