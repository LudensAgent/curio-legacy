/**
 * 小型真实导航验收 harness（N-H1）。
 *
 * walk_to → 本轮历史查询 → walk_known_route → 测量中取消 → 共享服务最终保存/关闭/重开读回。
 * 不启动 main.ts/LLM 循环，也没有周期调度器。--help 与参数拒绝发生在任何运行时 import 之前；
 * 夹具 RCON 只允许 list 与 tp 本测试 Bot，TP 只算 setup。所有等待有界，失败保留原始数据。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TaskInfo, TaskOutcome } from '../src/arbiter/arbiter.ts';
import type { Vec3Like } from '../src/adapter/types.ts';
import type { Rcon } from '../src/observer/rcon.ts';
import type { SharedSpatialSession as SharedSpatialSessionType, ShutdownResult } from '../src/spatial/shared-session.ts';
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
No periodic scheduler is started.`;

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

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a), bk = Object.keys(b);
  return ak.length === bk.length && ak.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
};
const distance = (a: Vec3Like, b: Vec3Like) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
interface Tolerance { horizontalTolerance: number; feetTolerance: number }
const withinArrival = (pos: Vec3Like, target: Vec3Like, tol: Tolerance) =>
  Math.abs(pos.x - target.x) <= tol.horizontalTolerance && Math.abs(pos.z - target.z) <= tol.horizontalTolerance && Math.abs(pos.y - target.y) <= tol.feetTolerance;
const navOf = (result: unknown): Record<string, unknown> | null => {
  if (!isRecord(result) || !isRecord(result.data)) return null;
  return isRecord(result.data.nav) ? result.data.nav : null;
};

/** walk_to 终态：succeeded + 原始 nav ARRIVED/confirmed + 实测位移 + 现有运行时到达容差。 */
export function classifyWalkToResult(result: unknown, start: Vec3Like, target: Vec3Like, tol: Tolerance) {
  const p: string[] = [];
  const nav = navOf(result);
  if (!isRecord(result) || result.status !== 'succeeded') p.push('skill status is not succeeded');
  if (nav === null) p.push('missing data.nav');
  else {
    if (nav.outcome !== 'ARRIVED') p.push(`nav.outcome=${String(nav.outcome)} (ARRIVED required)`);
    if (nav.confirmed !== true) p.push('nav.confirmed is not true');
    if (!isVec(nav.lastPosition)) p.push('missing nav.lastPosition');
    else {
      if (distance(nav.lastPosition, start) <= 0.25) p.push('no measured movement from start');
      if (!withinArrival(nav.lastPosition, target, tol)) p.push('nav.lastPosition outside runtime arrival tolerance');
    }
    if (!isRecord(nav.lastObservation)) p.push('missing nav.lastObservation');
  }
  return { ok: p.length === 0, problems: p, nav };
}

/** walk_known_route 终态：STARTED + 原样历史几何 + nav ARRIVED/confirmed + 实测位移。 */
export function classifyKnownRouteResult(result: unknown, originalPoints: readonly Vec3Like[], start: Vec3Like, tol: Tolerance) {
  const p: string[] = [];
  const nav = navOf(result);
  const data = isRecord(result) && isRecord(result.data) ? result.data : null;
  const known = data !== null && isRecord(data.knownStart) ? data.knownStart : null;
  const last = originalPoints[originalPoints.length - 1];
  if (!isRecord(result) || result.status !== 'succeeded') p.push('skill status is not succeeded');
  if (known === null) p.push('missing data.knownStart');
  else {
    if (known.kind !== 'STARTED') p.push(`knownStart.kind=${String(known.kind)} (STARTED required)`);
    const route = isRecord(known.route) ? known.route : null;
    if (route === null) p.push('missing data.knownStart.route');
    else {
      if (!Array.isArray(route.points) || !route.points.every(isVec)) p.push('knownStart.route.points malformed');
      else if (!deepEqual(route.points, originalPoints)) p.push('knownStart route geometry/order changed');
      if (!isVec(route.target) || !deepEqual(route.target, last)) p.push('knownStart route target is not original last point');
    }
  }
  if (nav === null) p.push('missing data.nav');
  else {
    if (nav.outcome !== 'ARRIVED') p.push(`nav.outcome=${String(nav.outcome)} (ARRIVED required)`);
    if (nav.confirmed !== true) p.push('nav.confirmed is not true');
    if (!isVec(nav.lastPosition)) p.push('missing nav.lastPosition');
    else {
      if (distance(nav.lastPosition, start) <= 0.25) p.push('no measured movement from settled start');
      if (last !== undefined && !withinArrival(nav.lastPosition, last, tol)) p.push('nav.lastPosition outside runtime arrival tolerance');
    }
    if (!isRecord(nav.lastObservation)) p.push('missing nav.lastObservation');
  }
  return { ok: p.length === 0, problems: p, nav };
}

