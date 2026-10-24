import path from 'node:path';
import { runtime } from './runtime.ts';
import { MineflayerAdapter } from './adapter/mineflayer.ts';
import { Arbiter } from './arbiter/arbiter.ts';
import { Executive } from './brain/executive.ts';
import { Reflex } from './brain/reflex.ts';
import { Mind } from './mind/mind.ts';
import { SelfModel } from './mind/self.ts';
import { Thinker } from './mind/thinker.ts';
import { config } from './config.ts';
import { EventBus } from './events.ts';
import { attachLogger, JsonlWriter } from './log.ts';
import { WorldMemory } from './memory/store.ts';
import { EpisodicMemory } from './memory/episodic.ts';
import { HindsightBackend } from './memory/hindsight.ts';
import { buildingArchiveFor } from './skills/build.ts';
import { flattenProgram, MethodLibrary, simpleToMethod } from './methods/learning.ts';
import { ResourceKnowledge } from './methods/knowledge.ts';
import { ControlKnowledge } from './methods/controls.ts';
import { RecipeBook } from './methods/recipes.ts';
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
import { liveAudience } from './planner/prompt.ts';
import { AudienceChannel } from './live/audience.ts';
import { BilibiliLive, type LiveMessage, type LiveStatus } from './live/bilibili.ts';
import { SkillLibrary } from './skills/library.ts';
import { ExperienceMiner } from './methods/experience.ts';
import type { TaskOutcome } from './arbiter/arbiter.ts';
import { deathCause, habitName, hazardLesson, learnCandidates, signatureOf, type LearnCandidate, type VitalSample } from './brain/habits.ts';
import type { MySkillInfo } from './planner/prompt.ts';
import { ObserverFeed, createObserverHandler, installMineflayerObserver, installTaskObserver, type MineflayerBotLike, type MineflayerObserver } from 'curio-observer';

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
const planner = new Planner(config, provider, adapter, memory, bus, new JsonlWriter(path.join(config.dataDir, 'logs'), 'llm'), llmTrace, episodic,
  new ControlKnowledge(path.join(config.dataDir, 'control-knowledge.json')));
const library = new SkillLibrary(path.join(config.dataDir, 'skill-library.json'), adapter, memory, bus);
const methods = new MethodLibrary(path.join(config.dataDir, 'method-library.json'), adapter, memory, bus,
  { trialWorldIds: config.learning.testWorldIds });
for (const skill of createMethodSkills(methods, new ResourceKnowledge(config.mc.version))) SKILLS[skill.name] = skill;
// 从经历里学做法：每一步结束都实测背包增减，真的做成一件东西时提炼做法，两处做成过就采纳为已验证方法
const experience = new ExperienceMiner(path.join(config.dataDir, 'experience.json'), adapter, memory, methods, bus);
arbiter.on('done', (o: TaskOutcome) => experience.onDone(o));
// 配方记忆：拿到过材料才知道配方；LLM 按类别→物品分级查询
const recipeBook = new RecipeBook(config.mc.version, memory);
planner.recipeBook = recipeBook;
perception.onNewItem = (item, heldBefore) => {
  const unlocked = recipeBook.unlockedBy(item, heldBefore);
  bus.publish('item_new', 'P2', `第一次拿到 ${item}${unlocked.length ? `，想起了用它能做的东西：${unlocked.join('、')}` : ''}`, { item, unlocked });
};
setInterval(() => library.prune(), 60_000).unref();
// ------------------------------------------------------------ 直播间（可选）：弹幕只作参考
const audience = config.live.bilibili.enabled ? new AudienceChannel(config.live.audience, bus) : null;
const live = config.live.bilibili.enabled ? new BilibiliLive(config.live.bilibili, { log: (sev, msg) => bus.publish('live', sev, msg) }) : null;
if (live && audience) {
  liveAudience.enabled = true;
  live.on('message', (m: LiveMessage) => audience.ingest(m));
  live.on('status', (st: LiveStatus) => bus.publish('live_status', st.state === 'error' ? 'P1' : 'P3', `B 站直播间：${st.state}${st.detail ? `（${st.detail}）` : ''}`));
}

/**
 * 学一个新组合：自主模式下进方法库（简单格式自动补上可观测的验收条件，试验两种情境后才算学会）；
 * 自动习惯必须有可观测验收条件；模型显式提出的组合可另存为宏。
 */
