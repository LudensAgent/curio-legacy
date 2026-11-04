/**
 * walk_route 真实 Minecraft M2 验收入口：连接 test 服务器，用真实
 * MineflayerAdapter + Arbiter + Vision 从 Arbiter 入口发起 walk_route，
 * 对 W1/W2/W6/W7 逐场景判定 PASS / FAIL / NOT_RUN，保存结构化 JSON 证据。
 *
 *   默认运行：node --import tsx scripts/walk-acceptance.ts --curio=test
 *   选择场景：node --import tsx scripts/walk-acceptance.ts --curio=test --scenarios=W1,W6
 *   帮助：    node --import tsx scripts/walk-acceptance.ts --help
 *
 * 只走/只读，不挖、不放、不绕路（W2 的平台夹具通过 RCON 在限定竞技场内搭建，
 * 全程记录操作）。任一场景失败不中断其余场景；失败只写入该场景的 FAIL 与部分证据，
 * 不伪造未运行场景为通过。清理只关闭自己的 Bot/RCON，不 force process.exit 掩盖未收尾工作。
 *
 * 证据标记为 provisional：不自动宣告 M2 完成，待协调者最终 C 证据确认后重跑/裁定。
 * 本入口只负责「采集真实的 per-segment 证据 + 源元数据校验」这一层骨架；W1/W2/W6/W7
 * 的场景级断言与容差属于下一阶段。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Bot, ControlState } from 'mineflayer';
import type { NavResult } from 'curio-minecraft-3d-memory';
import { config } from '../src/config.ts';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { Vision } from '../src/perception/vision.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { EventBus } from '../src/events.ts';
import { Rcon } from '../src/observer/rcon.ts';
import type { SkillResult } from '../src/skills/types.ts';
import type { WalkBody, WalkTick } from '../src/adapter/walk-route.ts';

// ---------------------------------------------------------------------------
// 类型与常量
// ---------------------------------------------------------------------------

type ScenarioId = 'W1' | 'W2' | 'W3' | 'W4' | 'W5' | 'W6' | 'W7';
type Verdict = 'PASS' | 'FAIL' | 'NOT_RUN';

const SUPPORTED_SCENARIOS: ScenarioId[] = ['W1', 'W2', 'W6', 'W7'];
const ALL_SCENARIOS: ScenarioId[] = ['W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7'];

const KEYS: ControlState[] = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'];

type KeyState = Record<ControlState, boolean>;
type Keys = KeyState;

export interface FrameRecord {
  seq: number;
  ts: number;
  dtMs: number;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  onGround: boolean;
  inWater: boolean;
  keys: Keys;
  ownerTaskId: string | null;
  worldAgeTicks: number | null;
}

/** 一次控制写入：身体桥 set/clear/look 与全局 stopAll 都在同一条时间线上，靠 op 区分。 */
export interface ControlEntry {
  ts: number;
  op: 'set' | 'clear' | 'look' | 'stopAll';
  name?: string;
  value?: boolean;
  ownerTaskId: string | null;
}

/** 真实 adapter.stopAll 之前采集的全键快照（stopAll 会清键，之前才是「释放前」状态）。 */
export interface StopAllSnapshot {
  ts: number;
  label: string;
  keys: Keys;
  ownerTaskId: string | null;
}

/** walkTick 交付的实测帧采样日志：owner 绑定在 walkTick 创建时，用于检测旧任务迟到样本。 */
export interface SampleEntry {
  ts: number;
  ownerTaskId: string | null;
  x: number; y: number; z: number;
}

interface ControlSnapshot {
  ts: number;
  label: string;
  keys: Keys;
  ownerTaskId: string | null;
}

interface ServerCorrection {
  ts: number;
  kind: 'forcedMove' | 'position' | 'position_look';
  x?: number; y?: number; z?: number;
}

/** 完整记录 TaskOutcome.result（SkillResult，含完整 data.nav），不伪造 NavResult 子集。 */
export interface TaskResultRecord {
  taskId: string;
  planVersion: number;
  skill: string;
  source: string;
  durationMs: number;
  preemptedBy?: string;
  gentle?: boolean;
  result: SkillResult;
}

interface ScenarioEvidence {
  verdict: Verdict;
  note?: string;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  taskIds: string[];
  results: TaskResultRecord[];
  frames: FrameRecord[];
  framesTruncated: boolean;
  controlLog: ControlEntry[];
  controlSnapshots: ControlSnapshot[];
  stopSnapshots: StopAllSnapshot[];
  sampleLog: SampleEntry[];
  serverCorrections: ServerCorrection[];
  trajectory?: Record<string, unknown>;
  error?: string;
  cleanupError?: string;
  extra?: Record<string, unknown>;
}

/** 竞技场与步行道候选：控制面预检后确认；不可与流体道 x76..90,z76..86 重叠。 */
const ARENA = {
  candidate: 'x200..220, z200..220',
  fluidLaneAvoid: 'x76..90, z76..86',
  // W2 平台（stone，walkCollisionProvider 的 DRY_FULL 之一）：候选区内小块高台。
  // 坐标在后续授权运行的控制面预检中最终确定；此处为占位，未连接即不落地。
  platform: { xMin: 205, xMax: 212, zMin: 205, zMax: 210, topY: 64 },
};

/** W6/W7 平坦步行道（与 W2 平台 z205..210 错开，走 +X）。坐标待控制面预检确认。 */
const WALK_LANE = { start: { x: 200.5, y: 64, z: 216.5 }, note: 'W6/W7 平坦步行道候选，y 为平坦地面脚高（待确认）' };

