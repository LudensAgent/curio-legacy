import path from 'node:path';
import { MineflayerAdapter } from './adapter/mineflayer.ts';
import { Arbiter } from './arbiter/arbiter.ts';
import { Executive } from './brain/executive.ts';
import { Reflex } from './brain/reflex.ts';
import { config } from './config.ts';
import { EventBus } from './events.ts';
import { attachLogger, JsonlWriter } from './log.ts';
import { WorldMemory } from './memory/store.ts';
import { startDashboard } from './observer/dashboard.ts';
import { Metrics } from './observer/metrics.ts';
import { Spectator } from './observer/spectator.ts';
import { Perception } from './perception/perception.ts';
import { Vision } from './perception/vision.ts';
import { MockProvider, OpenAICompatibleProvider, type LlmProvider } from './planner/llm.ts';
import { ruleProposal } from './planner/plan.ts';
import { Planner } from './planner/planner.ts';
import { SkillLibrary } from './skills/library.ts';
import { ObserverFeed, createObserverHandler, installMineflayerObserver, type MineflayerBotLike, type MineflayerObserver } from 'curio-observer';

const bus = new EventBus();
attachLogger(bus, config.dataDir);

process.on('unhandledRejection', (e: any) => bus.publish('unhandled', 'P1', String(e?.stack ?? e)));
process.on('uncaughtException', (e: any) => bus.publish('uncaught', 'P0', String(e?.stack ?? e)));

const memory = new WorldMemory(path.join(config.dataDir, 'world-memory.json'));
const adapter = new MineflayerAdapter(config, bus);
const vision = new Vision(adapter, config.vision);
const arbiter = new Arbiter(adapter, memory, bus, vision);
const perception = new Perception(adapter, memory, bus, vision);

let provider: LlmProvider;
if (config.llm.provider === 'openai') {
  provider = new OpenAICompatibleProvider(config.llm);
  if (!config.llm.apiKey && !/localhost|127\.0\.0\.1/.test(config.llm.baseUrl)) {
    bus.publish('config', 'P1', 'LLM_PROVIDER=openai 但没有设置 LLM_API_KEY（本地模型可忽略）');
  }
} else {
  provider = new MockProvider(config.llm.fakeDelayMs, (hint: any) => ruleProposal(hint.percept, memory, hint.reason === 'prefetch' ? hint.current : null));
}
const planner = new Planner(config, provider, adapter, memory, bus, new JsonlWriter(path.join(config.dataDir, 'logs'), 'llm'));
const library = new SkillLibrary(path.join(config.dataDir, 'skill-library.json'), adapter, memory, bus);
setInterval(() => library.prune(), 60_000).unref();
const executive = new Executive({
  adapter, arbiter, planner, perception, memory, bus,
  onLearnSkill: (raw) => {
    const r = library.learn(raw);
    if (!r.ok) bus.publish('skill_rejected', 'P1', `没有采纳提议的新技能：${r.error}`);
  },
});
const reflex = new Reflex(adapter, arbiter, bus, vision);
const spectator = new Spectator(config, adapter, bus);
const metrics = new Metrics(adapter, arbiter, executive, planner, reflex, bus);

// ------------------------------------------------------------ Curio Observer（观察者客户端模组的数据流）
const feed = config.observerFeed ? new ObserverFeed({ botName: config.mc.username, mcVersion: config.mc.version, agentVersion: '0.3.0' }) : null;
let observedBot: unknown = null;
let observerInstall: MineflayerObserver | null = null;
/** 每次创建新的 Mineflayer bot（首次连接、断线重连）时重新挂载；同一个 bot 的重生不重复挂载 */
function attachObserver() {
  if (!feed || !adapter.bot || adapter.bot === observedBot) return;
  observerInstall?.dispose();
  observerInstall = installMineflayerObserver(adapter.bot as MineflayerBotLike, feed);
  observedBot = adapter.bot;
  bus.publish('observer_feed', 'P3', `Curio Observer 数据流已挂载到 ${config.mc.username}`);
}
// 新目标 → 模组里的思考字幕
bus.on('event', (ev: { type: string }) => {
  if (feed && ev.type === 'goal' && executive.plan) feed.thought(executive.plan.goal, executive.plan.thought);
});

