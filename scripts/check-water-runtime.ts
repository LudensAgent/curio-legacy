/**
 * 水面/游泳联机验收：连接 test 服务器，用真实 MineflayerAdapter + Arbiter + Vision + WorldMemory(null)。
 *
 *   运行：node --import tsx scripts/check-water-runtime.ts --curio=test --source 80.5,66,80.5 --east 90.5,70,80.5 --west 76.5,70,80.5
 *
 * 只读/只游，不挖、不放、不绕路，不发管理命令、不改世界。任一场景失败即以非 0 退出码结束。
 * 坐标由操作员显式给出（含小数/负值均可），脚本不取整、不假设默认高度、不传送。
 *
 * 已核实的夹具契约（root 已实际建造并验证，证据见 /path/to/curio/test-setver/curio-data/logs/joint-20261104-131039/fluid-fixture.json，本脚本不读不写该文件）：
 *   - 池底 y=65；内部水体 x77..89,z77..85,y66..69；边界墙高至 y=69；其上为空气。
 *   - 水下起点 source=(80.5,66,80.5)（站立于池底、全身浸没、头部在水下）。
 *   - 东岸干地目标 east=(90.5,70,80.5)；西岸可游回目标 west=(76.5,70,80.5)。
 * 预留池以“方块格”表示 x76..90,z76..86，故物理脚位 x 合法区间为 [76,91)、z 为 [76,87)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { config } from '../src/config.ts';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { Vision } from '../src/perception/vision.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { EventBus } from '../src/events.ts';

// ------------------------------------------------------------------ 参数与夹具契约
const RESERVED = { xMin: 76, xMaxExclusive: 91, zMin: 76, zMaxExclusive: 87 };
const FIXTURE_NEAR = 2.0;
const FIXTURE_TIMEOUT_MS = 180_000;
const W1_SURFACED_STABLE_MS = 600; // 独立判定「头部稳定露出流体」的最短连续时长（真实 ts 差，非采样次数乘间隔）
const W2_STABILITY_MS = 400; // W2 到达后连续站稳观测窗口的最短真实跨度（真实 ts 差）
const KEYS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'] as const;

// 归一化接触判定用的流体/空气方块名（仅本脚本的测试判据，非 Agent 感知、非远程地图事实）。
const FLUID_NAMES = new Set(['water', 'lava', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass']);
const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);

/** 单次自身身体归一化接触快照（测试判据，不暴露精确方块名/属性）。 */
type ContactSample = {
  oracle: true;
  ts: number;
  label: string;
  pos: { x: number; y: number; z: number };
  oxygen: number;
  bodyInWater: boolean;
  bodyInLava: boolean;
  onGround: boolean;
  headInFluid: boolean;
  headInAir: boolean;
  observationReady: boolean;
  alive: boolean;
  controls: Record<string, boolean>;
};

/** 动作期物理采样句柄：跟随真实 physicsTick，回调失败记入 error，stop 移除监听。 */
type TraceHandle = { samples: ContactSample[]; error: string | null; stop: () => void };

const argv = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

function parseXYZ(raw: string | undefined, label: string): { x: number; y: number; z: number } {
  if (!raw) throw new Error(`缺少 --${label} 坐标参数（格式 "x,y,z"，可含小数/负值）`);
  const parts = raw.split(/[, ]+/).filter(Boolean).map(Number);
  if (parts.length !== 3 || !parts.every(Number.isFinite)) throw new Error(`--${label} 需要三个有限数值（x,y,z），收到：${raw}`);
  return { x: parts[0], y: parts[1], z: parts[2] };
}

function inReserved(p: { x: number; z: number }): boolean {
  return p.x >= RESERVED.xMin && p.x < RESERVED.xMaxExclusive && p.z >= RESERVED.zMin && p.z < RESERVED.zMaxExclusive;
}

function checkCoord(p: { x: number; y: number; z: number }, label: string): void {
  if (!inReserved(p)) throw new Error(`--${label} 超出预留池物理区间 x[${RESERVED.xMin},${RESERVED.xMaxExclusive}),z[${RESERVED.zMin},${RESERVED.zMaxExclusive})：(${p.x},${p.y},${p.z})`);
}