// ---------------------------------------------------------------------------
// 纯函数（供脚本与窄测试复用，无副作用）
// ---------------------------------------------------------------------------

export function parseScenarioSelector(raw: string | undefined): ScenarioId[] {
  if (!raw || raw.trim() === '') return [...SUPPORTED_SCENARIOS];
  const tokens = raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (tokens.length === 0) return [...SUPPORTED_SCENARIOS];
  for (const t of tokens) {
    if (!(ALL_SCENARIOS as string[]).includes(t)) throw new Error(`未知场景 ${t}；可选：${ALL_SCENARIOS.join(',')}`);
  }
  return tokens as ScenarioId[];
}

/**
 * 解析 RCON `list` 的在线玩家名。只接受原版已知格式
 * `There are N of a max of M players online: name1, name2`；格式不符或声明数量
 * 与实际名字数不一致时抛错（预检据此 fail closed），不把畸形响应静默当成空列表。
 */
export function parseRconList(raw: string): string[] {
  const m = /^There are (\d+) of a max of (\d+) players online:(.*)$/.exec(raw.trim());
  if (!m) throw new Error(`RCON list 响应格式无法解析：${JSON.stringify(raw)}`);
  const declared = Number(m[1]);
  const max = Number(m[2]);
  if (!Number.isInteger(max) || max < declared) throw new Error(`RCON list 数量非法：declared=${declared} max=${m[2]}`);
  const tail = m[3].trim();
  const names = tail ? tail.split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (names.length !== declared) throw new Error(`RCON list 在线数不一致：声明 ${declared} 实际 ${names.length}`);
  return names;
}

export function dist2(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function snapshotKeys(bot: { controlState: KeyState }): Keys {
  const out = {} as Keys;
  for (const k of KEYS) out[k] = !!bot.controlState[k];
  return out;
}

/** 轨迹统计：W2 断言无坠落/失支撑所需。 */
export function summarizeTrajectory(frames: FrameRecord[]): Record<string, unknown> {
  const xs = frames.map((f) => f.x), zs = frames.map((f) => f.z), ys = frames.map((f) => f.y);
  const dts = frames.map((f) => f.dtMs).filter((d) => d > 0);
  const min = (a: number[]) => (a.length ? Math.min(...a) : NaN);
  const max = (a: number[]) => (a.length ? Math.max(...a) : NaN);
  const avg = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
  const first = frames[0], last = frames[frames.length - 1];
  return {
    frameCount: frames.length,
    minFeetY: min(ys), maxFeetY: max(ys),
    minX: min(xs), maxX: max(xs), minZ: min(zs), maxZ: max(zs),
    airborneFrames: frames.filter((f) => !f.onGround).length,
    allGrounded: frames.length > 0 && frames.every((f) => f.onGround),
    dtMs: { min: min(dts), max: max(dts), avg: avg(dts) },
    horizontalSpan: first && last ? Number(dist2(first, last).toFixed(3)) : null,
  };
}

/** 沿 X 单轴的相邻分数步点列（start → target 逐格）。 */
export function adjacentRouteX(start: { x: number; y: number; z: number }, target: { x: number; y: number; z: number }): { x: number; y: number; z: number }[] {
  const n = Math.round(target.x - start.x);
  const out: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i <= n; i++) out.push({ x: start.x + i, y: start.y, z: start.z });
  return out;
}

function isDirectRun(): boolean {
  if (!process.argv[1]) return false;
  try { return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href; } catch { return false; }
}

// ---------------------------------------------------------------------------
// 诊断采集（不改任何运行时行为：只包装并委托原实现，所有权在创建时绑定一次）
// ---------------------------------------------------------------------------

/** walkBody / walkTick / stopAll 的最小结构面，便于用假夹具做窄测试。 */
export interface WalkBridge {
  walkBody?: () => WalkBody;
  walkTick?: () => WalkTick;
  stopAll: () => void;
}

/**
 * 采集身体桥控制写入、真实 stopAll 前的全键快照、walkTick 交付的样本，全部把
 * 归属（taskId）绑定在「walkBody / walkTick 创建那一刻」，而不是写入那一刻——
 * 旧任务 A 的迟到回调在 B 运行期间写入时，仍被记为 A，不会误算成 B。
 */
export class WalkDiagnostics {
  readonly controlLog: ControlEntry[] = [];
  readonly stopSnapshots: StopAllSnapshot[] = [];
  readonly sampleLog: SampleEntry[] = [];
  private lastBodyOwner: string | null = null;
  private origBody?: () => WalkBody;
  private origTick?: () => WalkTick;
  private origStop?: () => void;

  constructor(
    private readonly target: WalkBridge,
    private readonly owner: () => string | null,
    private readonly readKeys: () => Keys,
    private readonly now: () => number = Date.now,
  ) {}