export interface CapturedWalkSample { at: number; position: Vec3Like; worldId: string; dim: string; sessionId: string }

/** 取消终态：cancelled/unconfirmed、部分数据可对上真实 walkTick 样本、7 个控制键已释放。 */
export function classifyCancellationResult(result: unknown, samples: readonly CapturedWalkSample[], controls: Record<string, unknown>, reactivated: boolean) {
  const p: string[] = [];
  const nav = navOf(result);
  if (!isRecord(result) || result.status !== 'cancelled') p.push('skill status is not cancelled');
  if (nav === null) p.push('missing data.nav');
  else {
    if (nav.outcome !== 'CANCELLED') p.push(`nav.outcome=${String(nav.outcome)} (CANCELLED required)`);
    if (nav.confirmed !== false) p.push('cancelled nav must be unconfirmed');
    const obs = isRecord(nav.lastObservation) ? nav.lastObservation : null;
    if (!isVec(nav.lastPosition)) p.push('missing cancelled nav.lastPosition');
    if (obs === null) p.push('missing cancelled nav.lastObservation');
    else if (!isNum(obs.observedAt) || typeof obs.worldId !== 'string' || typeof obs.dim !== 'string' || typeof obs.sessionId !== 'string') {
      p.push('lastObservation timestamp/scope missing');
    } else if (isVec(nav.lastPosition)) {
      const match = samples
        .filter((s) => deepEqual(s.position, nav.lastPosition) && s.worldId === obs.worldId && s.dim === obs.dim && s.sessionId === obs.sessionId)
        .map((s) => Math.abs(s.at - (obs.observedAt as number))).sort((a, b) => a - b)[0];
      if (match === undefined || match > 50) p.push('partial lastPosition/lastObservation does not match a captured walkTick sample');
    }
  }
  const missing = CONTROL_KEYS.filter((k) => typeof controls[k] !== 'boolean');
  if (missing.length) p.push(`missing control keys: ${missing.join(',')}`);
  const active = CONTROL_KEYS.filter((k) => controls[k] === true);
  if (active.length) p.push(`controls not released: ${active.join(',')}`);
  if (reactivated) p.push('control reactivated during bounded post-cancel window');
  return { ok: p.length === 0, problems: p, nav };
}

/** fragments 稳定契约；返回原始条目，不把几何改写成观测。 */
export function validateFragmentsQuery(value: unknown) {
  const p: string[] = [];
  if (!isRecord(value)) return { ok: false, problems: ['spatialQuery is not an object'], fragments: [] as Record<string, unknown>[], page: null };
  const page = isRecord(value.page) ? value.page : null;
  if (page === null) p.push('missing page');
  else {
    if (page.scan !== 'full_index_filter_sort') p.push('page.scan is not full_index_filter_sort');
    if (typeof page.scanNote !== 'string') p.push('missing page.scanNote');
    if (!isNum(page.limit) || !isNum(page.total) || !isNum(page.returned)) p.push('page numeric fields malformed');
    if (!(page.after === null || typeof page.after === 'string')) p.push('page.after malformed');
  }
  const fragments = Array.isArray(value.fragments) ? value.fragments.filter(isRecord) : [];
  if (!Array.isArray(value.fragments)) p.push('missing fragments array');
  if (page !== null && isNum(page.returned) && page.returned !== fragments.length) p.push('page.returned differs from fragments.length');
  for (const f of fragments) {
    if (typeof f.id !== 'string' || typeof f.worldId !== 'string' || typeof f.dim !== 'string') p.push('fragment identity fields malformed');
    if (typeof f.kind !== 'string' || typeof f.geometrySource !== 'string') p.push('fragment provenance fields malformed');
    if (!isNum(f.createdAt) || !isNum(f.lastUsedAt) || !isNum(f.uses)) p.push('fragment time/uses fields malformed');
    const poly = isRecord(f.polyline) ? f.polyline : null;
    if (poly === null || !Array.isArray(poly.points) || !poly.points.every(isVec) || !isVec(poly.first) || !isVec(poly.last)) p.push('fragment polyline projection malformed');
  }
  return { ok: p.length === 0, problems: p, fragments, page };
}