function learnSkill(raw: unknown, origin: 'model' | 'habit'): { ok: boolean; name?: string; error?: string } {
  if (!planner.autonomous) return library.learn(raw);
  const converted = simpleToMethod(raw, adapter, memory, { allowMacro: origin !== 'habit' });
  if (converted.kind === 'invalid') return { ok: false, error: converted.error };
  if (converted.kind === 'macro') {
    const r = library.learn(converted.macro);
    if (r.ok) bus.publish('skill_learned', 'P3', `推不出可验收的结果，「${converted.macro.name}」先记成组合技能 ${r.name}`, { origin });
    return r;
  }
  return methods.propose(converted.method, { intentId: memory.currentIntent()?.id, projectId: memory.activeProject()?.id });
}

// Preserve old records, but do not keep executing automatic habits whose only
// evidence was the old right-click acknowledgement. Explicit macros stay intact.
adapter.on('spawn', () => {
  if (!planner.autonomous) return;
  // Item definitions and the current dimension must exist before checking old
  // craft/gather/landmark habits; startup alone cannot prove them invalid.
  for (const macro of library.list()) {
    if (macro.description.startsWith('习惯：') && !macro.disabled
      && simpleToMethod(macro, adapter, memory, { allowMacro: false }).kind === 'invalid') {
      library.suspend(macro.name, '旧自动习惯缺少可观测的验收条件，保留记录，等待重新验证');
    }
  }
});

/** 自主模式的习惯化：同一套步骤成功 3 次以上，自动提成候选方法（每个签名只提一次） */
const proposedHabits = new Set<string>();
function formHabit(c: LearnCandidate) {
  proposedHabits.add(c.signature);
  const r = learnSkill({ name: habitName(c), description: `习惯：${c.goal}`.slice(0, 120), steps: c.steps }, 'habit');
  if (r.ok) bus.publish('habit', 'P2', `「${c.signature}」做了 ${c.times} 次，养成习惯 ${r.name}（候选，试验通过后才算学会）`, { signature: c.signature, times: c.times });
  else bus.publish('habit', 'P3', `「${c.signature}」做了 ${c.times} 次，但没能固定成习惯：${r.error}`, { signature: c.signature });
}

function mySkills(): MySkillInfo[] {
  const stats = memory.skillStats();
  const fromMethods: MySkillInfo[] = methods.list().filter((d) => d.status !== 'retired').slice(-8).map((d) => ({
    name: d.status === 'verified' ? `method:${d.name}` : `trial:${d.name}:v${d.version}`, status: d.status as 'candidate' | 'verified',
    description: d.description.slice(0, 80),
    trials: { verified: d.trials.filter((t) => t.status === 'verified').length, failed: d.trials.filter((t) => t.status === 'failed').length } }));
  const fromMacros: MySkillInfo[] = library.list().filter((d) => !d.disabled).slice(-6).map((d) => {
    const st = stats[`macro:${d.name}`];
    return { name: `macro:${d.name}`, status: 'macro' as const, description: d.description.slice(0, 80), ...(st?.runs ? { success: `${st.ok}/${st.runs}` } : {}) };
  });
  return [...fromMethods, ...fromMacros].slice(-10);
}

const onLearnSkill = (raw: unknown) => {
  const r = learnSkill(raw, 'model');
  if (!r.ok) bus.publish('skill_rejected', 'P1', `没有采纳提议的新技能：${r.error}`);
};
// 习惯化：同一套步骤成功 3 次以上，自动学成技能（不必等 LLM 提议）
const onGoalEnd = (status: string) => {
  if (status !== 'succeeded') return;
  const c = learnCandidates(memory, knownSigs()).find((x) => x.times >= 3 && !proposedHabits.has(x.signature));
  if (!c) return;
  if (planner.autonomous) { formHabit(c); return; }
  const r = library.learn({ name: habitName(c), description: `习惯：${c.goal}`, steps: c.steps });
  if (r.ok) bus.publish('habit', 'P2', `「${c.signature}」做了 ${c.times} 次，养成习惯 ${r.name}`);
};