  wrap() {
    const origBody = this.target.walkBody;
    const origTick = this.target.walkTick;
    const origStop = this.target.stopAll;

    if (origBody) {
      this.target.walkBody = () => {
        // 创建时绑定归属一次：这是技能运行期间（任务仍为 current）调用，得到正确 taskId。
        const owner = this.owner();
        this.lastBodyOwner = owner;
        const body = origBody.call(this.target);
        return {
          setControlState: (name: string, value: boolean) => {
            this.controlLog.push({ ts: this.now(), op: 'set', name, value, ownerTaskId: owner });
            body.setControlState(name, value);
          },
          clearControlStates: () => {
            this.controlLog.push({ ts: this.now(), op: 'clear', ownerTaskId: owner });
            body.clearControlStates();
          },
          look: (yaw: number, pitch: number) => {
            this.controlLog.push({ ts: this.now(), op: 'look', ownerTaskId: owner });
            return body.look(yaw, pitch);
          },
          entity: body.entity,
        };
      };
    }

    if (origTick) {
      this.target.walkTick = () => {
        const owner = this.owner();
        const tick = origTick.call(this.target);
        return async (signal: AbortSignal) => {
          const entity = await tick(signal);
          if (entity) this.sampleLog.push({ ts: this.now(), ownerTaskId: owner, x: entity.position.x, y: entity.position.y, z: entity.position.z });
          return entity;
        };
      };
    }

    this.target.stopAll = () => {
      // 真实 stopAll 之前采集全键状态：Arbiter 在调用 stopAll 前已把 current 置 null，
      // 所以归属用创建时绑定的 lastBodyOwner，而不是此刻的 current。
      const keys = this.readKeys();
      const owner = this.lastBodyOwner;
      this.stopSnapshots.push({ ts: this.now(), label: 'pre-stopAll', keys, ownerTaskId: owner });
      this.controlLog.push({ ts: this.now(), op: 'stopAll', ownerTaskId: owner });
      origStop.call(this.target);
    };

    this.origBody = origBody;
    this.origTick = origTick;
    this.origStop = origStop;
  }

  /** 只在所有任务结果都已结束（runScenario 收尾后）才恢复原实现。 */
  unwrap() {
    if (this.origBody) this.target.walkBody = this.origBody;
    if (this.origTick) this.target.walkTick = this.origTick;
    if (this.origStop) this.target.stopAll = this.origStop;
    this.origBody = undefined;
    this.origTick = undefined;
    this.origStop = undefined;
  }
}

class FrameRecorder {
  frames: FrameRecord[] = [];
  truncated = false;
  private seq = 0;
  private lastTs: number | null = null;
  private readonly onTick = () => this.capture();

  constructor(private readonly bot: Bot, private readonly owner: () => string | null) {}

  private capture() {
    const now = Date.now();
    const e = this.bot.entity;
    if (!e) return;
    const dtMs = this.lastTs === null ? 0 : now - this.lastTs;
    this.lastTs = now;
    this.frames.push({
      seq: this.seq++, ts: now, dtMs,
      x: e.position.x, y: e.position.y, z: e.position.z,
      vx: e.velocity.x, vy: e.velocity.y, vz: e.velocity.z,
      onGround: e.onGround, inWater: (e as { isInWater?: boolean }).isInWater === true,
      keys: snapshotKeys(this.bot),
      ownerTaskId: this.owner(),
      worldAgeTicks: typeof this.bot.time?.age === 'number' ? this.bot.time.age : null,
    });
  }

  start() { this.bot.on('physicsTick', this.onTick); }
  stop() { this.bot.removeListener('physicsTick', this.onTick); }
}

class ServerCorrectionRecorder {
  corrections: ServerCorrection[] = [];
  // Mineflayer 在服务端下发位置纠正/传送包时触发 forcedMove；它是服务端纠正的规范信号，
  // 原始 position / position_look 包由它统一起到，这里只记这一条诊断信号，不碰原始缓存。
  private readonly onForced = () => {
    const e = this.bot.entity;
    this.corrections.push({ ts: Date.now(), kind: 'forcedMove', x: e?.position.x, y: e?.position.y, z: e?.position.z });
  };

  constructor(private readonly bot: Bot) {}

  start() { this.bot.on('forcedMove', this.onForced); }
  stop() { this.bot.removeListener('forcedMove', this.onForced); }
}

/** 按 taskId 过滤的 done 监听：只收本任务的终态，所有路径都移除监听器与定时器。 */
function waitForTask(arbiter: Arbiter, taskId: string, timeoutMs: number): Promise<TaskOutcome> {
  return new Promise((resolve, reject) => {
    const onDone = (o: TaskOutcome) => {
      if (o.task.id !== taskId) return;
      cleanup();
      resolve(o);
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`task ${taskId} 未在 ${timeoutMs}ms 内结束`)); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); arbiter.removeListener('done', onDone); };
    arbiter.on('done', onDone);
  });
}

/** 从 SkillResult.data 取出完整 NavResult（公开类型），不手工挑选字段拼子集。 */
function navFromResult(result: SkillResult): NavResult | undefined {
  const nav = result.data?.nav;
  if (nav === null || typeof nav !== 'object' || Array.isArray(nav)) return undefined;
  if (!('outcome' in nav)) return undefined;
  return nav as NavResult;
}

/** 完整记录 TaskOutcome.result（SkillResult，含完整 data.nav）。 */
function toTaskRecord(o: TaskOutcome): TaskResultRecord {
  return {
    taskId: o.task.id,
    planVersion: o.task.planVersion,
    skill: o.task.skill,
    source: o.task.source,
    durationMs: o.durationMs,
    preemptedBy: o.preemptedBy,
    gentle: o.gentle,
    result: o.result,
  };
}

// ---------------------------------------------------------------------------
// 元数据与证据落盘
// ---------------------------------------------------------------------------

