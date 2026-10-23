import path from 'node:path';
import { MineflayerAdapter } from './adapter/mineflayer.ts';
import { Arbiter } from './arbiter/arbiter.ts';
import { Executive } from './brain/executive.ts';
import { Reflex } from './brain/reflex.ts';
import { config } from './config.ts';
import { EventBus } from './events.ts';
import { attachLogger, JsonlWriter } from './log.ts';
import { WorldMemory } from './memory/store.ts';
import { EpisodicMemory } from './memory/episodic.ts';
import { HindsightBackend } from './memory/hindsight.ts';
import { buildingArchiveFor } from './skills/build.ts';
import { MethodLibrary } from './methods/learning.ts';
import { ResourceKnowledge } from './methods/knowledge.ts';
import { createMethodSkills } from './methods/skills.ts';
import { SKILLS } from './skills/index.ts';
import { travelStore } from './travel/store.ts';
import { ActionChat } from './observer/action-chat.ts';
import { startDashboard } from './observer/dashboard.ts';
import { LlmTrace } from './planner/llm-trace.ts';
import { Metrics } from './observer/metrics.ts';
import { Spectator } from './observer/spectator.ts';
import { Perception } from './perception/perception.ts';
import { Vision } from './perception/vision.ts';
import { MockProvider, OpenAICompatibleProvider, type LlmProvider } from './planner/llm.ts';
import { ruleProposal } from './planner/plan.ts';
import { Planner } from './planner/planner.ts';
import { SkillLibrary } from './skills/library.ts';
import { habitName, learnCandidates, signatureOf } from './brain/habits.ts';
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
const episodic = new EpisodicMemory(config.memory, memory, bus, () => adapter.state(), config.dataDir,
  config.memory.provider === 'hindsight' ? new HindsightBackend(config.memory) : undefined);
episodic.start();

let provider: LlmProvider;
if (config.llm.provider === 'openai') {
  provider = new OpenAICompatibleProvider(config.llm);
  if (!config.llm.apiKey && !/localhost|127\.0\.0\.1/.test(config.llm.baseUrl)) {
    bus.publish('config', 'P1', 'LLM_PROVIDER=openai 但没有设置 LLM_API_KEY（本地模型可忽略）');
  }
} else {
  provider = new MockProvider(config.llm.fakeDelayMs, (hint: any) => ruleProposal(hint.percept, memory, hint.reason === 'prefetch' ? hint.current : null));
}
const llmTrace = new LlmTrace();
const planner = new Planner(config, provider, adapter, memory, bus, new JsonlWriter(path.join(config.dataDir, 'logs'), 'llm'), llmTrace, episodic);
const library = new SkillLibrary(path.join(config.dataDir, 'skill-library.json'), adapter, memory, bus);
const methods = new MethodLibrary(path.join(config.dataDir, 'method-library.json'), adapter, memory, bus,
  { trialWorldIds: config.learning.testWorldIds });
for (const skill of createMethodSkills(methods, new ResourceKnowledge(config.mc.version))) SKILLS[skill.name] = skill;
setInterval(() => library.prune(), 60_000).unref();
const executive = new Executive({
  adapter, arbiter, planner, perception, memory, bus,
  onLearnSkill: (raw) => {
    const r = planner.autonomous ? methods.propose(raw, { intentId: memory.currentIntent()?.id, projectId: memory.activeProject()?.id }) : library.learn(raw);
    if (!r.ok) bus.publish('skill_rejected', 'P1', `没有采纳提议的新技能：${r.error}`);
  },
  // 习惯化：同一套步骤成功 3 次以上，自动学成技能（不必等 LLM 提议）
  onGoalEnd: (status) => {
    if (planner.autonomous) return; // autonomous candidates require measured trial evidence
    if (status !== 'succeeded') return;
    const c = learnCandidates(memory, knownSigs()).find((x) => x.times >= 3);
    if (!c) return;
    const r = library.learn({ name: habitName(c), description: `习惯：${c.goal}`, steps: c.steps });
    if (r.ok) bus.publish('habit', 'P2', `「${c.signature}」做了 ${c.times} 次，养成习惯 ${r.name}`);
  },
});
const knownSigs = () => new Set(library.list().map((d) => signatureOf(d.steps)));
perception.knownSkillSigs = knownSigs;
const reflex = new Reflex(adapter, arbiter, bus, vision);
const spectator = new Spectator(config, adapter, bus);
const metrics = new Metrics(adapter, arbiter, executive, planner, reflex, bus);
const actionChat = new ActionChat(adapter, bus, { ...config.actionChat, canSend: () => !executive.paused });
actionChat.start();

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
if (memory.migrated) bus.publish('memory', 'P1', `清理了 ${memory.migrated} 个旧版本留下的地标（当时的矿物位置是穿墙搜到的，不算亲眼所见）`);


// ------------------------------------------------------------ 游戏事件
let lastHurt = 0;
adapter.on('spawn', () => {
  executive.onSpawn();
  attachObserver();
  const s = adapter.state();
  memory.setWorld(s.worldId);
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
  if (!memory.base(s.dim)) {
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
  executive.onDisconnected();
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
  } else if (cmd === 'prefer' && arg) {
    memory.addPreference({ text: arg.slice(0, 300), source: 'user', support: [`${user} 明确表达`], counterexamples: [], adjustmentReason: '用户明确偏好' });
    bus.publish('preference', 'P2', `用户偏好：${arg.slice(0, 300)}`);
  } else if (cmd === 'feedback' && rest.length > 1) {
    try {
      buildingArchiveFor(memory).feedback(rest[0], { source: 'user', text: rest.slice(1).join(' ').slice(0, 2000), category: 'appearance' });
      bus.publish('building_feedback', 'P2', `用户对作品 ${rest[0]} 的反馈已保存`);
    } catch (e) { bus.publish('building_feedback', 'P1', String((e as Error).message)); }
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
    travel: travelStore(memory).snapshot(adapter.state().worldId),
    methods: { definitions: methods.list().slice(-12), gaps: methods.abilityGaps().slice(-8) },
    episodicMemory: episodic.snapshot(),
    metrics: metrics.snapshot(),
    spectator: spectator.status,
    memory: {
      landmarks: memory.landmarks().slice(-12),
      notes: memory.recentNotes(6),
      goals: memory.recentGoals(8),
      objective: memory.objective(),
      intentions: memory.intents().slice(-12),
      preferences: memory.preferences(),
      decisions: memory.decisions().slice(-10),
      projects: memory.projects().slice(-10),
      artifacts: buildingArchiveFor(memory).list().slice(-8).map((p) => ({ id: p.id, status: p.status,
        name: p.versions.at(-1)?.spec.name, version: p.versions.at(-1)?.version, defects: p.inspections.at(-1)?.defects.length,
        feedback: p.feedback.slice(-3) })),
      lessons: memory.lessons(6),
      farms: memory.farms().map((f) => ({ crop: f.crop, cells: f.cells.length, harvests: f.harvests })),
      chests: memory.chests().map((c) => ({ pos: c.pos, items: c.items.length })),
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
}, feed ? [createObserverHandler(feed)] : [], { llmTrace });

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  bus.publish('shutdown', 'P1', '正在退出，保存记忆…');
  arbiter.cancel('退出');
  executive.stop();
  actionChat.stop();
  episodic.stop();
  methods.dispose();
  observerInstall?.dispose();
  feed?.dispose();
  memory.close();
  adapter.quit();
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