/** 大脑：默认是新的心智层（像真人一样一段一段地玩），AGENT_MIND=legacy 用旧的逐步决策 */
interface Brain {
  readonly paused: boolean; readonly inFlight: boolean; readonly staleDropped: number;
  readonly plan: { goal: string; thought?: string; id: string; binding?: { intentId?: string } } | null;
  start(): void; stop(): void; pause(): void; resume(): void; replan(): void; suggest(text: string): void;
  onDeath(info: Parameters<Executive['onDeath']>[0]): void; onSpawn(): void; onDisconnected(): void;
  snapshot(): unknown;
}
const selfModel = config.mind.mode === 'human' ? new SelfModel(path.join(config.dataDir, 'mind.json'), config.mind.traits) : null;
const mind = selfModel ? new Mind({
  adapter, arbiter, perception, memory, bus, self: selfModel, persona: config.persona,
  thinker: new Thinker(planner, adapter, memory, bus),
  ...(audience ? { audience } : {}),
  mySkills,
  researchContext: () => methods.researchContext(),
  onGoalEnd,
  say: (text) => { if (config.actionChat.enabled) adapter.chat(text); },
  timing: { checkInMs: config.mind.checkInSec * 1000, deliberateEveryMs: config.mind.deliberateEverySec * 1000 },
}) : null;
const executive: Brain = mind ?? new Executive({
  adapter, arbiter, planner, perception, memory, bus,
  ...(audience ? { audience } : {}),
  mySkills,
  researchContext: () => methods.researchContext(),
  onMissingAbility: (text) => { if (planner.autonomous) methods.recordGap(text, { intentId: memory.currentIntent()?.id, projectId: memory.activeProject()?.id }); },
  onLearnSkill,
  onGoalEnd,
});
/** 已经学过（宏或方法库里）的步骤签名：不再重复提示/提议 */
const knownSigs = () => new Set([...library.list().filter((d) => !d.disabled).map((d) => signatureOf(d.steps)),
  ...methods.list().filter((d) => d.status !== 'retired').map((d) => signatureOf(flattenProgram(d.program))), ...proposedHabits]);
perception.knownSkillSigs = knownSigs;
const reflex = new Reflex(adapter, arbiter, bus, vision, { routineCare: mind ? config.mind.bodyHabits : !planner.autonomous });
const spectator = new Spectator(config, adapter, bus);
const metrics = new Metrics(adapter, arbiter, executive, planner, reflex, bus);
const actionChat = new ActionChat(adapter, bus, { ...config.actionChat, canSend: () => !executive.paused,
  context: () => ({ plan: executive.plan, task: arbiter.info(), intent: mind ? mind.currentIntent() : memory.currentIntent() }),
});
actionChat.start();