function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Git 元数据：正常走 execFileSync，失败向上抛（不进证据 = 失败退出），不伪造 clean HEAD。 */
export function gitMeta() {
  const run = (args: string[]) => execFileSync('git', args, { cwd: path.resolve('.'), encoding: 'utf8' }).trim();
  const sha = run(['rev-parse', 'HEAD']);
  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
  const dirtyPaths = run(['status', '--short']).split('\n').filter(Boolean).map((l) => l.slice(3));
  return { sha, branch, dirtyPaths, scriptFingerprint: sha256File(fileURLToPath(import.meta.url)) };
}

/**
 * 源元数据：读实际 package.json 依赖声明、package-lock 条目、已安装包与引用 tgz 的
 * SHA256，并校验彼此对应；任一步缺失或不一致都抛错（fail source check），不用
 * unknown/missing 占位符掩盖。不做静态安装版本声明——版本一律从已安装包读取。
 */
export function packageMeta() {
  const root = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  const dep = root.dependencies?.['curio-minecraft-3d-memory'];
  if (typeof dep !== 'string' || dep.length === 0) throw new Error('package.json 缺少 curio-minecraft-3d-memory 依赖声明');

  const tgzRel = dep.startsWith('file:') ? dep.slice('file:'.length) : dep;
  const tgzPath = path.resolve(tgzRel);
  const tgzSha256 = sha256File(tgzPath);

  const installed = JSON.parse(fs.readFileSync(path.resolve('node_modules/curio-minecraft-3d-memory/package.json'), 'utf8')) as { name?: string; version?: string };
  const lock = JSON.parse(fs.readFileSync(path.resolve('package-lock.json'), 'utf8')) as { packages?: Record<string, { name?: string; version?: string; resolved?: string }> };
  const lockEntry = lock.packages?.['node_modules/curio-minecraft-3d-memory'];
  if (!lockEntry) throw new Error('package-lock.json 缺少 node_modules/curio-minecraft-3d-memory 条目');
  // file: 依赖的 lock 条目可能不写 name；写了才交叉校验，不硬塞静态包名。
  if (lockEntry.name !== undefined && lockEntry.name !== installed.name) throw new Error(`包名不一致：lock ${lockEntry.name} vs installed ${installed.name}`);
  if (lockEntry.version !== installed.version) throw new Error(`版本不一致：lock ${lockEntry.version} vs installed ${installed.version}`);
  if (lockEntry.resolved !== dep) throw new Error(`依赖声明 ${dep} 与 lock resolved ${lockEntry.resolved} 不一致`);

  return {
    name: installed.name,
    version: installed.version,
    dependencySpec: dep,
    lockVersion: lockEntry.version,
    lockResolved: lockEntry.resolved,
    tgzPath,
    tgzSha256,
  };
}

export interface HarnessContext {
  bot: Bot;
  adapter: MineflayerAdapter;
  arbiter: Arbiter;
  rcon: Rcon;
  evidenceDir: string;
  runId: string;
}

interface ScenarioDiag {
  recorder: FrameRecorder;
  corrections: ServerCorrectionRecorder;
  diag: WalkDiagnostics;
  ev: ScenarioEvidence;
}

// ---------------------------------------------------------------------------
// RCON 预检与夹具
// ---------------------------------------------------------------------------

async function rconPreflight(rcon: Rcon, expected: Set<string>): Promise<{ ok: boolean; raw: string; occupants: string[]; duplicateBot: boolean; unexpected: string[] }> {
  const raw = await rcon.send('list');
  const occupants = parseRconList(raw); // 畸形响应在此抛错 → 预检 fail closed
  const duplicateBot = occupants.filter((o) => o === config.mc.username).length > 0;
  const unexpected = occupants.filter((o) => !expected.has(o));
  return { ok: !duplicateBot && unexpected.length === 0, raw, occupants, duplicateBot, unexpected };
}

/** 在竞技场内用 RCON setblock 搭建 W2 平台并记录每一条操作（只写候选区内）。 */
async function buildPlatformFixture(rcon: Rcon, platform: typeof ARENA.platform): Promise<string[]> {
  const ops: string[] = [];
  const { xMin, xMax, zMin, zMax, topY } = platform;
  for (let x = xMin; x <= xMax; x++) for (let z = zMin; z <= zMax; z++) {
    ops.push(await rcon.send(`setblock ${x} ${topY - 1} ${z} minecraft:stone`));
  }
  return ops;
}

/** 把 Bot 传送到指定脚位并等其落地（分数坐标，记录操作）。 */
async function teleportAndSettle(ctx: HarnessContext, ev: ScenarioEvidence, pos: { x: number; y: number; z: number }, label: string): Promise<void> {
  const op = await teleportTo(ctx.rcon, ctx.bot, pos);
  const extra = (ev.extra ??= {}) as Record<string, unknown>;
  extra.teleports = [...((extra.teleports as unknown[]) ?? []), { label, pos, rconOp: op }];
  await waitFor(() => {
    const st = ctx.adapter.state();
    return st.observationReady && Math.abs(st.pos.y - pos.y) < 0.1 && Math.abs(st.pos.x - pos.x) < 0.5 && Math.abs(st.pos.z - pos.z) < 0.5 && st.onGround;
  }, 20_000, `${label} 落到指定点`);
}

async function teleportTo(rcon: Rcon, bot: Bot, pos: { x: number; y: number; z: number }): Promise<string> {
  return rcon.send(`tp ${bot.username} ${pos.x} ${pos.y} ${pos.z}`);
}

// ---------------------------------------------------------------------------
// 场景运行器外壳
// ---------------------------------------------------------------------------