/** fragment.polyline 稳定契约；返回原始有序点。 */
export function validateFragmentQuery(value: unknown, fragmentId: string) {
  const p: string[] = [];
  if (!isRecord(value)) return { ok: false, problems: ['spatialQuery is not an object'], points: [] as Vec3Like[], total: 0 };
  if (value.found !== true) return { ok: false, problems: [`fragment not found (reason=${String(value.reason ?? 'missing')})`], points: [] as Vec3Like[], total: 0 };
  const fragment = isRecord(value.fragment) ? value.fragment : null;
  if (fragment === null || fragment.id !== fragmentId) p.push('fragment query identity mismatch');
  const poly = fragment !== null && isRecord(fragment.polyline) ? fragment.polyline : null;
  if (poly === null) return { ok: false, problems: [...p, 'missing fragment.polyline'], points: [] as Vec3Like[], total: 0 };
  if (poly.recorded !== true) p.push('polyline.recorded is not true');
  if (!isNum(poly.total) || !isNum(poly.offset) || !isNum(poly.returned)) p.push('polyline page fields malformed');
  const points = Array.isArray(poly.items) ? poly.items.filter(isVec) : [];
  if (!Array.isArray(poly.items)) p.push('polyline.items missing');
  if (poly.offset !== 0) p.push('polyline.offset is not 0');
  if (isNum(poly.returned) && poly.returned !== points.length) p.push('polyline.returned differs from items.length');
  if (isNum(poly.total) && isNum(poly.returned) && poly.returned !== poly.total) p.push('polyline page incomplete (raise limit only with a new bounded query)');
  if (points.length < 2) p.push('polyline has fewer than 2 points');
  return { ok: p.length === 0, problems: p, points, total: isNum(poly.total) ? poly.total : 0 };
}

/** traversals 稳定契约；返回原始 TraversalEvidence，不做时间/session 合成。 */
export function validateTraversalsQuery(value: unknown, fragmentId: string, scope: { worldId: string; dim: string; sessionId: string }) {
  const p: string[] = [];
  if (!isRecord(value)) return { ok: false, problems: ['spatialQuery is not an object'], items: [] as unknown[], record: null };
  const items = Array.isArray(value.items) ? value.items : [];
  if (!Array.isArray(value.items)) p.push('missing items array');
  if (!isRecord(value.page)) p.push('missing page');
  else if (!isNum(value.page.total) || !isNum(value.page.returned) || !isNum(value.page.limit)) p.push('traversals page malformed');
  const record = items.filter((item) => isRecord(item) && item.status === 'found' && isRecord(item.record))
    .map((item) => (item as Record<string, unknown>).record as Record<string, unknown>)
    .find((r) => r.fragmentId === fragmentId) ?? null;
  if (record === null) p.push('no found TraversalEvidence for selected fragment');
  else {
    if (typeof record.id !== 'string') p.push('traversal id missing');
    if (!isVec(record.from) || !isVec(record.to)) p.push('traversal from/to malformed');
    if (record.worldId !== scope.worldId || record.dim !== scope.dim) p.push('traversal world/dim mismatch');
    if (record.sessionId !== scope.sessionId) p.push('traversal sessionId does not match this run');
    if (!isNum(record.observedAt)) p.push('traversal observedAt missing');
    if (typeof record.source !== 'string') p.push('traversal source missing');
    if (!(typeof record.actionId === 'string' && record.actionId !== '') && !(typeof record.executionId === 'string' && record.executionId !== '')) {
      p.push('traversal is not linked to an action/execution');
    }
  }
  return { ok: p.length === 0, problems: p, items, record };
}

/** Bot 客户端退出的有界分类（真实 bot.end 与 adapter disconnected 都观察到才算完整）。 */
export function classifyAdapterEnd(botEnd: boolean, adapterDisconnected: boolean, timedOut: boolean) {
  const p: string[] = [];
  if (!botEnd) p.push('bot end was not observed');
  if (!adapterDisconnected) p.push('adapter disconnect was not observed');
  if (timedOut) p.push('bounded end wait timed out');
  return { ok: p.length === 0, problems: p };
}

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