// ------------------------------------------------------------ Curio Observer（观察者客户端模组的数据流）
const feed = config.observerFeed ? new ObserverFeed({ botName: config.mc.username, mcVersion: config.mc.version, agentVersion: '0.3.0' }) : null;
const observerTasks = feed ? installTaskObserver(feed, arbiter, {
  interests: () => perception.snapshot()?.drives ?? [],
}) : null;
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
// Chat, the mod and OBS share one action-bound expression lifecycle.
bus.on('event', (ev: { type: string; data?: Record<string, unknown> }) => {
  if (feed && ev.type === 'expression_changed') feed.thought(String(ev.data?.goal ?? ''), String(ev.data?.thought ?? ''));
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
// 死前几秒的状态（氧气、水、岩浆、饥饿、附近的怪、在做的事）：死亡时据此判断死因
let vitals: VitalSample[] = [];
const taskKey = (t: { skill: string; args?: unknown } | null | undefined) => {
  if (!t) return undefined;
  const a = (t.args ?? {}) as Record<string, unknown>;
  const key = a.block ?? a.item ?? a.animal ?? a.target ?? a.to ?? a.direction ?? a.blueprint ?? '';
  return `${t.skill}${key ? ` ${String(key)}` : ''}`;
};
let lastWork: string | undefined;
function sampleVitals() {
  const st = adapter.state();
  if (!st.connected || !st.alive) return;
  const task = arbiter.info();
  if (task && task.source !== 'reflex' && task.source !== 'filler') lastWork = taskKey(task);
  let hostiles: { name: string; dist: number }[] = [];
  try { hostiles = (perception.snapshot()?.nearby?.hostile ?? []).slice(0, 4).map((h) => ({ name: h.name, dist: h.dist })); } catch { /* 感知暂不可用 */ }
  vitals.push({ ts: Date.now(), hp: st.hp, food: st.food, oxygen: st.oxygen, inWater: st.inWater, inLava: st.inLava,
    hostileDist: hostiles[0]?.dist ?? null, hostiles, task: lastWork,
    pos: { x: Math.round(st.pos.x), y: Math.round(st.pos.y), z: Math.round(st.pos.z) } });
  if (vitals.length > 15) vitals = vitals.slice(-15);
}
setInterval(() => {
  const st = adapter.state();
  if (st.connected && st.alive) invSnapshot = st.inventory.map((i) => ({ ...i }));
  sampleVitals();
}, 1000).unref();

adapter.on('death', () => {
  const s = adapter.state();
  // 死因由程序根据死前的真实状态判断，写成危险区域 + 亲历经验（不靠模型）
  sampleVitals();
  const cause = deathCause(vitals, lastHurt);
  const during = vitals.at(-1)?.task ?? lastWork;
  vitals = [];
  let hazard: ReturnType<typeof memory.addHazard> | null = null;
  try {
    const h = hazard = memory.addHazard({ dim: s.dim, pos: s.pos, kind: cause, ...(during ? { during } : {}) });
    const text = hazardLesson(h);
    memory.addLesson(text, { source: 'observed', key: `hazard:${h.id}` });
    bus.publish('lesson', 'P2', `亲历经验：${text}`, { source: 'observed', hazard });
  } catch (e) { bus.publish('memory', 'P1', `记录危险区域失败：${String((e as Error)?.message ?? e)}`); }
  memory.addLandmark('death', '死亡地点', s.dim, s.pos, 4);
  memory.setDeath({ ts: Date.now(), dim: s.dim, pos: s.pos, lost: invSnapshot, cause });
  awaitingRespawnLoss = true;
  bus.publish('death', 'P0', `死亡 @ (${Math.round(s.pos.x)}, ${Math.round(s.pos.y)}, ${Math.round(s.pos.z)})，死因：${cause}${during ? `（在做 ${during}）` : ''}`, { cause, during });
  executive.onDeath({ cause, hazard, during });
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
    runtime,
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
    expression: actionChat.snapshot(),
    travel: travelStore(memory).snapshot(adapter.state().worldId),
    methods: { definitions: methods.list().slice(-12), gaps: methods.abilityGaps().slice(-8) },
    episodicMemory: episodic.snapshot(),
    metrics: metrics.snapshot(),
    spectator: spectator.status,
    live: live ? { status: live.status(), audience: audience?.stats() } : null,
    memory: {
      landmarks: memory.landmarks().slice(-12),
      notes: memory.notesFor({ n: 8 }),
      goals: memory.recentGoals(8),
      objective: memory.objective(),
      intentions: memory.intents().slice(-12),
      preferences: memory.preferences(),
      decisions: memory.decisions().slice(-10),
      projects: memory.projects().slice(-10),
      artifacts: buildingArchiveFor(memory).list().slice(-8).map((p) => ({ id: p.id, status: p.status,
        name: p.versions.at(-1)?.spec.name, version: p.versions.at(-1)?.version, defects: p.inspections.at(-1)?.defects.length,
        feedback: p.feedback.slice(-3) })),
      lessons: memory.lessonsFor(8),
      hazards: memory.hazards().slice(-10),
      mySkills: mySkills(),
      farms: memory.farms().map((f) => ({ crop: f.crop, cells: f.cells.length, harvests: f.harvests })),
      chests: memory.chests().map((c) => ({ pos: c.pos, items: c.items.length })),
      skills: library.list().map((d) => ({ name: d.name, description: d.description, steps: d.steps.length, ...(d.disabled ? { disabled: d.disabled } : {}) })),
      seen: memory.seenCount(),
      visitedChunks: memory.visitedChunkCount,
    },
  };
}

bus.publish('boot', 'P2', `Minecraft Curiosity Agent MVP 启动｜心智=${mind ? (planner.autonomous ? '真人式心智' : '真人式心智（规则）') : '旧版逐步决策'}｜LLM=${provider.name}（LLM_PROVIDER=${config.llm.providerLabel}）｜视觉 ${config.vision.hFov}°/${config.vision.range} 格｜延迟注入=${config.llm.fakeDelayMs}ms`);
adapter.connect();
perception.start();
executive.start();
reflex.start();
spectator.start();
metrics.start();
live?.start();
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
  void live?.stop();
  episodic.stop();
  methods.dispose();
  selfModel?.close();
  observerInstall?.dispose();
  observerTasks?.dispose();
  feed?.dispose();
  memory.close();
  adapter.quit();
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