async function runScenario(
  ctx: HarnessContext,
  body: (d: ScenarioDiag) => Promise<void>,
): Promise<ScenarioEvidence> {
  const ev: ScenarioEvidence = {
    verdict: 'NOT_RUN', startedAt: Date.now(), taskIds: [], results: [],
    frames: [], framesTruncated: false, controlLog: [], controlSnapshots: [], stopSnapshots: [], sampleLog: [], serverCorrections: [],
  };
  const recorder = new FrameRecorder(ctx.bot, () => ctx.arbiter.current?.id ?? null);
  const corrections = new ServerCorrectionRecorder(ctx.bot);
  const diag = new WalkDiagnostics(ctx.adapter, () => ctx.arbiter.current?.id ?? null, () => snapshotKeys(ctx.bot));
  recorder.start();
  corrections.start();
  diag.wrap();
  try {
    await body({ recorder, corrections, diag, ev });
    if (ev.verdict === 'NOT_RUN') ev.verdict = 'PASS';
  } catch (e) {
    ev.verdict = 'FAIL';
    ev.error = (e as Error)?.message ?? String(e);
  } finally {
    // 场景失败也要取消并等待仍未结束的任务，防泄漏到下一场景影响后续判定。
    try {
      const active = ctx.arbiter.info();
      if (active) {
        const done = waitForTask(ctx.arbiter, active.id, 10_000);
        ctx.arbiter.cancel('场景收尾：取消未完成任务');
        await done;
      }
    } catch (ce) {
      ev.cleanupError = (ce as Error)?.message ?? String(ce);
    }
    // 场景失败也要恢复宿主物理与诊断包装（W7 会关 physicsEnabled）。
    ctx.bot.physicsEnabled = true;
    ev.finishedAt = Date.now();
    ev.durationMs = ev.finishedAt - ev.startedAt;
    ev.frames = recorder.frames;
    ev.framesTruncated = recorder.truncated;
    ev.controlLog = diag.controlLog;
    ev.stopSnapshots = diag.stopSnapshots;
    ev.sampleLog = diag.sampleLog;
    ev.serverCorrections = corrections.corrections;
    recorder.stop();
    corrections.stop();
    diag.unwrap();
  }
  return ev;
}

/** 采集一段控制快照（含归属），用于在 stopAll 前后对照。 */
function snapControl(ctx: HarnessContext, label: string, ev: ScenarioEvidence) {
  ev.controlSnapshots.push({ ts: Date.now(), label, keys: snapshotKeys(ctx.bot), ownerTaskId: ctx.arbiter.current?.id ?? null });
}

function waitFor(cond: () => boolean, ms: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (cond()) { clearInterval(iv); resolve(); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error(`超时：${label}`)); }
    }, 50);
  });
}

// ---------------------------------------------------------------------------
// 场景实现（下一阶段补齐场景级断言与容差；此处只采集真实证据骨架）
// ---------------------------------------------------------------------------

/** W1：同高三段相邻 X/Z 转弯，ARRIVED 且容差内，trace 为实测位置。 */
async function scenarioW1(ctx: HarnessContext, d: ScenarioDiag): Promise<void> {
  const ev = d.ev;
  const s = ctx.adapter.state();
  const p = s.pos, y = p.y;
  const route = [
    { x: p.x, y, z: p.z },
    { x: p.x + 1, y, z: p.z },
    { x: p.x + 1, y, z: p.z + 1 },
    { x: p.x + 2, y, z: p.z + 1 },
  ];
  const started = ctx.arbiter.start({ skill: 'walk_route', args: { points: route } }, 'user');
  if (!started || 'error' in started) throw new Error(`W1 启动失败：${started && 'error' in started ? started.error : '未知'}`);
  ev.taskIds.push(started.id);
  const o = await waitForTask(ctx.arbiter, started.id, 60_000);
  ev.results.push(toTaskRecord(o));
  if (o.result.status !== 'succeeded') throw new Error(`W1 未成功：status=${o.result.status} 摘要=${o.result.summary}`);
  const nav = navFromResult(o.result);
  if (!nav || nav.outcome !== 'ARRIVED') throw new Error(`W1 未确认到达：outcome=${nav?.outcome} 摘要=${o.result.summary}`);
  const finalTarget = route[route.length - 1]!;
  const finalPos = nav.lastPosition;
  const err = dist2(finalPos, finalTarget);
  const feetErr = Math.abs(finalPos.y - y);
  if (err > 0.12 || feetErr > 0.05) {
    throw new Error(`W1 到达但超容差：横向 ${err.toFixed(3)} (>0.12) 脚高 ${feetErr.toFixed(3)} (>0.05)`);
  }
  ev.extra = { route, horizontalError: Number(err.toFixed(3)), feetError: Number(feetErr.toFixed(3)), onGroundAtArrival: nav.lastObservation?.onGround };
  ev.verdict = 'PASS';
}

