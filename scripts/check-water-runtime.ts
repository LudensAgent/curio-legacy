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
import { config } from '../src/config.ts';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { Vision } from '../src/perception/vision.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { EventBus } from '../src/events.ts';

// ------------------------------------------------------------------ 参数与夹具契约
const RESERVED = { xMin: 76, xMaxExclusive: 91, zMin: 76, zMaxExclusive: 87 };
const FIXTURE_NEAR = 2.0; // 当前位置离指定水下起点的最大偏差（格）
const FIXTURE_TIMEOUT_MS = 180_000;
const W1_SURFACED_STABLE_MS = 600; // 独立判定「头部稳定露出流体」的最短连续时长（真实 ts 差，非采样次数乘间隔）
const W2_STABILITY_MS = 400; // W2 到达后复查站稳的观测窗口（真实 ts 差）
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
const results: Record<string, unknown> = { mode: config.mode, worldId: config.memory.worldId, startedAt: Date.now() };

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

  try {
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

    // 独立读取自身 7 个控制键：读不到任一键就失败，绝不退回“空即全 false”的假通过。
    const sampleControls = (): Record<string, boolean> => {
      const b = ad.bot;
      if (!b || typeof b.getControlState !== 'function') throw new Error('无法读取 bot 按键状态（getControlState 缺失）');
      const out: Record<string, boolean> = {};
      for (const k of KEYS) {
        const v = b.getControlState(k);
        if (typeof v !== 'boolean') throw new Error(`无法读取按键 ${k} 的布尔状态`);
        out[k] = v;
      }
      return out;
    };

    // 归一化接触事实（测试判据）：只暴露自身身体的本体/接触判定布尔，不暴露精确方块名/属性。
    const contact = (label: string): ContactSample => {
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
        controls: sampleControls(),
      };
    };

    // 动作期物理采样：跟随 bot 真实 physicsTick，观测紧跟真实物理，不用“采样次数×名义间隔”折算时长。
    const startPhysicsTrace = (): TraceHandle => {
      const b = ad.bot;
      if (!b || typeof b.on !== 'function' || typeof b.off !== 'function') throw new Error('无法安装物理采样监听（bot 缺失 on/off）');
      const samples: ContactSample[] = [];
      let error: string | null = null;
      let stopped = false;
      const onTick = () => {
        try {
          samples.push(contact('trace'));
        } catch (e) {
          error = (e as Error).message ?? String(e);
        }
      };
      b.on('physicsTick', onTick);
      return { samples, get error() { return error; }, stop: () => { if (!stopped) { stopped = true; b.off('physicsTick', onTick); } } };
    };

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

    // 提前挂上 done 监听（先于任何 start），按 taskId 匹配结果；start 返回 {error} 时清楚失败。
    const done = (o: TaskOutcome) => {
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

    // 夹具就绪：只等操作员把 bot 放到水下起点，不发任何管理命令/传送；要求真实浸没（身体在水中 + 头部在水下）。
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
    results.fixtureReady = contact('fixture');
    assertNoOtherPlayers('夹具就绪后');

    // ---- W1：surface 一次有界上浮 ----
    assertNoOtherPlayers('W1 前');
    const w1Start = contact('w1_start');
    const scenario1: Record<string, unknown> = { taskId: null, requested: { skill: 'surface', args: {} }, start: w1Start, startedAt: Date.now(), status: 'pending' };
    results.scenario1 = scenario1;
    const w1 = startTask({ skill: 'surface', args: {} }, 40_000);
    scenario1.taskId = w1.taskId;

    const tr1 = startPhysicsTrace();
    w1Trace = tr1;
    const o1 = await w1.outcome; // 可能超时：信封（taskId/start/startedAt）已先持久化，trace 由 finally 移除
    const w1Completion = contact('w1_completion'); // 结果返回后立即采样，早于任何清理等待
    tr1.stop();
    w1Trace = null;
    scenario1.trace = tr1.samples;
    scenario1.traceError = tr1.error;
    scenario1.completion = w1Completion;
    scenario1.status = o1.result.status;
    scenario1.summary = o1.result.summary;
    const w1surfaced = Boolean(o1.result.data?.surfaced);
    const w1landed = Boolean(o1.result.data?.landed);
    scenario1.surfaced = w1surfaced;
    scenario1.landed = w1landed;
    scenario1.durationMs = o1.durationMs;

    // 独立判定：末尾连续「头部露出流体」的起点（真实 ts），要求一直持续到完成快照且 headInAir 为真。
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

    const w1AfterRelease = contact('w1_after_release');
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
    const w2Start = contact('w2_start');
    const scenario2: Record<string, unknown> = { taskId: null, requested: { skill: 'swim_to', args: { xyz: [east.x, east.y, east.z] } }, target: east, start: w2Start, startedAt: Date.now(), status: 'pending' };
    results.scenario2 = scenario2;
    const w2 = startTask({ skill: 'swim_to', args: { xyz: [east.x, east.y, east.z] } }, 40_000);
    scenario2.taskId = w2.taskId;

    const o2 = await w2.outcome; // 可能超时
    const w2Finish = contact('w2_finish');
    const errOf = (p: { x: number; y: number; z: number }) => ({ horizontal: Math.hypot(p.x - east.x, p.z - east.z), vertical: Math.abs(p.y - east.y) });
    const dryOf = (c: { onGround: boolean; bodyInWater: boolean; bodyInLava: boolean; headInAir: boolean }) => c.onGround && !c.bodyInWater && !c.bodyInLava && c.headInAir;
    const withinOf = (p: { x: number; y: number; z: number }) => { const e = errOf(p); return e.horizontal <= 1 && e.vertical <= 1.5; };

    // 站稳观测窗口：用物理采样连续记录，而非只取两个端点（避免漏掉中途重新入水/下坠）。
    const tr2 = startPhysicsTrace();
    w2Trace = tr2;
    await sleepMs(W2_STABILITY_MS);
    tr2.stop();
    w2Trace = null;
    const w2Stable = contact('w2_stable');
    const stabilitySamples = tr2.samples;
    const stabilityObservedMs = stabilitySamples.length ? stabilitySamples[stabilitySamples.length - 1].ts - stabilitySamples[0].ts : 0;
    const stabilityDry = stabilitySamples.length > 0 && stabilitySamples.every((s) => dryOf(s) && withinOf(s.pos));

    const errFinish = errOf(w2Finish.pos);
    const errStable = errOf(w2Stable.pos);
    const withinFinish = withinOf(w2Finish.pos);
    const withinStable = withinOf(w2Stable.pos);
    const dryFinish = dryOf(w2Finish);
    const dryStable = dryOf(w2Stable);
    const landedBySkill = o2.result.status === 'succeeded' && Boolean(o2.result.data?.landed);
    const skillSurfaced = Boolean(o2.result.data?.surfaced);
    scenario2.status = o2.result.status;
    scenario2.summary = o2.result.summary;
    scenario2.landedBySkill = landedBySkill;
    scenario2.skillSurfaced = skillSurfaced;
    scenario2.requestedStabilityMs = W2_STABILITY_MS;
    scenario2.stabilityObservedMs = stabilityObservedMs;
    scenario2.finish = { ...w2Finish, horizontal: Number(errFinish.horizontal.toFixed(3)), vertical: Number(errFinish.vertical.toFixed(3)), withinTolerance: withinFinish, dry: dryFinish };
    scenario2.stabilityTrace = stabilitySamples;
    scenario2.stabilityDry = stabilityDry;
    scenario2.traceError = tr2.error;
    scenario2.stable = { ...w2Stable, horizontal: Number(errStable.horizontal.toFixed(3)), vertical: Number(errStable.vertical.toFixed(3)), withinTolerance: withinStable, dry: dryStable };
    scenario2.durationMs = o2.durationMs;
    log({ event: 'water_w2', status: o2.result.status, landedBySkill, skillSurfaced, stabilityObservedMs, stabilityDry, finish: { withinTolerance: withinFinish, dry: dryFinish }, stable: { withinTolerance: withinStable, dry: dryStable }, traceError: tr2.error });

    if (tr2.error) throw new Error(`W2 物理采样回调失败：${tr2.error}`);
    if (!landedBySkill || !skillSurfaced || !withinFinish || !withinStable || !dryFinish || !dryStable || !stabilityDry) {
      throw new Error(`W2 swim_to 未在到达/复查/连续站稳窗口均满足干地且容差：status=${o2.result.status} landed=${landedBySkill} surfaced=${skillSurfaced} 到达[水平=${errFinish.horizontal.toFixed(3)},垂直=${errFinish.vertical.toFixed(3)},dry=${dryFinish}] 复查[水平=${errStable.horizontal.toFixed(3)},垂直=${errStable.vertical.toFixed(3)},dry=${dryStable}] 连续站稳=${stabilityDry} 摘要=${o2.result.summary}`);
    }

    // ---- W3：从干岸游向对岸，进入水体并水平移动后取消 ----
    assertNoOtherPlayers('W3 前');
    const w3Start = contact('w3_start');
    const scenario3: Record<string, unknown> = { taskId: null, requested: { skill: 'swim_to', args: { xyz: [west.x, west.y, west.z] } }, target: west, start: w3Start, startedAt: Date.now(), status: 'pending' };
    results.scenario3 = scenario3;
    const w3 = startTask({ skill: 'swim_to', args: { xyz: [west.x, west.y, west.z] } }, 40_000);
    scenario3.taskId = w3.taskId;
    await waitFor(() => {
      const s = ad.state();
      return s.inWater && Math.hypot(s.pos.x - w3Start.pos.x, s.pos.z - w3Start.pos.z) > 0.5;
    }, 20_000, 'swim_to 进入水体并水平移动'); // 可能超时：信封已持久化
    scenario3.enteredWater = true;
    const w3PreCancel = contact('w3_pre_cancel');
    scenario3.preCancel = w3PreCancel;
    // 脚本级按键写入仪表：只包裹现有 bot.setControlState/clearControlStates，记录迟到窗口内的真实写入/清除；不改生产、不引入新 API/类型。
    const bot = ad.bot;
    if (!bot || typeof bot.setControlState !== 'function' || typeof bot.clearControlStates !== 'function') throw new Error('无法安装脚本级按键写入仪表（bot 缺少 setControlState/clearControlStates）');
    const origSet: (name: string, value: boolean) => void = bot.setControlState;
    const origClear: () => void = bot.clearControlStates;
    let recording = false;
    const lateWrites: { ts: number; key: string; value: boolean }[] = [];
    const lateClears: { ts: number }[] = [];
    bot.setControlState = function (name: string, value: boolean): void {
      if (recording) lateWrites.push({ ts: Date.now(), key: name, value });
      origSet.call(bot, name, value);
    };
    bot.clearControlStates = function (): void {
      if (recording) lateClears.push({ ts: Date.now() });
      origClear.call(bot);
    };
    restoreControls = () => {
      try { bot.setControlState = origSet; } catch { /* ignore */ }
      try { bot.clearControlStates = origClear; } catch { /* ignore */ }
    };
    ar.cancel('联机验收取消'); // 同步 stopAll 释放控制（合法取消，不在仪表窗口内）
    const w3KeysAtCancel = sampleControls(); // 取消后、任何后续清理前立即读取全部 7 键
    const anyKeyAtCancel = KEYS.some((k) => w3KeysAtCancel[k]);
    scenario3.keysAtCancel = w3KeysAtCancel;
    recording = true; // 迟到窗口起点：合法 stopAll 之后
    const o3 = await w3.outcome;
    const lateKeySamples: { ts: number; controls: Record<string, boolean> }[] = [];
    for (let i = 0; i < 12; i++) {
      await sleepMs(100);
      lateKeySamples.push({ ts: Date.now(), controls: sampleControls() });
    }
    recording = false;
    const reactivated = lateKeySamples.some((s) => KEYS.some((k) => s.controls[k]));
    const w3Finish = contact('w3_finish');
    scenario3.status = o3.result.status;
    scenario3.summary = o3.result.summary;
    scenario3.anyKeyAtCancel = anyKeyAtCancel;
    scenario3.lateWrites = lateWrites;
    scenario3.lateClears = lateClears;
    scenario3.lateKeySamples = lateKeySamples;
    scenario3.reactivated = reactivated;
    scenario3.finish = w3Finish;
    scenario3.durationMs = o3.durationMs;
    // 取消后的物理漂移/重力单独记录，不与「控制复活」混淆。
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
    // 证据已全部采集后才清理；先还原仪表、停掉动作期采样监听、移除 spawn 监听、清掉未决 waiter 定时器，避免失败后遗留 unhandled rejection / keepalive。
    try { w1Trace?.stop(); } catch { /* ignore */ }
    try { w2Trace?.stop(); } catch { /* ignore */ }
    try { restoreControls?.(); } catch { /* ignore */ }
    for (const w of outcomeWaiters.values()) clearTimeout(w.timer);
    outcomeWaiters.clear();
    try { spawnCleanup(); } catch { /* ignore */ }
    try { if (onDone && arbiter) arbiter.off('done', onDone); } catch { /* ignore */ }
    try { arbiter?.cancel('验收收尾'); } catch { /* ignore */ }
    try { adapter?.stopAll(); } catch { /* ignore */ }
    try { memory?.close(); } catch { /* ignore */ }
    try { adapter?.quit(); } catch { /* ignore */ }
    results.finishedAt = Date.now();
    writeResults();
  }

  if (results.failed) {
    console.error(`[water-check] 失败：${results.failed}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  // 兜底：仅当 finally 内写盘/清理本身抛错才会走到这里，不再重复写结果。
  console.error(`[water-check] 未预期错误：${(e as Error).message ?? e}`);
  process.exitCode = 1;
});