// ------------------------------------------------------------ 游戏事件
let lastHurt = 0;
adapter.on('spawn', () => {
  attachObserver();
  const s = adapter.state();
  if (awaitingRespawnLoss) {
    // 复活后比较背包：开了 keepInventory 就什么都没丢
    awaitingRespawnLoss = false;
    setTimeout(() => {
      const now = new Map(adapter.state().inventory.map((i) => [i.name, i.count]));
      const lost = (memory.lastDeath()?.lost ?? [])
        .map((i) => ({ name: i.name, count: i.count - (now.get(i.name) ?? 0) }))
        .filter((i) => i.count > 0);
      if (lost.length) {
        memory.updateDeathLost(lost);
        bus.publish('death_items', 'P1', `死亡掉落：${lost.map((i) => `${i.name}×${i.count}`).join('、')}（5 分钟内回去还能捡回）`);
      } else memory.clearDeath();
    }, 1500);
  }
  if (!memory.base()) {
    memory.setBase(s.dim, s.pos);
    bus.publish('base', 'P2', `把出生点设为基地 (${Math.round(s.pos.x)}, ${Math.round(s.pos.y)}, ${Math.round(s.pos.z)})`);
  }
  bus.publish('spawn', 'P2', `${s.username} 进入世界 @ ${s.dim} (${Math.round(s.pos.x)}, ${Math.round(s.pos.y)}, ${Math.round(s.pos.z)})`);
});
// 持续记录背包快照：死亡时用来算丢了什么
let invSnapshot: { name: string; count: number }[] = [];
let awaitingRespawnLoss = false;
setInterval(() => {
  const st = adapter.state();
  if (st.connected && st.alive) invSnapshot = st.inventory.map((i) => ({ ...i }));
}, 1000).unref();

adapter.on('death', () => {
  const s = adapter.state();
  memory.addLandmark('death', '死亡地点', s.dim, s.pos, 4);
  memory.setDeath({ ts: Date.now(), dim: s.dim, pos: s.pos, lost: invSnapshot });
  awaitingRespawnLoss = true;
  bus.publish('death', 'P0', `死亡 @ (${Math.round(s.pos.x)}, ${Math.round(s.pos.y)}, ${Math.round(s.pos.z)})`);
  executive.onDeath();
});
adapter.on('hurt', () => {
  if (Date.now() - lastHurt < 1000) return;
  lastHurt = Date.now();
  // entityHurt 先于生命值更新到达，稍等再读
  setTimeout(() => {
    const st = adapter.state();
    bus.publish('hurt', 'P1', `受到伤害，生命 ${st.hp.toFixed(1)}${st.inWater ? `，氧气 ${st.oxygen}/20` : ''}`);
  }, 150);
});
adapter.on('disconnected', (reason: string) => {
  arbiter.cancel('断线');
  bus.publish('disconnected', 'P1', `与服务器断开：${reason}`);
});
adapter.on('kicked', (reason: string) => bus.publish('kicked', 'P1', `被踢出：${reason}`));
adapter.on('chat', (user: string, message: string) => {
  bus.publish('chat', 'P3', `<${user}> ${message}`);
  if (!config.observer.admins.includes(user) || !message.startsWith('!')) return;
  const [cmd, ...rest] = message.slice(1).trim().split(/\s+/);
  const arg = rest.join(' ');
  if (cmd === 'pause') executive.pause();
  else if (cmd === 'resume') executive.resume();
  else if (cmd === 'replan') executive.replan();
  else if (cmd === 'goal' && arg) {
    executive.suggest(arg);
    adapter.chat(`收到：${arg}`);
  } else if (cmd === 'status') {
    const t = arbiter.info();
    adapter.chat(`目标：${executive.plan?.goal ?? '无'}｜当前：${t ? t.skill : '空闲'}`);
  }
});

// ------------------------------------------------------------ 启动
function snapshot() {
  return {
    now: Date.now(),
    config: {
      bot: config.mc.username,
      server: `${config.mc.host}:${config.mc.port}`,
      version: config.mc.version,
      llm: provider.name,
      fakeDelayMs: config.llm.fakeDelayMs,
      observer: config.observer.player || null,
    },
    state: adapter.state(),
    percept: perception.snapshot(),
    vision: vision.frame,
    task: arbiter.info(),
    planVersion: arbiter.planVersion,
    exec: executive.snapshot(),
    metrics: metrics.snapshot(),
    spectator: spectator.status,
    memory: {
      landmarks: memory.landmarks().slice(-12),
      notes: memory.recentNotes(6),
      goals: memory.recentGoals(8),
      objective: memory.objective(),
      skills: library.list().map((d) => ({ name: d.name, description: d.description, steps: d.steps.length })),
      seen: memory.seenCount(),
      visitedChunks: memory.visitedChunkCount,
    },
  };
}

bus.publish('boot', 'P2', `Minecraft Curiosity Agent MVP 启动｜LLM=${provider.name}（LLM_PROVIDER=${config.llm.providerLabel}）｜视觉 ${config.vision.hFov}°/${config.vision.range} 格｜延迟注入=${config.llm.fakeDelayMs}ms`);
adapter.connect();
perception.start();
executive.start();
reflex.start();
spectator.start();
metrics.start();
startDashboard(config.dashboard.host, config.dashboard.port, bus, {
  snapshot,
  pause: () => executive.pause(),
  resume: () => executive.resume(),
  replan: () => executive.replan(),
  suggest: (t) => executive.suggest(t),
}, feed ? [createObserverHandler(feed)] : []);

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  bus.publish('shutdown', 'P1', '正在退出，保存记忆…');
  arbiter.cancel('退出');
  observerInstall?.dispose();
  feed?.dispose();
  memory.close();
  adapter.quit();
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