/** W2：受控平台边缘、分数起终点、整条真实轨迹无坠落/失支撑。 */
async function scenarioW2(ctx: HarnessContext, d: ScenarioDiag): Promise<void> {
  const ev = d.ev;
  const platform = ARENA.platform;
  const start = { x: platform.xMin + 0.5, y: platform.topY, z: platform.zMin + 0.5 };
  const target = { x: platform.xMax - 0.5, y: platform.topY, z: platform.zMin + 0.5 };
  const route = adjacentRouteX(start, target);
  ev.extra = { platform, start, target, route, fixtureOps: await buildPlatformFixture(ctx.rcon, platform) };
  await teleportAndSettle(ctx, ev, start, 'W2 平台起点');

  const started = ctx.arbiter.start({ skill: 'walk_route', args: { points: route } }, 'user');
  if (!started || 'error' in started) throw new Error(`W2 启动失败：${started && 'error' in started ? started.error : '未知'}`);
  ev.taskIds.push(started.id);
  const o = await waitForTask(ctx.arbiter, started.id, 60_000);
  ev.results.push(toTaskRecord(o));
  if (o.result.status !== 'succeeded') throw new Error(`W2 未成功：status=${o.result.status} 摘要=${o.result.summary}`);
  const nav = navFromResult(o.result);
  if (!nav || nav.outcome !== 'ARRIVED') throw new Error(`W2 未到达：outcome=${nav?.outcome} 摘要=${o.result.summary}`);
  // 整条轨迹无坠落/失支撑：所有帧脚高不得低于平台顶、且全部 onGround。
  const frames = d.recorder.frames;
  ev.trajectory = summarizeTrajectory(frames);
  const minFeet = (ev.trajectory.minFeetY as number) ?? NaN;
  const airborne = (ev.trajectory.airborneFrames as number) ?? 0;
  if (!Number.isFinite(minFeet) || minFeet < platform.topY - 0.05 || airborne > 0) {
    throw new Error(`W2 轨迹失支撑：minFeetY=${minFeet} airborneFrames=${airborne}`);
  }
  ev.extra = { ...ev.extra, arrival: nav };
  ev.verdict = 'PASS';
}

/** W6：移动中取消并立即交接给新 walk 任务，收集两任务 id 与结果，检查旧回调是否复活/清键。 */
async function scenarioW6(ctx: HarnessContext, d: ScenarioDiag): Promise<void> {
  const ev = d.ev;
  await teleportAndSettle(ctx, ev, WALK_LANE.start, 'W6 步行道起点');
  const s = ctx.adapter.state();
  const p = s.pos, y = p.y;
  const routeA = Array.from({ length: 10 }, (_, i) => ({ x: p.x + i, y, z: p.z }));
  const a = ctx.arbiter.start({ skill: 'walk_route', args: { points: routeA } }, 'user');
  if (!a || 'error' in a) throw new Error(`W6 任务A启动失败：${a && 'error' in a ? a.error : '未知'}`);
  ev.taskIds.push(a.id);
  const aDone = waitForTask(ctx.arbiter, a.id, 60_000);
  const moveStart = ctx.adapter.state().pos;
  await waitFor(() => dist2(ctx.adapter.state().pos, moveStart) > 0.5, 15_000, 'W6 任务A开始移动');

  snapControl(ctx, 'before-arbiter-cancel', ev);
  ctx.arbiter.cancel('W6 取消并交接');
  snapControl(ctx, 'after-arbiter-cancel', ev);

  const routeB = [{ x: p.x, y, z: p.z }, { x: p.x + 1, y, z: p.z }, { x: p.x + 2, y, z: p.z }];
  const b = ctx.arbiter.start({ skill: 'walk_route', args: { points: routeB } }, 'user');
  if (!b || 'error' in b) throw new Error(`W6 任务B启动失败：${b && 'error' in b ? b.error : '未知'}`);
  ev.taskIds.push(b.id);

  const oA = await aDone;
  ev.results.push(toTaskRecord(oA));
  const oB = await waitForTask(ctx.arbiter, b.id, 60_000);
  ev.results.push(toTaskRecord(oB));

  snapControl(ctx, 'after-both-complete', ev);

  if (oA.result.status !== 'cancelled') throw new Error(`W6 任务A未以 cancelled 结束：status=${oA.result.status} 摘要=${oA.result.summary}`);
  if (oB.result.status !== 'succeeded') throw new Error(`W6 任务B未成功：status=${oB.result.status} 摘要=${oB.result.summary}`);
  // 旧回调复活检查：任务 B 完成后，任何归属为任务 A 的 forward=true 写入即为复活/清键。
  const resurrected = d.diag.controlLog.filter((c) => c.op === 'set' && c.name === 'forward' && c.value === true && c.ownerTaskId === a.id);
  ev.extra = { ...ev.extra,
    taskA: a.id, taskB: b.id,
    finalKeys: snapshotKeys(ctx.bot),
    lateOldForwardWrites: resurrected.length,
    injectedOldCallback: false,
    injectionNote: '本轮未注入伪造旧回调；仅观测真实旧任务迟到回调（归属见 controlLog.ownerTaskId）',
  };
  if (resurrected.length > 0) throw new Error(`W6 检测到 ${resurrected.length} 次旧任务A迟到 forward=true（复活/清键）`);
  ev.verdict = 'PASS';
}