// ------------------------------------------------------------------ 结果与退出
const results: Record<string, unknown> = { mode: config.mode, worldId: config.memory.worldId, host: config.mc.host, port: config.mc.port, startedAt: Date.now() };
const taskOutcomes: Record<string, unknown> = {};
results.taskOutcomes = taskOutcomes;

function writeResults(): void {
  const dir = path.join(config.dataDir, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date(results.startedAt as number).toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `check-water-runtime-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(results, null, 2) + '\n');
  console.log(`[water-check] 结果已保存：${file}`);
}

function log(ev: Record<string, unknown>): void {
  console.log(JSON.stringify(ev));
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitFor(cond: () => boolean, ms: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (cond()) { clearInterval(iv); resolve(); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error(`超时：${label}`)); }
    }, 100);
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`超时：${label}`)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

/** 只读 git 版本信息（不含任何凭据）；读取失败抛出清晰错误，绝不返回空/伪造哈希。 */
function readGitSha(rev: string): string {
  try {
    const out = execFileSync('git', ['-c', `safe.directory=${process.cwd()}`, 'rev-parse', rev], { encoding: 'utf8', cwd: process.cwd() });
    const v = out.trim();
    if (!v) throw new Error('空输出');
    return v;
  } catch (e) {
    throw new Error(`无法读取 git 版本信息（${rev}）：${(e as Error).message ?? String(e)}`);
  }
}

/** 独立读取自身 7 个控制键：读不到任一键就失败，绝不退回“空即全 false”的假通过。 */
function sampleControls(ad: MineflayerAdapter): Record<string, boolean> {
  const b = ad.bot;
  if (!b || typeof b.getControlState !== 'function') throw new Error('无法读取 bot 按键状态（getControlState 缺失）');
  const out: Record<string, boolean> = {};
  for (const k of KEYS) {
    const v = b.getControlState(k);
    if (typeof v !== 'boolean') throw new Error(`无法读取按键 ${k} 的布尔状态`);
    out[k] = v;
  }
  return out;
}

/** 归一化接触事实（测试判据）：只暴露自身身体的本体/接触判定布尔，不暴露精确方块名/属性。 */
function contact(ad: MineflayerAdapter, label: string): ContactSample {
  const s = ad.state();
  const head = ad.blockAt({ x: Math.floor(s.pos.x), y: Math.floor(s.pos.y + 1.62), z: Math.floor(s.pos.z) });
  return {
    oracle: true,
    ts: Date.now(), label,
    pos: { x: s.pos.x, y: s.pos.y, z: s.pos.z },
    oxygen: s.oxygen,
    bodyInWater: s.inWater,
    bodyInLava: s.inLava,
    onGround: s.onGround,
    headInFluid: FLUID_NAMES.has(head ?? ''),
    headInAir: AIR_NAMES.has(head ?? ''),
    observationReady: s.observationReady,
    alive: s.alive,
    controls: sampleControls(ad),
  };
}

/** 动作期物理采样：跟随 bot 真实 physicsTick，观测紧跟真实物理，不用“采样次数×名义间隔”折算时长。 */
function startPhysicsTrace(ad: MineflayerAdapter): TraceHandle {
  const b = ad.bot;
  if (!b || typeof b.on !== 'function' || typeof b.off !== 'function') throw new Error('无法安装物理采样监听（bot 缺失 on/off）');
  const samples: ContactSample[] = [];
  let error: string | null = null;
  let stopped = false;
  const onTick = () => {
    try {
      samples.push(contact(ad, 'trace'));
    } catch (e) {
      error = (e as Error).message ?? String(e);
    }
  };
  b.on('physicsTick', onTick);
  return { samples, get error() { return error; }, stop: () => { if (!stopped) { stopped = true; b.off('physicsTick', onTick); } } };
}

async function main(): Promise<void> {
  if (config.mode !== 'test') {
    console.error('[water-check] 失败：联机验收只允许在 test 环境运行，不写任何证据文件、不创建适配器');
    process.exitCode = 1;
    return;
  }

  const outcomes = new Map<string, TaskOutcome>();
  const outcomeWaiters = new Map<string, { resolve: (o: TaskOutcome) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  let adapter: MineflayerAdapter | null = null;
  let memory: WorldMemory | null = null;
  let arbiter: Arbiter | null = null;
  let onDone: ((o: TaskOutcome) => void) | null = null;
  let spawnCleanup: () => void = () => {};
  let restoreControls: (() => void) | null = null;
  let w1Trace: TraceHandle | null = null;
  let w2Trace: TraceHandle | null = null;
  const scenario1: Record<string, unknown> = {};
  const scenario2: Record<string, unknown> = {};
  const scenario3: Record<string, unknown> = {};

  try {
    results.head = readGitSha('HEAD');
    results.scriptBlob = readGitSha('HEAD:scripts/check-water-runtime.ts');

    const source = parseXYZ(option('--source'), 'source');
    const east = parseXYZ(option('--east'), 'east');
    const west = parseXYZ(option('--west'), 'west');
    checkCoord(source, 'source');
    checkCoord(east, 'east');
    checkCoord(west, 'west');
    results.fixture = { source, east, west, contract: '池底 y65；水体 x77..89,z77..85,y66..69；边界墙至 y69；其上空气；source 水下浸没、east 东岸干地、west 西岸可游回' };

    const bus = new EventBus();
    const ad = new MineflayerAdapter(config, bus);
    adapter = ad;
    const vision = new Vision(ad, config.vision);
    const mem = new WorldMemory(null);
    memory = mem;
    const ar = new Arbiter(ad, mem, bus, vision);
    arbiter = ar;

    // 玩家列表诊断：bot.players 缺失或自身用户名未知时视为「不可用」，绝不当作「没有其他玩家」。
    const playerList = (): { available: boolean; others: string[] } => {
      const b = ad.bot;
      const own = b && typeof b.username === 'string' && b.username ? String(b.username) : '';
      const players = b && typeof b.players === 'object' && b.players !== null ? b.players : null;
      if (!own || players === null) return { available: false, others: [] };
      return { available: true, others: Object.keys(players).filter((name) => name !== own) };
    };
    const assertNoOtherPlayers = (stage: string): void => {
      const status = playerList();
      if (!status.available) throw new Error(`${stage}：无法获取有效玩家列表诊断（bot.players 缺失或自身用户名未知），未执行动作`);
      if (status.others.length) throw new Error(`${stage}：服务器上仍有其他玩家 ${status.others.join('、')}，未执行动作`);
    };

    // 提前挂上 done 监听（先于任何 start），把完整 TaskOutcome 立即落到输出（含 result.data 局部位置/氧气/surfaced/landed 与 task.args/startedAt/deadline），再按 taskId 匹配 resolve waiter。
    const done = (o: TaskOutcome) => {
      taskOutcomes[o.task.id] = { receivedAt: Date.now(), outcome: o };
      outcomes.set(o.task.id, o);
      const w = outcomeWaiters.get(o.task.id);
      if (w) { clearTimeout(w.timer); outcomeWaiters.delete(o.task.id); w.resolve(o); }
    };
    onDone = done;
    ar.on('done', done);

    const startTask = (step: { skill: string; args?: unknown }, timeoutMs: number): { taskId: string; outcome: Promise<TaskOutcome> } => {
      const started = ar.start(step, 'user');
      if ('error' in started) throw new Error(`任务 ${step.skill} 启动失败：${started.error}`);
      const taskId = started.id;
      const outcome = new Promise<TaskOutcome>((resolve, reject) => {
        const existing = outcomes.get(taskId);
        if (existing) { resolve(existing); return; }
        const timer = setTimeout(() => { outcomeWaiters.delete(taskId); reject(new Error(`等待 ${step.skill} 任务 ${taskId} 结果超时`)); }, timeoutMs);
        outcomeWaiters.set(taskId, { resolve, reject, timer });
      });
      return { taskId, outcome };
    };

    log({ event: 'water_connect', host: config.mc.host, port: config.mc.port, username: config.mc.username, worldId: config.memory.worldId });

    const spawned = new Promise<void>((resolve, reject) => {
      const onSpawn = () => { cleanup(); resolve(); };
      const onDisc = (reason: string) => { cleanup(); reject(new Error(`spawn 前断线：${reason}`)); };
      const cleanup = () => { ad.off('spawn', onSpawn); ad.off('disconnected', onDisc); };
      spawnCleanup = cleanup;
      ad.on('spawn', onSpawn);
      ad.on('disconnected', onDisc);
    });
    ad.connect();
    await withTimeout(spawned, 30_000, 'spawn');
    await waitFor(() => ad.state().observationReady, 30_000, 'observationReady');

    const startState = ad.state();
    log({ event: 'water_spawned', pos: startState.pos, dim: startState.dim });

    log({ event: 'water_fixture_waiting', required: `在预留池 x[76,91),z[76,87) 内布置池塘：池底 y65、水体 x77..89,z77..85,y66..69、边界墙至 y69、其上空气；将 bot 放到水下起点 (${source.x},${source.y},${source.z})（身体与头部均浸没）。脚本不执行管理命令。`, source, east, west });
    const fixtureDeadline = Date.now() + FIXTURE_TIMEOUT_MS;
    while (true) {
      const s = ad.state();
      const head = ad.blockAt({ x: Math.floor(s.pos.x), y: Math.floor(s.pos.y + 1.62), z: Math.floor(s.pos.z) });
      const headInFluid = FLUID_NAMES.has(head ?? '');
      const dx = s.pos.x - source.x, dy = s.pos.y - source.y, dz = s.pos.z - source.z;
      const near = Math.hypot(dx, dz) <= FIXTURE_NEAR && Math.abs(dy) <= FIXTURE_NEAR;
      const pl = playerList();
      const reasons = [
        ...(s.observationReady ? [] : ['observationReady 未就绪']),
        ...(s.connected ? [] : ['未连接']),
        ...(s.alive ? [] : ['未存活']),
        ...(s.inWater ? [] : ['身体不在水中']),
        ...(headInFluid ? [] : ['头部未浸没（head 格非流体）']),
        ...(near ? [] : [`位置偏离水下起点 ${Math.round(Math.hypot(dx, dz) * 10) / 10} 格`]),
        ...(pl.available ? [] : ['玩家列表诊断不可用']),
        ...(pl.others.length ? [`服务器上有其他玩家 ${pl.others.join('、')}`] : []),
      ];
      if (reasons.length === 0) break;
      if (Date.now() > fixtureDeadline) throw new Error(`等待水域夹具超时：${reasons.join('；')}（当前 ${s.pos.x.toFixed(2)},${s.pos.y.toFixed(2)},${s.pos.z.toFixed(2)}，inWater=${s.inWater}，headInFluid=${headInFluid}）`);
      await sleepMs(200);
    }
    results.fixtureReady = contact(ad, 'fixture');
    assertNoOtherPlayers('夹具就绪后');

    // ---- W1：surface 一次有界上浮 ----
    assertNoOtherPlayers('W1 前');
    const w1Start = contact(ad, 'w1_start');
    scenario1.taskId = null;
    scenario1.requested = { skill: 'surface', args: {} };
    scenario1.start = w1Start;
    scenario1.startedAt = Date.now();
    scenario1.status = 'pending';
    results.scenario1 = scenario1;
    const w1 = startTask({ skill: 'surface', args: {} }, 40_000);
    scenario1.taskId = w1.taskId;

    const tr1 = startPhysicsTrace(ad);
    w1Trace = tr1;
    scenario1.trace = tr1.samples; // 立即挂上（活引用）：失败路径也保留已采样样本
    const o1 = await w1.outcome;
    const w1Completion = contact(ad, 'w1_completion'); // 结果返回后立即采样，早于任何清理等待
    tr1.stop();
    w1Trace = null;
    scenario1.completion = w1Completion;
    scenario1.status = o1.result.status;
    scenario1.summary = o1.result.summary;
    const w1surfaced = Boolean(o1.result.data?.surfaced);
    const w1landed = Boolean(o1.result.data?.landed);
    scenario1.surfaced = w1surfaced;
    scenario1.landed = w1landed;
    scenario1.durationMs = o1.durationMs;
    scenario1.traceError = tr1.error;

    let finalAirStart: number | null = null;
    if (tr1.samples.length && tr1.samples[tr1.samples.length - 1].headInAir) {
      let i = tr1.samples.length - 1;
      while (i > 0 && tr1.samples[i - 1].headInAir) i--;
      finalAirStart = tr1.samples[i].ts;
    }
    const surfacedDurationMs = (w1Completion.headInAir && finalAirStart !== null) ? w1Completion.ts - finalAirStart : 0;
    const surfacedIndependent = surfacedDurationMs >= W1_SURFACED_STABLE_MS;
    const everLanded = tr1.samples.some((t) => t.onGround && !t.bodyInWater && !t.bodyInLava);
    scenario1.surfacedDurationMs = surfacedDurationMs;
    scenario1.surfacedIndependent = surfacedIndependent;
    scenario1.everLanded = everLanded;
    scenario1.traceSampleCount = tr1.samples.length;

    const w1AfterRelease = contact(ad, 'w1_after_release');
    scenario1.afterRelease = w1AfterRelease;
    log({ event: 'water_w1', status: o1.result.status, surfaced: w1surfaced, landed: w1landed, surfacedIndependent, surfacedDurationMs, everLanded, traceError: tr1.error });

    if (tr1.error) throw new Error(`W1 物理采样回调失败：${tr1.error}`);
    if (o1.result.status !== 'succeeded' || !w1surfaced || w1landed) {
      throw new Error(`W1 surface 未满足 surfaced:true/landed:false：status=${o1.result.status} surfaced=${w1surfaced} landed=${w1landed} 摘要=${o1.result.summary}`);
    }
    if (!surfacedIndependent) throw new Error(`W1 surface 未独立观察到头部稳定露出流体持续到完成（需 ≥${W1_SURFACED_STABLE_MS}ms，实测 ${surfacedDurationMs}ms）`);
    if (everLanded) throw new Error('W1 surface 独立观察到上岸（landed），与「只浮出、不找岸」不符');

    // ---- W2：swim_to 到东岸干地目标（精确坐标，不取整） ----
    assertNoOtherPlayers('W2 前');
    const w2Start = contact(ad, 'w2_start');
    scenario2.taskId = null;
    scenario2.requested = { skill: 'swim_to', args: { xyz: [east.x, east.y, east.z] } };
    scenario2.target = east;
    scenario2.start = w2Start;
    scenario2.startedAt = Date.now();
    scenario2.status = 'pending';
    results.scenario2 = scenario2;
    const w2 = startTask({ skill: 'swim_to', args: { xyz: [east.x, east.y, east.z] } }, 40_000);
    scenario2.taskId = w2.taskId;

    const o2 = await w2.outcome;
    const w2Finish = contact(ad, 'w2_finish');
    scenario2.finish = w2Finish; // 400ms 观测窗口之前先落盘结果/完成快照
    scenario2.status = o2.result.status;
    scenario2.summary = o2.result.summary;
    scenario2.durationMs = o2.durationMs;
    scenario2.landedBySkill = o2.result.status === 'succeeded' && Boolean(o2.result.data?.landed);
    scenario2.skillSurfaced = Boolean(o2.result.data?.surfaced);

    const errOf = (p: { x: number; y: number; z: number }) => ({ horizontal: Math.hypot(p.x - east.x, p.z - east.z), vertical: Math.abs(p.y - east.y) });
    const dryOf = (c: { onGround: boolean; bodyInWater: boolean; bodyInLava: boolean; headInAir: boolean }) => c.onGround && !c.bodyInWater && !c.bodyInLava && c.headInAir;
    const withinOf = (p: { x: number; y: number; z: number }) => { const e = errOf(p); return e.horizontal <= 1 && e.vertical <= 1.5; };

    const tr2 = startPhysicsTrace(ad);
    w2Trace = tr2;
    scenario2.stabilityTrace = tr2.samples; // 立即挂上（活引用）
    await sleepMs(W2_STABILITY_MS);
    tr2.stop();
    w2Trace = null;
    const w2Stable = contact(ad, 'w2_stable');

    // 连续观测窗口 = 完成快照 + 中间物理样本 + 稳定端快照；全部须干地且在容差内，且真实跨度 ≥ W2_STABILITY_MS。
    const windowSamples: ContactSample[] = [w2Finish, ...tr2.samples, w2Stable];
    const windowSpanMs = windowSamples[windowSamples.length - 1].ts - windowSamples[0].ts;
    const windowDry = windowSamples.every((s) => dryOf(s) && withinOf(s.pos));
    const errFinish = errOf(w2Finish.pos);
    const errStable = errOf(w2Stable.pos);
    scenario2.requestedStabilityMs = W2_STABILITY_MS;
    scenario2.windowSpanMs = windowSpanMs;
    scenario2.windowDry = windowDry;
    scenario2.windowSamples = windowSamples;
    scenario2.finishErr = { horizontal: Number(errFinish.horizontal.toFixed(3)), vertical: Number(errFinish.vertical.toFixed(3)) };
    scenario2.stable = { ...w2Stable, horizontal: Number(errStable.horizontal.toFixed(3)), vertical: Number(errStable.vertical.toFixed(3)) };
    scenario2.traceError = tr2.error;
    log({ event: 'water_w2', status: o2.result.status, landedBySkill: scenario2.landedBySkill, skillSurfaced: scenario2.skillSurfaced, windowSpanMs, windowDry, traceError: tr2.error });

    if (tr2.error) throw new Error(`W2 物理采样回调失败：${tr2.error}`);
    if (!scenario2.landedBySkill || !scenario2.skillSurfaced || !windowDry || windowSpanMs < W2_STABILITY_MS) {
      throw new Error(`W2 swim_to 未在连续站稳窗口（真实跨度 ${windowSpanMs}ms，需 ≥${W2_STABILITY_MS}ms）满足干地且容差：status=${o2.result.status} landed=${scenario2.landedBySkill} surfaced=${scenario2.skillSurfaced} 连续站稳=${windowDry} 摘要=${o2.result.summary}`);
    }

    // ---- W3：从干岸游向对岸，进入水体并水平移动后取消 ----
    assertNoOtherPlayers('W3 前');
    const w3Start = contact(ad, 'w3_start');
    scenario3.taskId = null;
    scenario3.requested = { skill: 'swim_to', args: { xyz: [west.x, west.y, west.z] } };
    scenario3.target = west;
    scenario3.start = w3Start;
    scenario3.startedAt = Date.now();
    scenario3.status = 'pending';
    results.scenario3 = scenario3;
    const w3 = startTask({ skill: 'swim_to', args: { xyz: [west.x, west.y, west.z] } }, 40_000);
    scenario3.taskId = w3.taskId;
    // W3 结果承诺可能因下方进入水体等待提前抛错而被弃用；立即挂上拒绝处理器，避免其 40s 超时拒绝成为未处理拒绝。
    w3.outcome.catch(() => {});

    // 进入水体等待：等待期间持续采样实际接触/最后观测位置，而非只有起始信封。
    const w3EntrySamples: ContactSample[] = [];
    scenario3.entryWaitSamples = w3EntrySamples;
    const w3EntryDeadline = Date.now() + 20_000;
    while (true) {
      const s = ad.state();
      if (s.inWater && Math.hypot(s.pos.x - w3Start.pos.x, s.pos.z - w3Start.pos.z) > 0.5) break;
      try { w3EntrySamples.push(contact(ad, 'w3_entry_wait')); } catch (e) { scenario3.entryWaitSampleError = (e as Error).message ?? String(e); }
      if (Date.now() > w3EntryDeadline) throw new Error('超时：swim_to 进入水体并水平移动');
      await sleepMs(100);
    }
    scenario3.enteredWater = true;
    const w3PreCancel = contact(ad, 'w3_pre_cancel');
    scenario3.preCancel = w3PreCancel;

    // 脚本级按键写入仪表：只包裹现有 bot.setControlState/clearControlStates，记录迟到窗口内的真实写入/清除；不改生产、不引入新 API/类型。
    const bot = ad.bot;
    if (!bot || typeof bot.setControlState !== 'function' || typeof bot.clearControlStates !== 'function') throw new Error('无法安装脚本级按键写入仪表（bot 缺少 setControlState/clearControlStates）');
    const origSet: (name: string, value: boolean) => void = bot.setControlState;
    const origClear: () => void = bot.clearControlStates;
    let seq = 0;
    let recording = false;
    const lateWrites: { seq: number; ts: number; key: string; value: boolean }[] = [];
    const lateClears: { seq: number; ts: number }[] = [];
    scenario3.lateWrites = lateWrites; // 任何 fallible await 之前先挂上（活引用）
    scenario3.lateClears = lateClears;
    bot.setControlState = function (name: string, value: boolean): void {
      if (recording) lateWrites.push({ seq: ++seq, ts: Date.now(), key: name, value });
      origSet.call(bot, name, value);
    };
    bot.clearControlStates = function (): void {
      if (recording) lateClears.push({ seq: ++seq, ts: Date.now() });
      origClear.call(bot);
    };
    restoreControls = () => {
      const errors: string[] = [];
      try { bot.setControlState = origSet; } catch (e) { errors.push((e as Error).message ?? String(e)); }
      try { bot.clearControlStates = origClear; } catch (e) { errors.push((e as Error).message ?? String(e)); }
      if (errors.length) throw new Error(errors.join('；'));
    };
    ar.cancel('联机验收取消'); // 同步 stopAll 释放控制（合法取消，不在仪表窗口内）
    scenario3.cancelBoundary = { seq, ts: Date.now(), note: '同步 ar.cancel 后立即记录；迟到事件 seq 均大于此边界' };
    const w3KeysAtCancel = sampleControls(ad); // 取消后、任何后续清理前立即读取全部 7 键
    const anyKeyAtCancel = KEYS.some((k) => w3KeysAtCancel[k]);
    scenario3.keysAtCancel = w3KeysAtCancel;
    recording = true; // 迟到窗口起点：合法 stopAll 之后
    const lateKeySamples: { ts: number; controls: Record<string, boolean> }[] = [];
    scenario3.lateKeySamples = lateKeySamples; // 任何 fallible await 之前先挂上
    const o3 = await w3.outcome;
    for (let i = 0; i < 12; i++) {
      await sleepMs(100);
      lateKeySamples.push({ ts: Date.now(), controls: sampleControls(ad) });
    }
    recording = false;
    const reactivated = lateKeySamples.some((s) => KEYS.some((k) => s.controls[k]));
    const w3Finish = contact(ad, 'w3_finish');
    scenario3.status = o3.result.status;
    scenario3.summary = o3.result.summary;
    scenario3.anyKeyAtCancel = anyKeyAtCancel;
    scenario3.reactivated = reactivated;
    scenario3.finish = w3Finish;
    scenario3.durationMs = o3.durationMs;
    scenario3.drift = { horizontal: Number(Math.hypot(w3Finish.pos.x - w3PreCancel.pos.x, w3Finish.pos.z - w3PreCancel.pos.z).toFixed(3)), vertical: Number((w3Finish.pos.y - w3PreCancel.pos.y).toFixed(3)), note: '取消后的物理漂移/重力，非按键复活' };
    log({ event: 'water_w3', status: o3.result.status, anyKeyAtCancel, lateWrites: lateWrites.length, lateClears: lateClears.length, reactivated, summary: o3.result.summary });
    if (o3.result.status !== 'cancelled') throw new Error(`W3 取消后任务未以 cancelled 结束：status=${o3.result.status} 摘要=${o3.result.summary}`);
    if (anyKeyAtCancel || reactivated || lateWrites.length || lateClears.length) {
      throw new Error(`W3 取消后仍有按键被按住/复活或迟到写入/清除：anyKeyAtCancel=${anyKeyAtCancel} reactivated=${reactivated} lateWrites=${lateWrites.length} lateClears=${lateClears.length}`);
    }

    results.ok = true;
    results.finishedAt = Date.now();
    log({ event: 'water_done', ok: true });
  } catch (e) {
    results.failed = (e as Error).message ?? String(e);
    results.failedAt = Date.now();
  } finally {
    const cleanupErrors: string[] = [];

    // 清理前记录带标签的最终诊断接触（不覆盖任何既有事实样本）。
    try {
      if (adapter && adapter.state().observationReady) results.finalDiagnostic = contact(adapter, 'final_diagnostic');
    } catch (e) { cleanupErrors.push(`最终诊断接触失败：${(e as Error).message ?? String(e)}`); }

    // 失败路径仍未记录 trace 回调错误时补记到输出。
    try { if (w1Trace?.error) scenario1.traceError = w1Trace.error; } catch (e) { cleanupErrors.push(`记录 W1 采样错误失败：${(e as Error).message ?? String(e)}`); }
    try { if (w2Trace?.error) scenario2.traceError = w2Trace.error; } catch (e) { cleanupErrors.push(`记录 W2 采样错误失败：${(e as Error).message ?? String(e)}`); }

    // 停止动作期采样监听、还原仪表。
    try { w1Trace?.stop(); } catch (e) { cleanupErrors.push(`停止 W1 采样失败：${(e as Error).message ?? String(e)}`); }
    try { w2Trace?.stop(); } catch (e) { cleanupErrors.push(`停止 W2 采样失败：${(e as Error).message ?? String(e)}`); }
    try { restoreControls?.(); } catch (e) { cleanupErrors.push(`还原按键仪表失败：${(e as Error).message ?? String(e)}`); }

    // 取消活动任务并收集其匹配 TaskOutcome（有界），先于移除 done 监听/清 waiter。
    // 用窄作用域、按 taskId 过滤的额外 done 监听收集结果，不覆盖 startTask 已挂的 waiter/40s 定时器。
    try {
      if (arbiter) {
        const ar = arbiter;
        const active = ar.info();
        if (active) {
          const activeId = active.id;
          let cleanupDone: ((o: TaskOutcome) => void) | null = null;
          let cleanupTimer: NodeJS.Timeout | null = null;
          const activeOutcome = new Promise<TaskOutcome>((resolve, reject) => {
            const existing = outcomes.get(activeId);
            if (existing) { resolve(existing); return; }
            cleanupDone = (o: TaskOutcome) => { if (o.task.id === activeId) resolve(o); };
            ar.on('done', cleanupDone);
            cleanupTimer = setTimeout(() => { reject(new Error(`收尾等待任务 ${activeId} 结果超时`)); }, 5000);
          });
          ar.cancel('验收收尾');
          try {
            const o = await activeOutcome;
            results.cleanupTaskOutcome = { receivedAt: Date.now(), outcome: o };
          } catch (e) {
            cleanupErrors.push(`收尾取消任务 ${activeId} 未收集到结果：${(e as Error).message ?? String(e)}`);
          } finally {
            if (cleanupDone) ar.off('done', cleanupDone);
            if (cleanupTimer) clearTimeout(cleanupTimer);
          }
        }
      }
    } catch (e) { cleanupErrors.push(`收尾取消任务失败：${(e as Error).message ?? String(e)}`); }

    // 移除 done 监听、清掉未决 waiter 定时器。
    try { if (onDone && arbiter) arbiter.off('done', onDone); } catch (e) { cleanupErrors.push(`移除 done 监听失败：${(e as Error).message ?? String(e)}`); }
    for (const w of outcomeWaiters.values()) { try { clearTimeout(w.timer); } catch { /* ignore */ } }
    outcomeWaiters.clear();

    // 移除 spawn 监听、释放控制、关闭内存。
    try { spawnCleanup(); } catch (e) { cleanupErrors.push(`移除 spawn 监听失败：${(e as Error).message ?? String(e)}`); }
    try { adapter?.stopAll(); } catch (e) { cleanupErrors.push(`stopAll 失败：${(e as Error).message ?? String(e)}`); }
    try { memory?.close(); } catch (e) { cleanupErrors.push(`memory.close 失败：${(e as Error).message ?? String(e)}`); }

    // quit 并等待真实 end/disconnected（有界）：超时绝不当作断线确认，须拒绝并计入 cleanupErrors。
    try {
      if (adapter) {
        const a = adapter;
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          let timer: NodeJS.Timeout | null = null;
          const onDisc = (reason: string) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            a.off('disconnected', onDisc);
            results.quitConfirmation = { confirmedAt: Date.now(), reason };
            resolve();
          };
          a.on('disconnected', onDisc);
          timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            a.off('disconnected', onDisc);
            reject(new Error('quit 后 5s 内未确认断线'));
          }, 5000);
          try {
            a.quit();
          } catch (e) {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            a.off('disconnected', onDisc);
            reject(e as Error);
          }
        });
      }
    } catch (e) { cleanupErrors.push(`quit/等待断线失败：${(e as Error).message ?? String(e)}`); }

    results.finishedAt = Date.now();
    if (cleanupErrors.length) {
      results.cleanupErrors = cleanupErrors;
      if (!results.failed) {
        results.ok = false;
        results.failed = `清理阶段失败：${cleanupErrors.join('；')}`;
        results.failedAt = Date.now();
      }
    }
    writeResults();
  }

  if (results.failed) {
    console.error(`[water-check] 失败：${results.failed}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`[water-check] 未预期错误：${(e as Error).message ?? e}`);
  process.exitCode = 1;
});