function parseRconList(text: string) {
  const m = /There are (\d+) of a max of (\d+) players online/i.exec(text);
  if (!m) throw new Error(`cannot parse RCON list response: ${text}`);
  const count = Number(m[1]);
  const colon = text.indexOf(':');
  const names = count === 0 || colon < 0 ? [] : text.slice(colon + 1).split(',').map((s) => s.trim()).filter(Boolean);
  return { count, max: Number(m[2]), names, raw: text };
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
    scheduler: 'not-started', note: 'No periodic scheduler. RCON fixture teleports are setup only, never navigation success.',
    scenarios: {} as Record<string, unknown>, tasks: [] as unknown[],
  };
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
  const library = await import('curio-minecraft-3d-memory');
  const storage = await import('curio-minecraft-3d-memory/storage/sqlite');
  const tolerance = library.GROUNDED_ARRIVAL_DEFAULTS;

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
  let originalWalkTick: typeof adapter.walkTick | undefined;
  let dim = 'unknown';
  let measuredStart: Vec3Like | null = null;
  let selectedFragment: Record<string, unknown> | null = null;
  let selectedTraversal: Record<string, unknown> | null = null;
  let knownPoints: Vec3Like[] | null = null;
  let voxelFact: Record<string, unknown> | null = null;
  const outcomes = new Map<string, TaskOutcome>();
  const waiters = new Map<string, { resolve: (outcome: TaskOutcome) => void; timer: NodeJS.Timeout }>();
  const walkSamples: CapturedWalkSample[] = [];
  const rconRecords: Array<Record<string, unknown>> = [];

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
      return { info, done };
    };

    const sendRcon = async (command: string) => {
      if (!(command === 'list' || /^tp [A-Za-z0-9_]{1,16} -?\d+(?:\.\d+)? -?\d+(?:\.\d+)? -?\d+(?:\.\d+)?$/.test(command))) throw new Error(`RCON command not allowed: ${command}`);
      const rec: Record<string, unknown> = { sequence: ++eventSequence, at: Date.now(), command };
      try { rec.response = await rcon!.send(command); rconRecords.push(rec); writeEvidence(); return rec.response as string; }
      catch (e) { rec.error = shutdownMod.errorFacts(e); rconRecords.push(rec); writeEvidence(); throw e; }
    };

    const settleBody = async (timeoutMs: number) => {
      const deadline = Date.now() + timeoutMs;
      let last: Vec3Like | null = null, stableSince = 0;
      while (Date.now() < deadline) {
        const state = adapter.state();
        if (state.observationReady && state.onGround && !state.inWater) {
          if (last !== null && distance(last, state.pos) < 1e-6) { if (Date.now() - stableSince >= 300) return { ...state.pos }; }
          else { last = { ...state.pos }; stableSince = Date.now(); }
        } else { last = null; stableSince = 0; }
        await sleep(50);
      }
      throw new Error('bounded body settle timed out');
    };

    const fixtureTeleport = async (position: Vec3Like, label: string) => {
      if (arbiter!.info() !== null) throw new Error(`refusing fixture tp while a task is active (${label})`);
      const name = config.mc.username;
      if (!/^[A-Za-z0-9_]{1,16}$/.test(name)) throw new Error(`unsafe bot username: ${name}`);
      if (!isVec(position) || !inLane(position)) throw new Error(`refusing to tp outside lane: ${JSON.stringify(position)}`);
      const command = `tp ${name} ${String(position.x)} ${String(position.y)} ${String(position.z)}`;
      (scenarios.fixture ??= { requests: [] as unknown[], responses: [] as unknown[] });
      const fixture = scenarios.fixture as Record<string, unknown>;
      (fixture.requests as unknown[]).push({ label, at: Date.now(), command, position: clone(position), sequence: eventSequence + 1 });
      const response = await sendRcon(command);
      (fixture.responses as unknown[]).push({ label, at: Date.now(), response });
      writeEvidence();
      const reached = await waitFor(() => { const s = adapter!.state(); return s.observationReady && s.onGround && distance(s.pos, position) <= 0.75; }, 10_000);
      if (!reached) throw new Error(`fixture tp did not settle at ${label}`);
      return settleBody(15_000);
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

    const preflight = parseRconList(await sendRcon('list'));
    evidence.preflight = { at: Date.now(), ...preflight, sequence: rconRecords[rconRecords.length - 1]?.sequence };
    writeEvidence();
    if (preflight.count !== 0) throw new Error(`pre-connect RCON list declared ${preflight.count} players (zero required)`);

    const spawn = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('bounded spawn wait timed out')), 30_000);
      adapter.once('spawn', () => { clearTimeout(timer); resolve(); });
    });
    adapter.connect();
    await spawn;
    if (adapter.bot) { botEndListener = () => { botEnded = true; }; adapter.bot.once('end', botEndListener); }
    const ready = await waitFor(() => adapter.state().observationReady, 30_000);
    if (!ready) throw new Error('bounded observationReady wait timed out');

    const postConnect = parseRconList(await sendRcon('list'));
    evidence.postConnect = { at: Date.now(), ...postConnect, sequence: rconRecords[rconRecords.length - 1]?.sequence };
    writeEvidence();
    const botName = config.mc.username;
    if (postConnect.count !== 1 || postConnect.names.length !== 1 || postConnect.names[0] !== botName) {
      throw new Error(`post-connect RCON list must contain only owned bot ${botName}; got ${JSON.stringify(postConnect.names)}`);
    }
    dim = adapter.state().dim;
    evidence.dim = dim;

    // walkTick 只做只读旁路：原样返回真实帧。
    originalWalkTick = adapter.walkTick;
    if (originalWalkTick) {
      adapter.walkTick = () => {
        const tick = originalWalkTick!.call(adapter);
        return async (signal) => {
          const entity = await tick(signal);
          if (entity) { const s = adapter.state(); walkSamples.push({ at: Date.now(), position: { ...entity.position }, worldId: s.worldId, dim: s.dim, sessionId: s.sessionId }); }
          return entity;
        };
      };
    }

    measuredStart = await fixtureTeleport(cli.start, 'initial-safe-start');
    evidence.measuredStart = clone(measuredStart);
    writeEvidence();

    const preHistory = scenario('pre_walk_empty_history');
    try {
      const task = startTask('spatial_query', { kind: 'fragments', dim, limit: 8 }, QUERY_BUDGET_MS);
      const outcome = await task.done;
      preHistory.task = clone(task.info);
      preHistory.outcome = outcome === null ? null : clone(outcome);
      if (outcome === null) throw new Error('pre-walk history query timed out');
      const q = isRecord(outcome.result.data) ? outcome.result.data.spatialQuery : undefined;
      const checked = validateFragmentsQuery(q);
      preHistory.query = q === undefined ? null : clone(q);
      preHistory.verdict = checked;
      if (!checked.ok) throw new Error(`pre-walk query invalid: ${checked.problems.join(', ')}`);
      if (checked.page === null || checked.page.total !== 0 || checked.fragments.length !== 0) throw new Error('fresh run history is not empty before first walk');
    } catch (e) { addProblem(preHistory, errorText(e)); } finally { finish(preHistory); }

    const s1 = scenario('walk_to');
    try {
      const start = measuredStart;
      if (start === null) throw new Error('missing measured start');
      const target = { x: start.x + 2, y: start.y, z: start.z };
      s1.measuredStart = clone(start); s1.target = clone(target);
      if (!inLane(start) || !inLane(target)) throw new Error('walk_to start/target outside reserved lane');
      const request = { to: clone(target), arrival: { kind: 'exact' as const }, deadlineMs: Date.now() + WALK_BUDGET_MS };
      s1.request = clone(request);
      const task = startTask('walk_to', request, WALK_BUDGET_MS + 5000);
      s1.task = clone(task.info); writeEvidence();
      const outcome = await task.done;
      s1.outcome = outcome === null ? null : clone(outcome);
      s1.body = adapter.state(); s1.controls = controlsSnapshot(adapter);
      if (outcome === null) throw new Error('walk_to timed out before terminal outcome');
      const verdict = classifyWalkToResult(outcome.result, start, target, tolerance);
      s1.verdict = verdict;
      if (!verdict.ok) throw new Error(verdict.problems.join(', '));
    } catch (e) { addProblem(s1, errorText(e)); } finally { finish(s1); }

    const s2 = scenario('spatial_query_history');
    const queries: Array<Record<string, unknown>> = [];
    s2.queries = queries;
    try {
      const runQuery = async (name: string, args: Record<string, unknown>) => {
        const task = startTask('spatial_query', args, QUERY_BUDGET_MS);
        const outcome = await task.done;
        const entry: Record<string, unknown> = { name, at: Date.now(), request: clone(args), task: clone(task.info), outcome: outcome === null ? null : clone(outcome) };
        queries.push(entry); writeEvidence();
        if (outcome === null) throw new Error(`${name} query timed out`);
        const q = isRecord(outcome.result.data) ? outcome.result.data.spatialQuery : undefined;
        entry.query = q === undefined ? null : clone(q); writeEvidence();
        if (q === undefined) throw new Error(`${name} query missing data.spatialQuery`);
        return q;
      };
      const fragments = validateFragmentsQuery(await runQuery('fragments', { kind: 'fragments', dim, limit: 8 }));
      s2.fragmentsVerdict = fragments;
      if (!fragments.ok) throw new Error(fragments.problems.join(', '));
      const selected = fragments.fragments.find((f) => f.geometrySource === 'traversal') ?? null;
      if (selected === null) throw new Error('no traversal-sourced fragment in fresh history');
      selectedFragment = selected; s2.selectedFragment = clone(selected);
      const fragmentId = selected.id as string;

      const polyline = validateFragmentQuery(await runQuery('fragment.polyline', { kind: 'fragment', dim, fragmentId, field: 'polyline', offset: 0, limit: 32 }), fragmentId);
      s2.polylineVerdict = polyline;
      if (!polyline.ok) throw new Error(polyline.problems.join(', '));
      const points = polyline.points;
      if (!points.every(inLane)) throw new Error('stored route leaves the reserved dry lane');
      if (!points.slice(1).every((p, i) => p.y === points[i].y && Math.abs(p.x - points[i].x) + Math.abs(p.z - points[i].z) === 1)) throw new Error('stored polyline is not same-height unit-adjacent');
      if (!deepEqual(points, (selected.polyline as Record<string, unknown>).points)) throw new Error('fragment query polyline differs from fragments listing');
      knownPoints = points;

      const scope = { worldId: adapter.state().worldId, dim, sessionId: adapter.state().sessionId };
      const traversals = validateTraversalsQuery(await runQuery('traversals', { kind: 'traversals', dim, fragmentId, limit: 8 }), fragmentId, scope);
      s2.traversalsVerdict = traversals;
      if (!traversals.ok) throw new Error(traversals.problems.join(', '));
      selectedTraversal = traversals.record;
      const walk1 = (scenarios.walk_to as Record<string, unknown>).task as TaskInfo | undefined;
      if (walk1 !== undefined && typeof selectedTraversal?.actionId === 'string' && selectedTraversal.actionId !== walk1.id) {
        addProblem(s2, `traversal.actionId ${selectedTraversal.actionId} does not match walk task ${walk1.id}`);
      }
    } catch (e) { addProblem(s2, errorText(e)); } finally { finish(s2); }

    const s3 = scenario('walk_known_route');
    try {
      if (selectedFragment === null || knownPoints === null) throw new Error('no verified fragment geometry from this run');
      const first = knownPoints[0], last = knownPoints[knownPoints.length - 1];
      s3.storedGeometry = { first: clone(first), last: clone(last), points: clone(knownPoints) };
      if (!inLane(first)) throw new Error('stored first point outside lane');
      const settled = await fixtureTeleport(first, 'known-route-first-point');
      s3.settledStart = clone(settled);
      if (!withinArrival(settled, first, tolerance)) throw new Error('actual settled body does not satisfy the runtime start point');
      const request = { fragmentId: selectedFragment.id as string, deadlineMs: Date.now() + WALK_BUDGET_MS };
      s3.request = clone(request);
      const task = startTask('walk_known_route', request, WALK_BUDGET_MS + 5000);
      s3.task = clone(task.info); writeEvidence();
      const outcome = await task.done;
      s3.outcome = outcome === null ? null : clone(outcome);
      s3.body = adapter.state(); s3.controls = controlsSnapshot(adapter);
      if (outcome === null) throw new Error('walk_known_route timed out before terminal outcome');
      const verdict = classifyKnownRouteResult(outcome.result, knownPoints, settled, tolerance);
      s3.verdict = verdict;
      if (!verdict.ok) throw new Error(verdict.problems.join(', '));
    } catch (e) { addProblem(s3, errorText(e)); } finally { finish(s3); }

    const s4 = scenario('cancel_after_movement');
    let cancelTask: { info: TaskInfo; done: Promise<TaskOutcome | null> } | null = null;
    try {
      const start = await settleBody(15_000);
      const target = { x: start.x + (start.x + 2 < LANE.maxXExclusive ? 2 : -2), y: start.y, z: start.z };
      if (!inLane(target)) throw new Error('cancel walk target outside reserved lane');
      const request = { to: clone(target), arrival: { kind: 'exact' as const }, deadlineMs: Date.now() + 15_000 };
      s4.request = clone(request); s4.measuredStart = clone(start); s4.target = clone(target);
      cancelTask = startTask('walk_to', request, 20_000);
      s4.task = clone(cancelTask.info); writeEvidence();
      const moved = await waitFor(() => arbiter!.info()?.id === cancelTask!.info.id && distance(adapter.state().pos, start) > 0.15, 15_000, 25);
      if (!moved) throw new Error('walk_to did not produce positive measured displacement while still active');
      const cancelAt = Date.now();
      arbiter!.cancel('navigation acceptance cancel');
      const controlsAtCancel = controlsSnapshot(adapter);
      s4.cancellation = { sequence: ++eventSequence, at: cancelAt, reason: 'navigation acceptance cancel', controlsAtCancel };
      writeEvidence();
      const outcome = await cancelTask.done;
      s4.outcome = outcome === null ? null : clone(outcome);
      s4.controlsAtTerminal = controlsSnapshot(adapter); writeEvidence();
      let reactivated = false;
      const windowSamples: Array<Record<string, unknown>> = [];
      const windowEnd = Date.now() + 600;
      while (Date.now() < windowEnd) {
        const snapshot = controlsSnapshot(adapter);
        windowSamples.push({ at: Date.now(), values: clone(snapshot.values), missing: snapshot.missing });
        if (snapshot.missing.length !== 0 || CONTROL_KEYS.some((k) => snapshot.values[k] === true)) reactivated = true;
        await sleep(25);
      }
      s4.postCancelWindow = { durationMs: 600, samples: windowSamples, walkSamples: walkSamples.filter((sample) => sample.at >= cancelAt).length };
      if (outcome === null) throw new Error('cancelled task timed out before terminal outcome');
      const verdict = classifyCancellationResult(outcome.result, walkSamples, controlsAtCancel.values, reactivated);
      s4.verdict = verdict;
      if (!verdict.ok) throw new Error(verdict.problems.join(', '));
    } catch (e) { addProblem(s4, errorText(e)); }
    finally {
      if (cancelTask !== null && arbiter?.info()?.id === cancelTask.info.id) arbiter.cancel('acceptance cleanup');
      finish(s4);
    }

    if (spatial !== null && knownPoints !== null) {
      voxelFact = captureVoxelFact(spatial.session.voxel, dim, knownPoints) as Record<string, unknown> | null;
      evidence.voxelFact = voxelFact === null ? { status: 'not-captured' } : voxelFact;
      writeEvidence();
    }
  } catch (e) {
    fatal = e;
    evidence.fatalError = shutdownMod.errorFacts(e);
    writeEvidence();
  }

  const s5 = scenario('shutdown_reopen');
  let reopened: SpatialSession | null = null;
  try {
    if (spatial === null) addProblem(s5, 'shared session was never opened');
    else {
      try {
        shutdownResult = await withTimeout(spatial.shutdown(), 30_000, 'bounded shutdown wait');
      } catch (e) { shutdownCallError = e; }
      const diagnostics = shutdownResult === null ? null : shutdownMod.spatialShutdownDiagnostics(shutdownResult, spatial.worldId);
      const state = spatial.getPersistenceState();
      s5.shutdown = {
        diagnostics, callError: shutdownCallError === null ? null : shutdownMod.errorFacts(shutdownCallError),
        finalState: {
          lifecycle: state.lifecycle, dirty: state.dirty, voxelRevision: state.voxelRevision, confirmedVoxelRevision: state.confirmedVoxelRevision,
          fragmentRevision: state.fragmentRevision, confirmedFragmentRevision: state.confirmedFragmentRevision,
          topologyRevision: state.topologyRevision, confirmedTopologyRevision: state.confirmedTopologyRevision, lastConfirmedCheckpointId: state.lastConfirmedCheckpointId,
        },
        checkpoint: shutdownResult?.checkpoint ?? null, close: shutdownResult?.close ?? null,
      };
      writeEvidence();
      if (shutdownResult === null) addProblem(s5, 'shared.shutdown did not return a result');
      else {
        if (diagnostics === null || !diagnostics.ok) addProblem(s5, `shutdown diagnostics: ${(diagnostics?.problems ?? ['missing']).join(',')}`);
        const checkpoint = shutdownResult.checkpoint;
        if (checkpoint === null) addProblem(s5, 'missing final checkpoint');
        else {
          if (state.dirty) addProblem(s5, 'final persistence state is dirty');
          if (state.lastConfirmedCheckpointId !== checkpoint.checkpointId) addProblem(s5, 'final checkpoint id was not confirmed');
          const revisions: Array<[string, number, number, number]> = [
            ['voxel', checkpoint.voxelRevision, state.voxelRevision, state.confirmedVoxelRevision],
            ['fragment', checkpoint.fragmentRevision, state.fragmentRevision, state.confirmedFragmentRevision],
            ['topology', checkpoint.topologyRevision, state.topologyRevision, state.confirmedTopologyRevision],
          ];
          for (const [name, cp, current, confirmed] of revisions) if (cp !== current || cp !== confirmed) addProblem(s5, `${name} revision not current+confirmed`);
        }
        const close = shutdownResult.close;
        if (close === null) addProblem(s5, 'missing close result');
        else if (!close.completed || close.error !== null || close.unconfirmedRequest || close.dirty) addProblem(s5, 'close was not cleanly completed');
        if (shutdownResult.error !== null) addProblem(s5, 'primary save error present');
        if (shutdownResult.cancelError !== null) addProblem(s5, 'cancel error present');
        if (shutdownResult.closeError !== null) addProblem(s5, 'close error present');
      }
    }

    if ((s5.problems as string[]).length === 0 && shutdownResult !== null && shutdownResult.close?.completed === true) {
      reopened = await withTimeout(storage.openSpatialSession({ databasePath: spatial!.databasePath, worldId: spatial!.worldId, timeoutMs: 10_000 }), 30_000, 'bounded reopen wait');
      s5.reopened = true;
      const compareFields = (label: string, original: unknown, copy: unknown, fields: readonly string[]) => {
        if (!isRecord(original) || !isRecord(copy)) { addProblem(s5, `${label} missing on one side`); return; }
        for (const field of fields) {
          const a = Object.prototype.hasOwnProperty.call(original, field), b = Object.prototype.hasOwnProperty.call(copy, field);
          if (a !== b) addProblem(s5, `${label}.${field} presence differs`);
          else if (a && !deepEqual(original[field], copy[field])) addProblem(s5, `${label}.${field} changed after reopen`);
        }
      };
      if (selectedFragment !== null) {
        const copy = reopened.history.getFragment(selectedFragment.id as string);
        s5.reopenedFragment = copy;
        compareFields('fragment', selectedFragment, copy, ['id', 'worldId', 'dim', 'kind', 'entrances', 'polyline', 'geometrySource', 'links', 'deepestY', 'createdAt', 'lastUsedAt', 'uses']);
      } else s5.fragmentComparison = 'not-available: no verified fragment';
      if (selectedTraversal !== null) {
        const copy = reopened.history.getTraversal(selectedTraversal.id as string);
        s5.reopenedTraversal = copy;
        compareFields('traversal', selectedTraversal, copy, ['id', 'fragmentId', 'from', 'to', 'worldId', 'dim', 'sessionId', 'observedAt', 'source', 'executionId', 'actionId', 'mode']);
      } else s5.traversalComparison = 'not-available: no verified traversal';
      if (voxelFact !== null) {
        const pos = voxelFact.pos as Vec3Like, factDim = voxelFact.dim as string;
        const cell = reopened.voxel.cellAt(factDim, pos.x, pos.y, pos.z);
        const ev = isRecord(cell) && cell.observed === true && isRecord(cell.evidence) ? cell.evidence : null;
        s5.reopenedVoxel = cell;
        if (ev === null) addProblem(s5, 'captured voxel fact disappeared after reopen');
        else {
          if (ev.freshness !== 'STALE') addProblem(s5, 'reopened voxel freshness is not STALE');
          compareFields('voxel.observation', voxelFact.observation, ev.observation, Object.keys(isRecord(voxelFact.observation) ? voxelFact.observation : {}));
        }
      } else s5.voxelComparison = 'not-captured: no legitimate observation available';
    } else s5.reopenSkipped = 'first close not confirmed; reopen is not allowed';
  } catch (e) {
    addProblem(s5, errorText(e));
  } finally {
    if (reopened !== null) {
      try {
        const second = await withTimeout(reopened.close(), 15_000, 'bounded second close wait');
        s5.secondClose = second;
        if (!second.completed || second.error !== null || second.unconfirmedRequest || second.dirty) { addProblem(s5, 'second close was not cleanly completed'); cleanupErrors.push({ step: 'second-close', error: new Error('second close was not cleanly completed') }); }
      } catch (e) { s5.secondCloseError = shutdownMod.errorFacts(e); addProblem(s5, `second close failed: ${errorText(e)}`); cleanupErrors.push({ step: 'second-close', error: e }); }
    }
    finish(s5);
  }

  // 早先失败不能跳过服务关停/其他清理；原始主失败保留。
  if (spatial !== null && shutdownResult === null && shutdownCallError === null) {
    try {
      const cleanupResult = await withTimeout(spatial.shutdown(), 30_000, 'bounded cleanup shutdown wait');
      shutdownResult = cleanupResult;
      const diagnostics = shutdownMod.spatialShutdownDiagnostics(cleanupResult, spatial.worldId);
      s5.cleanupShutdown = diagnostics;
      if (!diagnostics.ok) cleanupErrors.push({ step: 'shutdown', error: new Error(diagnostics.problems.join(',')) });
    } catch (e) { cleanupErrors.push({ step: 'shutdown', error: e }); }
  }
  if (arbiter !== null && doneListener !== null) arbiter.off('done', doneListener);
  if (arbiter !== null) arbiter.dispose();
  if (originalWalkTick !== undefined) adapter.walkTick = originalWalkTick;
  if (rcon !== null) { try { rcon.close(); } catch (e) { cleanupErrors.push({ step: 'close-rcon', error: e }); } }
  if (memory !== null) { try { memory.close(); } catch (e) { cleanupErrors.push({ step: 'close-memory', error: e }); } }
  try {
    adapter.quit();
    const ended = await waitFor(() => botEnded && adapterDisconnected, 5000);
    const classification = classifyAdapterEnd(botEnded, adapterDisconnected, !ended);
    evidence.adapterEnd = classification;
    if (!classification.ok) cleanupErrors.push({ step: 'adapter-end', error: new Error(classification.problems.join(', ')) });
  } catch (e) { cleanupErrors.push({ step: 'adapter-quit', error: e }); }
  if (disconnectListener !== null) adapter.off('disconnected', disconnectListener);
  if (botEndListener !== null && adapter.bot) adapter.bot.removeListener('end', botEndListener);

  evidence.rcon = { records: rconRecords };
  evidence.finishedAt = Date.now();
  const failures = Object.values(scenarios).flatMap((s) => isRecord(s) && Array.isArray(s.problems) ? s.problems.map((p) => ({ scenario: s.name, problem: p })) : []);
  evidence.failures = failures;
  evidence.cleanupErrors = cleanupErrors.map((item) => ({ step: item.step, error: shutdownMod.errorFacts(item.error) }));
  evidence.ok = fatal === null && failures.length === 0 && cleanupErrors.length === 0;
  writeEvidence();
  process.exitCode = evidence.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => { console.error(`navigation-acceptance: ${errorText(e)}`); process.exitCode = 1; });
}