/** W7：独立超时、宿主帧交付暂停（标注为宿主注入而非服务端停摆）、移动中真实断线；有界释放。 */
async function scenarioW7(ctx: HarnessContext, d: ScenarioDiag): Promise<void> {
  const ev = d.ev;
  await teleportAndSettle(ctx, ev, WALK_LANE.start, 'W7 步行道起点');
  const s = ctx.adapter.state();
  const y = s.pos.y;

  // 7a：独立超时（短 deadline，有界终止，保留部分位移）。
  const pA = ctx.adapter.state().pos;
  const routeTimeout = Array.from({ length: 8 }, (_, i) => ({ x: pA.x + i, y, z: pA.z }));
  const t = ctx.arbiter.start({ skill: 'walk_route', args: { points: routeTimeout, deadlineMs: 2500 } }, 'user');
  if (!t || 'error' in t) throw new Error(`W7a 启动失败：${t && 'error' in t ? t.error : '未知'}`);
  ev.taskIds.push(t.id);
  const oTimeout = await waitForTask(ctx.arbiter, t.id, 20_000);
  ev.results.push(toTaskRecord(oTimeout));
  ev.extra = { ...ev.extra, timeout: { status: oTimeout.result.status, failureCode: oTimeout.result.failureCode, summary: oTimeout.result.summary, lastPosition: navFromResult(oTimeout.result)?.lastPosition } };

  // 7b：宿主帧交付暂停（宿主注入，非服务端停摆）：关客户端物理后无帧送达，
  // 取消必须不依赖“再来一帧”即可终止并释放控制。
  const pB = ctx.adapter.state().pos;
  const routePause = Array.from({ length: 8 }, (_, i) => ({ x: pB.x + i, y, z: pB.z }));
  const t2 = ctx.arbiter.start({ skill: 'walk_route', args: { points: routePause } }, 'user');
  if (!t2 || 'error' in t2) throw new Error(`W7b 启动失败：${t2 && 'error' in t2 ? t2.error : '未知'}`);
  ev.taskIds.push(t2.id);
  const t2Done = waitForTask(ctx.arbiter, t2.id, 60_000);
  const pauseStart = ctx.adapter.state().pos;
  await waitFor(() => dist2(ctx.adapter.state().pos, pauseStart) > 0.5, 15_000, 'W7b 开始移动');
  snapControl(ctx, 'before-paused-frame-cancel', ev);
  ctx.bot.physicsEnabled = false; // 宿主帧注入：暂停帧交付，服务端仍在运行。
  const pausedAt = ctx.adapter.state().pos;
  ctx.arbiter.cancel('W7 暂停帧后取消');
  const oPause = await t2Done;
  ctx.bot.physicsEnabled = true;
  ev.results.push(toTaskRecord(oPause));
  ev.extra = { ...ev.extra, pausedFrame: { hostInjection: 'bot.physicsEnabled=false（宿主帧注入，非服务端停摆）', status: oPause.result.status, lastPosition: navFromResult(oPause.result)?.lastPosition, pausedAt } };
  if (oPause.result.status !== 'cancelled') throw new Error(`W7b 暂停帧后未以 cancelled 结束：status=${oPause.result.status}`);

  // 7c：移动中真实断线（只断客户端，不动共享服务器）。
  const pC = ctx.adapter.state().pos;
  const routeDisc = Array.from({ length: 8 }, (_, i) => ({ x: pC.x + i, y, z: pC.z }));
  const t3 = ctx.arbiter.start({ skill: 'walk_route', args: { points: routeDisc } }, 'user');
  if (!t3 || 'error' in t3) throw new Error(`W7c 启动失败：${t3 && 'error' in t3 ? t3.error : '未知'}`);
  ev.taskIds.push(t3.id);
  const t3Done = waitForTask(ctx.arbiter, t3.id, 30_000);
  const discStart = ctx.adapter.state().pos;
  await waitFor(() => dist2(ctx.adapter.state().pos, discStart) > 0.5, 15_000, 'W7c 开始移动');
  const lastValid = ctx.adapter.state().pos;
  snapControl(ctx, 'before-client-disconnect', ev);
  ctx.adapter.quit(); // 断客户端并置 stopped，防止场景内自动重连；共享服务器不受影响。
  const oDisc = await t3Done;
  ev.results.push(toTaskRecord(oDisc));
  ev.extra = { ...ev.extra, disconnect: { status: oDisc.result.status, lastValidMeasuredPosition: lastValid, summary: oDisc.result.summary } };
  ev.verdict = 'PASS';
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/** 等待 spawn，超时/断线都清理监听器与定时器（不留悬挂句柄）。 */
function waitForSpawn(adapter: MineflayerAdapter, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = () => { cleanup(); resolve(); };
    const onDisconnect = (reason: string) => { cleanup(); reject(new Error(`spawn 前断线：${reason}`)); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('spawn 超时')); }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      adapter.removeListener('spawn', onSpawn);
      adapter.removeListener('disconnected', onDisconnect);
    };
    adapter.on('spawn', onSpawn);
    adapter.on('disconnected', onDisconnect);
  });
}

/** 有界等待自己的 Bot 客户端真正结束（quit 后 bot 'end' → disconnected），超时按诊断超时处理。 */
function quitClient(adapter: MineflayerAdapter, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (!adapter.bot) { resolve(); return; }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      adapter.removeListener('disconnected', onDisconnected);
      resolve();
    };
    const onDisconnected = () => finish();
    const timer = setTimeout(finish, timeoutMs);
    adapter.on('disconnected', onDisconnected);
    adapter.quit();
  });
}

interface CleanupError { step: string; message: string }

function errorMessage(e: unknown): string {
  return (e as Error)?.message ?? String(e);
}

async function main() {
  if (config.mode !== 'test') throw new Error(`联机验收只允许在 test 环境运行，当前 ${config.mode}`);

  const selector = parseScenarioSelector(process.argv.find((a) => a.startsWith('--scenarios='))?.slice('--scenarios='.length));
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const evidenceDir = path.join(config.dataDir, 'walk-acceptance', runId);
  fs.mkdirSync(evidenceDir, { recursive: true });

  const evidence: Record<string, unknown> = {
    schema: 'walk-acceptance',
    provisional: true,
    provisionalNote: '联机验收结果仍为 provisional，待协调者最终 C 证据确认后裁定，不自动宣告 M2 完成',
    mode: config.mode,
    worldId: config.memory.worldId,
    runId,
    startedAt: Date.now(),
    host: {
      mcHost: config.mc.host, mcPort: config.mc.port, username: config.mc.username, version: config.mc.version,
      rconHost: config.observer.rconHost, rconPort: config.observer.rconPort,
      dataDir: config.dataDir,
    },
    arena: ARENA,
    scenarios: {} as Record<ScenarioId, ScenarioEvidence | { verdict: Verdict; note?: string }>,
  };

  const cleanupErrors: CleanupError[] = [];
  let adapter: MineflayerAdapter | null = null;
  let rcon: Rcon | null = null;
  let memory: WorldMemory | null = null;

  try {
    // 源元数据先校验：git 失败或包来源不一致都 fail（写进 fatalError → 失败退出）。
    evidence.commit = gitMeta();
    evidence.package = packageMeta();

    const bus = new EventBus();
    adapter = new MineflayerAdapter(config, bus);
    const vision = new Vision(adapter, config.vision);
    // runId 隔离记忆路径：不覆盖现有 world-memory。
    memory = new WorldMemory(path.join(evidenceDir, 'world-memory.json'));
    const arbiter = new Arbiter(adapter, memory, bus, vision);
    rcon = new Rcon(config.observer.rconHost, config.observer.rconPort, config.observer.rconPassword);

    const expected = new Set([config.observer.player, ...config.observer.admins, config.mc.username].filter(Boolean));

    // RCON 预检：确认无意外在线者 / 重复 Bot 后再启动 Bot；畸形 list 响应在此 fail closed。
    const preflight = await rconPreflight(rcon, expected);
    evidence.preflight = preflight;
    if (!preflight.ok) throw new Error(`RCON 预检未通过：重复Bot=${preflight.duplicateBot} 意外在线=${JSON.stringify(preflight.unexpected)} 在线=${JSON.stringify(preflight.occupants)}`);

    const spawnPromise = waitForSpawn(adapter, 30_000);
    adapter.connect();
    await spawnPromise;
    await waitFor(() => adapter!.state().observationReady, 30_000, 'observationReady');

    const ctx: HarnessContext = { bot: adapter.bot as Bot, adapter, arbiter, rcon, evidenceDir, runId };
    const scenarioMap: Partial<Record<ScenarioId, (c: HarnessContext, d: ScenarioDiag) => Promise<void>>> = {
      W1: scenarioW1, W2: scenarioW2, W6: scenarioW6, W7: scenarioW7,
    };

    for (const id of ALL_SCENARIOS) {
      if (id === 'W3') { (evidence.scenarios as Record<string, unknown>).W3 = { verdict: 'NOT_RUN', note: '引用 C1 离线 irregular 子步矩阵证据，本轮不联机运行' }; continue; }
      if (id === 'W4' || id === 'W5') { (evidence.scenarios as Record<string, unknown>)[id] = { verdict: 'NOT_RUN', note: '留待下一阶段' }; continue; }
      if (!selector.includes(id)) { (evidence.scenarios as Record<string, unknown>)[id] = { verdict: 'NOT_RUN', note: '未选择' }; continue; }
      (evidence.scenarios as Record<string, unknown>)[id] = await runScenario(ctx, (d) => scenarioMap[id]!(ctx, d));
    }
  } catch (e) {
    evidence.fatalError = errorMessage(e);
  } finally {
    // 清理只关自己的 Bot/RCON/记忆：逐项尝试，失败记为结构化清理错误而非静默吞掉。
    if (adapter?.bot) { try { (adapter.bot as Bot).physicsEnabled = true; } catch (e) { cleanupErrors.push({ step: 'restore-physics', message: errorMessage(e) }); } }
    if (adapter) { try { await quitClient(adapter, 5000); } catch (e) { cleanupErrors.push({ step: 'quit-client', message: errorMessage(e) }); } }
    if (rcon) { try { rcon.close(); } catch (e) { cleanupErrors.push({ step: 'close-rcon', message: errorMessage(e) }); } }
    if (memory) { try { memory.close(); } catch (e) { cleanupErrors.push({ step: 'close-memory', message: errorMessage(e) }); } }
  }

  const scenariosOk = Object.values(evidence.scenarios as Record<ScenarioId, ScenarioEvidence | { verdict: Verdict }>)
    .every((s) => s.verdict !== 'FAIL');
  evidence.finishedAt = Date.now();
  if (cleanupErrors.length) evidence.cleanupErrors = cleanupErrors;
  evidence.ok = evidence.fatalError === undefined && scenariosOk && cleanupErrors.length === 0;

  const file = path.join(evidenceDir, 'evidence.json');
  fs.writeFileSync(file, JSON.stringify(evidence, null, 2) + '\n');
  console.log(`[accept] 证据已保存：${file}`);

  // 用 process.exitCode（而非 process.exit）反映整体结果，让事件循环自然排空、不掩盖未收尾工作。
  process.exitCode = evidence.ok ? 0 : 1;
}

async function run() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('用法：node --import tsx scripts/walk-acceptance.ts --curio=test [--scenarios=W1,W2,W6,W7] [--help]');
    console.log('场景：W1 到达转弯 / W2 平台边缘 / W6 取消交接 / W7 超时·暂停帧·断线（W4/W5 下一阶段，W3 引用离线证据）');
    return;
  }
  await main();
}

if (isDirectRun()) {
  run().catch((e) => {
    console.error(`[accept] 致命错误：${(e as Error)?.message ?? e}`);
    process.exitCode = 1;
  });
}
