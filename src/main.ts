import { appendFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { startStallProfiler } from './observer/stall-profiler.ts';
import { runtime } from './runtime.ts';
import { MineflayerAdapter } from './adapter/mineflayer.ts';
import { Arbiter } from './arbiter/arbiter.ts';
import { Reflex } from './brain/reflex.ts';
import { Mind } from './mind/mind.ts';
import { parseGameMessage, type ParsedGameMessage } from './memory/game-messages.ts';
import { SelfModel } from './mind/self.ts';
import { applyMindPatch } from './mind/mind-patch.ts';
import { Thinker } from './mind/thinker.ts';
import { BUILTIN_SKILLS_DIR, SkillBook } from './knowledge/skillbook.ts';
import { KnowledgeBase } from './knowledge/library.ts';
import { BehaviorEngine, setInstinctSource } from './mind/behaviors.ts';
import { setBehaviorRegistry } from './skills/use-skill.ts';
import { setReliableSkills } from './codeskills/bridge.ts';
import { CodeImprover } from './codeskills/improver.ts';
import { installSkillRestoreRequest } from './mind/restore-request.ts';
import { SkillSmith } from './codeskills/smith.ts';
import { SkillCurator } from './codeskills/curator.ts';
import { ObservedGameClock } from './codeskills/game-clock.ts';
import { Scorecard } from './observer/scorecard.ts';
import { draftsFor } from './building/drafts.ts';
import { config, envFile } from './config.ts';
import { EventBus } from './events.ts';
import { attachLogger, JsonlWriter } from './log.ts';
import { WorldMemory } from './memory/store.ts';
import { EpisodicMemory } from './memory/episodic.ts';
import { HindsightBackend } from './memory/hindsight.ts';
import { HindsightUsage } from './memory/hindsight-usage.ts';
import { installProcessHealth, RESTART_EXIT_CODE } from './observer/process-health.ts';
import { sandboxStats } from './codeskills/sandbox.ts';
import { buildingArchiveFor, ownBuildingAt } from './skills/build.ts';
import { flattenProgram, MethodLibrary, simpleToMethod } from './methods/learning.ts';
import { ResourceKnowledge } from './methods/knowledge.ts';
import { ControlKnowledge } from './methods/controls.ts';
import { RecipeBook } from './methods/recipes.ts';
import { createMethodSkills } from './methods/skills.ts';
import { SKILLS } from './skills/index.ts';
import { disabledSkills, isSkillDisabled, loadDisabledSkills, setSkillDisabled } from './skills/disabled.ts';
import { travelStore } from './travel/store.ts';
import { ActionChat } from './observer/action-chat.ts';
import { startDashboard } from './observer/dashboard.ts';
import { dashboardMemory } from './observer/memory-snapshot.ts';
import { LlmTrace } from './planner/llm-trace.ts';
import { Metrics } from './observer/metrics.ts';
import { RunStats } from './observer/run-stats.ts';
import { Spectator } from './observer/spectator.ts';
import { findSurfaceSpot, type SurfaceSpot } from './observer/rescue.ts';
import { ITEM_ZH } from './observer/item-zh.ts';
import { setTimeout as sleep } from 'node:timers/promises';
import { Perception } from './perception/perception.ts';
import { NOTABLE, Vision } from './perception/vision.ts';
import { Ledger } from './mind/ledger.ts';
import { MockProvider, OpenAICompatibleProvider, type LlmProvider } from './planner/llm.ts';
import { ruleProposal } from './planner/plan.ts';
import { Planner } from './planner/planner.ts';
import { liveAudience } from './planner/prompt.ts';
import { AudienceChannel } from './live/audience.ts';
import { BilibiliLive, type LiveMessage, type LiveStatus } from './live/bilibili.ts';
import { DanmakuLog } from './live/danmaku-log.ts';
import { hudLandmarks } from './observer/landmarks-hud.ts';
import { MemorySpend, llmSpend, withMemory } from './observer/llm-spend.ts';
import { SkillLibrary } from './skills/library.ts';
import { ExperienceMiner } from './methods/experience.ts';
import type { TaskOutcome } from './arbiter/arbiter.ts';
import { deathCause, habitName, hazardFact, learnCandidates, signatureOf, type VitalSample } from './brain/habits.ts';
import type { MySkillInfo } from './planner/prompt.ts';
import { ObserverFeed, createObserverHandler, installMineflayerObserver, installTaskObserver, type MineflayerBotLike, type MineflayerObserver } from 'curio-observer';

const bus = new EventBus();
attachLogger(bus, config.dataDir);
// 学技能时判断出的“身体做不到的事”：单独记一份，给开发者补能力用（不要让它在上面一份份写补丁技能）
bus.on('event', (ev: { type: string; ts?: number; msg: string; data?: Record<string, unknown> }) => {
  if (ev.type !== 'body_limit') return;
  try { appendFileSync(path.join(config.dataDir, 'body-limits.jsonl'), JSON.stringify({ ts: Date.now(), ...ev.data }) + '\n'); } catch { /* 记不下也不影响运行 */ }
});

process.on('unhandledRejection', (e: any) => bus.publish('unhandled', 'P1', String(e?.stack ?? e)));
process.on('uncaughtException', (e: any) => bus.publish('uncaught', 'P0', String(e?.stack ?? e)));

const memory = new WorldMemory(path.join(config.dataDir, 'world-memory.json'));
const adapter = new MineflayerAdapter(config, bus);
const vision = new Vision(adapter, config.vision);
const arbiter = new Arbiter(adapter, memory, bus, vision);
const perception = new Perception(adapter, memory, bus, vision);
// 区分“在自家屋里”和“在坑里”：围着自己的墙是不是自己盖的房子
perception.ownBuilt = (pos, block) => { const st = adapter.state(); return ownBuildingAt(memory, { worldId: st.worldId, dim: st.dim }, pos, block); };
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
const llmTrace = new LlmTrace({ dir: config.llmArchiveDir }); // 每次调用的完整记录存进 archives/，清空记忆也不删
const planner = new Planner(config, provider, adapter, memory, bus, new JsonlWriter(path.join(config.dataDir, 'logs'), 'llm'), llmTrace, episodic,
  new ControlKnowledge(path.join(config.dataDir, 'control-knowledge.json')));
/**
 * 后台写代码的“工程师”（造技能、改进代码技能）：配置了 CODER_LLM_MODEL 就用它（通常更强、可以想得久），
 * 否则就用主心智的模型。单独的每小时预算，不和主心智抢调用次数。
 */
const coderCfg = { ...config, llm: { ...config.llm,
  ...(config.coder.model ? { model: config.coder.model } : {}),
  ...(config.coder.baseUrl ? { baseUrl: config.coder.baseUrl } : {}),
  ...(config.coder.apiKey ? { apiKey: config.coder.apiKey } : {}),
  // 写代码的模型另有价格就用它的；同一个模型沿用 LLM_PRICE
  ...(config.coder.price ? { price: config.coder.price } : config.coder.model && config.coder.model !== config.llm.model ? { price: '' } : {}),
  reasoningEffort: config.coder.reasoningEffort, maxTokens: config.coder.maxTokens, timeoutMs: config.coder.timeoutMs,
  maxCallsPerHour: config.coder.maxCallsPerHour, jsonMode: true } };
const coderPlanner = config.llm.provider === 'openai'
  ? new Planner(coderCfg, new OpenAICompatibleProvider(coderCfg.llm), adapter, memory, bus, new JsonlWriter(path.join(config.dataDir, 'logs'), 'llm-coder'), llmTrace)
  : planner;
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
// 事件循环被卡住（同步算得太久）时，服务器收不到心跳回包，30 秒就以超时踢人：卡超过 3 秒就记下来，带上当时在做什么，
// 以及那段时间 CPU 都花在哪几个函数上（完整采样存到 data/logs/stall-*.cpuprofile，可以用 Chrome DevTools 打开）
{
  let last = Date.now();
  setInterval(() => {
    const now = Date.now(), stall = now - last - 1000;
    last = now;
    if (stall < 3000) return;
    const task = arbiter.info();
    bus.publish('event_loop_stall', 'P1', `主线程卡住了 ${(stall / 1000).toFixed(1)} 秒（超过 15~30 秒服务器会以超时踢掉）；当时手上：${task ? `${task.source} ${task.skill}` : '空闲'}`, { stallMs: stall, task: task?.skill ?? null });
  }, 1000).unref();
  if (process.env.STALL_PROFILER !== '0') startStallProfiler(path.join(config.dataDir, 'logs'), (r) => {
    bus.publish('event_loop_profile', 'P1', `卡顿那段时间 CPU 花在：${r.top.join('；')}${r.file ? `（完整采样：${path.basename(r.file)}）` : ''}`, { stallMs: r.stallMs, top: r.top, file: r.file });
  });
}
// ------------------------------------------------------------ 直播间（可选）：弹幕只作参考
const audience = config.live.bilibili.enabled ? new AudienceChannel(config.live.audience, bus) : null;
const live = config.live.bilibili.enabled ? new BilibiliLive(config.live.bilibili, { log: (sev, msg) => bus.publish('live', sev, msg) }) : null;
const danmakuLog = new DanmakuLog(config.danmakuArchiveDir, (msg) => bus.publish('live', 'P1', msg));
if (live && audience) {
  liveAudience.enabled = true;
  live.on('message', (m: LiveMessage) => { danmakuLog.record(m, audience.ingest(m)); });
  live.on('status', (st: LiveStatus) => bus.publish('live_status', st.state === 'error' ? 'P1' : 'P3', `B 站直播间：${st.state}${st.detail ? `（${st.detail}）` : ''}`));
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

/** 已经提过的习惯签名（非自主模式的旧路径用） */
const proposedHabits = new Set<string>();

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

// 习惯化：同一套步骤成功 3 次以上，自动学成技能（不必等 LLM 提议）
const onGoalEnd = (status: string) => {
  if (status !== 'succeeded') return;
  const c = learnCandidates(memory, knownSigs()).find((x) => x.times >= 3 && !proposedHabits.has(x.signature));
  if (!c) return;
  // 自主模式不再另养“习惯”：一再重复的同一串动作由后台写技能（smith 的 repeated）统一管，免得两套检测各学一份
  if (planner.autonomous) return;
  const r = library.learn({ name: habitName(c), description: `习惯：${c.goal}`, steps: c.steps });
  if (r.ok) bus.publish('habit', 'P2', `「${c.signature}」做了 ${c.times} 次，养成习惯 ${r.name}`);
};

// 技能书（内置的 skills/ 和自己写的 data/skills/）与建筑图纸库
const skillBook = new SkillBook(BUILTIN_SKILLS_DIR, path.join(config.dataDir, 'skills'));
/** 行为技能：带触发条件和步骤的技能，模型写下就生效（自动做、失败时先试、或 use_skill 调用） */
const behaviors = new BehaviorEngine(skillBook, adapter, arbiter, bus, vision, path.join(config.dataDir, 'skill-stats.json'));
setBehaviorRegistry(behaviors);
setReliableSkills((name) => behaviors.reliable(name));
/** 代码技能老失败（或心智要求）时，在后台单独请模型改进代码；限频，不会太频繁 */
const improver = new CodeImprover(coderPlanner, behaviors, bus, { globalGapMs: config.mind.skillImproveGapMin * 60_000, maxPerHour: config.mind.skillImproveMaxPerHour, maxRounds: config.mind.skillImproveMaxRounds });
/** 从经历里总结新技能：心智点名、定期回顾、吃了比平时大的亏、死亡 */
const smith = new SkillSmith(coderPlanner, behaviors, skillBook, bus, () => adapter.state(),
  // 回顾用的“这段时间做过的事”（回调执行时 selfModel 已经建好）
  () => selfModel.history(30).map((r) => `${r.what} → ${r.outcome}（${r.durationSec}s${Object.keys(r.gained).length ? `，得到 ${Object.entries(r.gained).map(([k, v]) => `${k}×${v}`).join(' ')}` : ''}）${r.outcome !== 'done' ? `：${r.summary.slice(0, 80)}` : ''}`),
  { maxPerHour: config.mind.skillForgeMaxPerHour, repeatMs: config.mind.skillForgeRepeatMin * 60_000,
    batchMs: config.mind.skillForgeBatchSec * 1000, ownersFile: path.join(config.dataDir, 'skill-owners.json') });
smith.start();
/** 收获账本：每段活的投入产出、东西出现在哪（高度、群系、维度），不针对哪种东西；拿某样东西明显比平时费劲/省事就交给造技能的对比 */
const ledger = new Ledger(path.join(config.dataDir, 'ledger.json'), bus, () => adapter.state(),
  () => ({ blocks: [...vision.visibleNow.values()].filter((b) => NOTABLE.has(b.name)), entities: vision.perceivedEntities(24) }),
  (from, to) => behaviors.usedBetween(from, to));
ledger.onSignal = (sig) => smith.efficiency(sig);
let loopCurateAt = 0;
bus.on('event', (ev: { type: string; msg: string; data?: Record<string, unknown> }) => {
  // 拉锯要尽快理清，但至少隔 10 分钟（拉锯越多整理越勤，整理本身又在制造拉锯）
  if (ev.type === 'skill_loop' && Date.now() - loopCurateAt >= 10 * 60_000) { loopCurateAt = Date.now(); setTimeout(() => void curator.check(), 1000).unref?.(); }
  // 技能被停用不再自动交给后台同名重写（那会形成“写→停用→重写→收起”的闭环）；心智会注意到，要改由它自己决定
});
smith.ledger = ledger;
improver.ledger = ledger;
ledger.start();
/** 技能多了定期整理：收起长期用不上的，后台合并说同一件事的、调整谁先上 */
const skillClock = new ObservedGameClock(path.join(config.dataDir, 'skill-game-clock.json'));
if (skillClock.loadError) bus.publish('skill_clock_unknown', 'P2', `技能游戏时间记录无法读取，从新观察开始：${skillClock.loadError}`);
const curator = new SkillCurator(coderPlanner, behaviors, skillBook, bus, {}, skillClock, path.join(config.dataDir, 'skill-lifetimes.json'));
curator.ledger = ledger;
curator.dim = () => adapter.state().dim;
curator.observation = () => ({ state: adapter.state(), paused: arbiter.paused });
curator.start();
/** 学习曲线：给玩法打分（进度、生存、学习、效率），按每条命记到达里程碑的用时 */
const scorecard = new Scorecard(bus, () => adapter.state(), path.join(config.dataDir, 'scorecard.json'), () => ({
  skills: behaviors.list().map((b) => behaviors.statsOf(b.name) ?? { ok: 0, fail: 0 }),
  knowHow: selfModel.data.knowHow, // 回调在定时取样时才执行，那时 selfModel 已经建好
  housesComplete: (() => { try { return buildingArchiveFor(memory).list().filter((p) => p.status === 'complete').length; } catch { return 0; } })(),
}));
scorecard.start();
behaviors.drops = () => {
  const d = memory.lastDeath(), s = adapter.state();
  if (!d || !d.lost.length || d.dim !== s.dim) return null;
  const left = Math.max(0, Math.round((d.ts + 300_000 - Date.now()) / 1000));
  return { dist: Math.round(Math.hypot(d.pos.x - s.pos.x, d.pos.y - s.pos.y, d.pos.z - s.pos.z)), leftS: left, count: d.lost.reduce((n, i) => n + i.count, 0) };
};
behaviors.improve = (name, why, note) => { const skipped = improver.consider(name, why, note); if (skipped && why !== 'failures') bus.publish('skill_improve_skipped', 'P3', `先不改「${name}」：${skipped}`); };
draftsFor(memory);
/** 大脑：像真人一样一段一段地玩的心智层 */
try {
  const correction = applyMindPatch(config.dataDir);
  if (correction) bus.publish('mind_patch', 'P2', correction);
} catch (e) {
  bus.publish('mind_patch', 'P1', `mind-patch.json 没套用：${String(e)}`);
}
const selfModel = new SelfModel(path.join(config.dataDir, 'mind.json'), config.mind.traits);
const mind = new Mind({
  adapter, arbiter, perception, memory, bus, self: selfModel, persona: config.persona,
  thinker: Object.assign(new Thinker(planner, adapter, memory, bus, skillBook, new KnowledgeBase(config.mc.version)), { ledger }),
  behaviors,
  ledger,
  onWorthLearning: (note: string) => smith.noted(note),
  onGoalStuck: (goal, lines) => smith.goalStuck(goal, lines),
  ...(audience ? { audience } : {}),
  mySkills,
  researchContext: () => methods.researchContext(),
  progress: () => scorecard.progressFacts(),
  onGoalEnd,
  say: (text) => { if (config.actionChat.enabled) adapter.chat(text); },
  timing: { checkInMs: config.mind.checkInSec * 1000, deliberateEveryMs: config.mind.deliberateEverySec * 1000 },
});
const executive = mind;
/** 已经学过（宏或方法库里）的步骤签名：不再重复提示/提议 */
const knownSigs = () => new Set([...library.list().filter((d) => !d.disabled).map((d) => signatureOf(d.steps)),
  ...methods.list().filter((d) => d.status !== 'retired').map((d) => signatureOf(flattenProgram(d.program))), ...proposedHabits]);
perception.knownSkillSigs = knownSigs;
const reflex = new Reflex(adapter, arbiter, bus, vision, { routineCare: config.mind.bodyHabits, habits: () => selfModel.habits(), behaviors, instincts: 'skills' });
/** 哪些本能代码真的会做：如实告诉心智和写技能的模型（躲怪、还手现在靠自己写的技能） */
setInstinctSource(() => reflex.activeInstincts());
const spectator = new Spectator(config, adapter, bus);
const metrics = new Metrics(adapter, arbiter, executive, planner, reflex, bus);
/** 一次测试从头到尾的累计数字（死亡、token、调用次数、任务成败、路程、运行时长）：重启不清零，清空记忆/重置世界才从零开始 */
/** Hindsight 自己调 LLM 的用量（不经过 Curio，本地日志里没有）：读它的 /metrics，累计进本次测试 */
const memoryLlm = config.memory.provider === 'hindsight' ? new HindsightUsage({ baseUrl: config.memory.baseUrl, apiKey: config.memory.apiKey }) : null;
const runStats = new RunStats(path.join(config.dataDir, 'run-stats.json'), metrics, { main: planner, coder: coderPlanner !== planner ? coderPlanner : null },
  { memoryLlm });
runStats.start();
memoryLlm?.start();
const actionChat = new ActionChat(adapter, bus, { ...config.actionChat, canSend: () => !executive.paused,
  context: () => ({ plan: executive.plan, task: arbiter.info(), intent: mind.currentIntent() }),
});
actionChat.start();

// ------------------------------------------------------------ Curio Observer（观察者客户端模组的数据流）
const feed = config.observerFeed ? new ObserverFeed({ botName: config.mc.username, mcVersion: config.mc.version, agentVersion: '0.3.0',
  hudConfigPath: config.observerHudConfig }) : null;
/** 直播 HUD 的 LLM 用量：游戏和记忆分开的上传/下载 token、缓存命中，每分钟速率、模型和真实花费（合计 + 其中记忆） */
const memorySpend = memoryLlm ? new MemorySpend(memoryLlm, { price: config.memoryLlmPrice, holidays: config.llm.priceHolidays }) : null;
const currentSpend = () => withMemory(llmSpend([planner, coderPlanner], { holidays: config.llm.priceHolidays }), memorySpend?.sample(),
  Date.now(), config.llm.priceHolidays);
const observerTasks = feed ? installTaskObserver(feed, arbiter, {
  interests: () => perception.snapshot()?.drives ?? [],
  stats: () => ({ deaths: metrics.counters.deaths, totalTokens: runStats.totalTokens(), uptimeSec: metrics.uptimeSec(), ...currentSpend() }),
}) : null;
let observedBot: unknown = null;
let observerInstall: MineflayerObserver | null = null;
let inventoryUiHooked = false;
/** 每次创建新的 Mineflayer bot（首次连接、断线重连）时重新挂载；同一个 bot 的重生不重复挂载 */
function attachObserver() {
  if (!feed || !adapter.bot || adapter.bot === observedBot) return;
  observerInstall?.dispose();
  // 如有配置，界面等待由适配器统一处理；数据流不再额外包装 clickWindow。
  observerInstall = installMineflayerObserver(adapter.bot as MineflayerBotLike, feed, { pacingMs: 0 });
  // 整批合成不经过 bot.craft，数据流看不到背包 2×2 合成的“界面打开/关闭”；由适配器在合成前后发事件
  if (!inventoryUiHooked) {
    inventoryUiHooked = true;
    adapter.on('inventory_open', () => { if (observedBot && feed.isAttached(observedBot as MineflayerBotLike)) feed.openInventory(); });
    adapter.on('inventory_close', () => { if (observedBot && feed.isAttached(observedBot as MineflayerBotLike)) feed.closeInventory(); });
  }
  observedBot = adapter.bot;
  bus.publish('observer_feed', 'P3', `Curio Observer 数据流已挂载到 ${config.mc.username}`);
}
// 直播 HUD「此刻的想法」：和控制台「在想」同一来源——最近一次决策的独白，没有就取最近一条独白——
// 一直显示到有新的想法为止（游戏内聊天仍走跟动作绑定、会过期的表达状态）
let hudThoughtKey = '';
if (feed) setInterval(() => {
  const thought = mind.lastDecision?.monologue || selfModel.recentThoughts(10).filter((t) => t.kind === 'monologue').at(-1)?.text || '';
  const goal = mind.currentIntent()?.text ?? '';
  const key = goal + '\u0000' + thought;
  if (key === hudThoughtKey) return;
  hudThoughtKey = key;
  feed.thought(goal, thought);
}, 500).unref();
// 直播 HUD「记得的地点」：家、最近的死亡点、自己的东西和资源，每秒按当前位置刷新距离
if (feed) setInterval(() => {
  try {
    const s = adapter.state();
    feed.landmarks(hudLandmarks(memory.landmarks(), s.observationReady ? { pos: s.pos, dim: s.dim } : null)
      .map((landmark) => ({ ...landmark, kind: landmark.kind === 'herd' ? 'discovery' as const : landmark.kind })));
  } catch { /* 还没连上服务器 */ }
}, 1000).unref();
if (memory.migrated) bus.publish('memory', 'P1', `清理了 ${memory.migrated} 个旧版本留下的地标（当时的矿物位置是穿墙搜到的，不算亲眼所见）`);
if (memory.patched.length) bus.publish('memory', 'P1', `套用了人工记忆修正：${memory.patched.join('；')}`);


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
        bus.publish('death_items', 'P1', `死亡掉落：${lost.map((i) => `${i.name}×${i.count}`).join('、')}（物品经过 6000 个实体刻后消失，区块未加载时不会继续计时）`);
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

// 游戏自己的系统消息：死亡播报、成就、进出服务器、公告。原样记进记忆（死因以游戏播报为准）
const gameLog: { at: number; text: string; parsed: ParsedGameMessage }[] = [];
let lastDeathAt = 0;
adapter.on('game_message', (text: string) => {
  const s = adapter.state();
  const parsed = parseGameMessage(text, s.username);
  gameLog.push({ at: Date.now(), text: parsed.text, parsed });
  if (gameLog.length > 50) gameLog.splice(0, gameLog.length - 50);
  bus.publish('game_message', parsed.kind === 'death_self' ? 'P1' : 'P3', parsed.text, { kind: parsed.kind, ...(parsed.cause ? { cause: parsed.cause } : {}), ...(parsed.by ? { by: parsed.by } : {}) });
  if (parsed.kind === 'death_self' || parsed.kind === 'advancement_self') memory.addNote('fact', `游戏提示：${parsed.text}`, s.dim, s.pos);
  // 死亡事件先到、播报后到：补记到这次死亡上
  if (parsed.kind === 'death_self' && Date.now() - lastDeathAt < 6000) {
    memory.updateDeathMessage(parsed.text, parsed.cause);
    executive.onGameMessage(parsed);
  } else executive.onGameMessage(parsed);
});
const recentDeathMessage = () => [...gameLog].reverse().find((m) => m.parsed.kind === 'death_self' && Date.now() - m.at < 4000);

adapter.on('death', () => {
  const s = adapter.state();
  lastDeathAt = Date.now();
  // 死因优先用游戏的死亡播报；没有播报时由程序根据死前的真实状态判断
  sampleVitals();
  const told = recentDeathMessage();
  const guessed = deathCause(vitals, lastHurt);
  const cause = told?.parsed.cause && told.parsed.cause !== 'unknown' ? told.parsed.cause : 'unknown';
  const causeSource = told ? 'game_message' : guessed !== 'unknown' ? 'state_inference' : 'unknown';
  const causeText = told ? `游戏播报：${told.text}` : guessed !== 'unknown' ? `状态推测死因：${guessed}（未经游戏播报确认）` : '死因未确认';
  const during = vitals.at(-1)?.task ?? lastWork;
  vitals = [];
  let hazard: ReturnType<typeof memory.addHazard> | null = null;
  try {
    const h = hazard = memory.addHazard({ dim: s.dim, pos: s.pos, kind: cause, note: told ? causeText : '死因未确认', ...(during ? { during } : {}) });
    memory.addNote('fact', hazardFact(h), s.dim, s.pos);
    if (causeSource === 'state_inference') memory.addNote('inference', causeText, s.dim, s.pos);
  } catch (e) { bus.publish('memory', 'P1', `记录危险区域失败：${String((e as Error)?.message ?? e)}`); }
  memory.addLandmark('death', '死亡地点', s.dim, s.pos, 4);
  memory.setDeath({ ts: Date.now(), dim: s.dim, pos: s.pos, lost: invSnapshot, cause: causeText, ...(told ? { message: told.text } : {}) });
  awaitingRespawnLoss = true;
  bus.publish('death', 'P0', `死亡 @ (${Math.round(s.pos.x)}, ${Math.round(s.pos.y)}, ${Math.round(s.pos.z)})，${causeText}${during ? `（在做 ${during}）` : ''}`, { cause, causeSource, ...(causeSource === 'state_inference' ? { suspectedCause: guessed } : {}), during, ...(told ? { message: told.text } : {}) });
  executive.onDeath({ cause: causeText, hazard, during, ...(told ? { message: told.text } : {}) });
});
// 盾挡下了一击：副手盾的耐久掉了而人没挨打。这是举盾有用的直接反馈（给心智和学技能的看）
let shieldDurSeen: number | null = null;
setInterval(() => {
  try {
    const d = adapter.state().equipment?.find((e) => e.slot === 'off-hand' && e.name === 'shield')?.durabilityRemaining;
    if (d === undefined) { shieldDurSeen = null; return; }
    if (shieldDurSeen !== null && d < shieldDurSeen) bus.publish('blocked', 'P2', `举盾挡下了攻击（盾耐久 -${shieldDurSeen - d}，剩 ${d}）`, { shieldLeft: d });
    shieldDurSeen = d;
  } catch { /* 状态暂不可用 */ }
}, 400).unref?.();
adapter.on('hurt', (cause?: string) => {
  if (Date.now() - lastHurt < 1000) return;
  lastHurt = Date.now();
  // entityHurt 先于生命值更新到达，稍等再读
  // 挨打那一刻盾举没举（只记事实；举不举、什么时候举由它自己学）
  const combat = adapter.combatState?.();
  // 淹水、岩浆、摔落、饿这些盾挡不了，不提
  const shield = combat?.offHand === 'shield' && !/没气|溺|岩浆|lava|着火|火|摔|饿/.test(cause ?? '') ? (combat.usingItem ? '举着盾也挨了' : '副手有盾但没举') : '';
  setTimeout(() => {
    const st = adapter.state();
    const around = [cause, shield].filter(Boolean).join('；');
    bus.publish('hurt', 'P1', `受到伤害，生命 ${st.hp.toFixed(1)}${st.inWater ? `，氧气 ${st.oxygen}/20` : ''}${around ? `（当时：${around}）` : ''}`, around ? { around, ...(shield ? { shield } : {}) } : undefined);
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
  const state = adapter.state();
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
    state,
    percept: perception.snapshot(),
    vision: vision.frame,
    task: arbiter.info(),
    planVersion: arbiter.planVersion,
    exec: executive.snapshot(),
    expression: actionChat.snapshot(),
    travel: travelStore(memory).snapshot(state.worldId),
    methods: { definitions: methods.list().slice(-12), gaps: methods.abilityGaps().slice(-8) },
    episodicMemory: episodic.snapshot(),
    metrics: metrics.snapshot(),
    memoryLlm: memoryLlm?.snapshot() ?? null,
    skills: { list: [...behaviors.list().filter((b) => !b.candidate), ...behaviors.list(true)].map((b) => {
      const stats = behaviors.statsOf(b.name);
      const candidate = !!b.candidate;
      const blocked = behaviors.executionError(b.name, candidate);
      const retired = candidate ? behaviors.candidateRetirement(b.name)?.why ?? (blocked ? stats?.retired : null) ?? null : stats?.retired ?? null;
      return { name: b.name, description: b.description, mode: b.mode, source: b.source, code: !!b.code, version: b.version ?? null, candidate,
        overrides: b.overrides, priority: b.priority, stats: { ...behaviors.currentStats(b.name, candidate),
          disabled: !retired && !!blocked, retired, lastError: stats?.recent?.filter((run) => run.version === (b.version ?? 1) && !run.ok).at(-1)?.summary ?? null } };
    }),
      knowledge: skillBook.list().filter((k) => k.behavior === undefined).map((k) => ({ name: k.name, description: k.description, source: k.source, retired: behaviors.statsOf(k.name)?.retired ?? null })),
      improving: improver.busy ? { name: improver.busy.name, sinceSec: Math.round((Date.now() - improver.busy.startedAt) / 1000) } : null,
      forging: smith.busy ? { kind: smith.busy.kind, sinceSec: Math.round((Date.now() - smith.busy.startedAt) / 1000) } : null,
      forged: smith.history.slice(-6), curating: curator.busy, curated: curator.history.slice(-4) },
    learning: { ...scorecard.summary(), ledger: ledger.summary() },
    spectator: spectator.status,
    live: live ? { status: live.status(), audience: audience?.stats() } : null,
    llmSpend: currentSpend(),
    memory: {
      ...dashboardMemory(memory, state, adapter.eye()?.yaw ?? null),
      objective: memory.objective(),
      intentions: memory.intents().slice(-12),
      preferences: memory.preferences(),
      decisions: memory.decisions().slice(-10),
      projects: memory.projects().slice(-10),
      artifacts: buildingArchiveFor(memory).list().filter((p) => p.worldId === state.worldId && p.dimension === state.dim).slice(-8).map((p) => ({ id: p.id, status: p.status,
        name: p.versions.at(-1)?.spec.name, version: p.versions.at(-1)?.version, defects: p.inspections.at(-1)?.defects.length,
        feedback: p.feedback.slice(-3) })),
      lessons: memory.lessonsFor(8),
      mySkills: mySkills(),
      skills: library.list().map((d) => ({ name: d.name, description: d.description, steps: d.steps.length, ...(d.disabled ? { disabled: d.disabled } : {}) })),
      seen: memory.seenCount(),
      visitedChunks: memory.visitedChunkCount,
    },
  };
}

bus.publish('boot', 'P2', `Minecraft Curiosity Agent MVP 启动｜心智=${planner.autonomous ? '真人式心智' : '真人式心智（规则）'}｜LLM=${provider.name}（LLM_PROVIDER=${config.llm.providerLabel}）｜视觉 ${config.vision.hFov}°/${config.vision.range} 格｜延迟注入=${config.llm.fakeDelayMs}ms`);
adapter.connect();
perception.start();
executive.start();
reflex.start();
spectator.start();
metrics.start();
live?.start();
loadDisabledSkills(config.dataDir);
const dashboard = startDashboard(config.dashboard.host, config.dashboard.port, bus, {
  snapshot,
  danmaku: (q) => q.get('dates') === '1' ? { dates: danmakuLog.dates() } : danmakuLog.query({
    date: q.get('date') ?? undefined, q: q.get('q') ?? undefined, questions: q.get('questions') === '1',
    blocked: q.get('blocked') === '1', limit: Number(q.get('limit')) || undefined,
  }),
  pause: () => executive.pause(),
  resume: () => executive.resume(),
  replan: () => executive.replan(),
  suggest: (t) => executive.suggest(t),
  give: (item, count) => give(item, count),
  listItems: () => (adapter.listItems?.() ?? []).map((name) => ({ name, zh: ITEM_ZH[name] ?? '' })),
  killEntities: (type, radius) => killEntities(type, radius),
  listEntities: () => listEntities(),
  spectate: (on) => spectator.setActive(on),
  rescue: () => rescue(),
  dawn: () => dawn(),
  curateSkills: async () => {
    if (curator.busy) return { ok: false, busy: true, error: '正在整理技能，请等待本次完成' };
    const result = await curator.check(Date.now(), { force: true });
    return result === null ? { ok: false, error: curator.history.at(-1)?.result ?? '技能整理未完成，请查看运行日志' } : { ok: true, result };
  },
  listSkills: () => [
    ...Object.values(SKILLS).map((s) => ({ name: s.name, kind: 'builtin' as const, disabled: isSkillDisabled(s.name), description: s.description.slice(0, 80) })),
    ...behaviors.list().map((b) => { const st = behaviors.statsOf(b.name); return { name: b.name, kind: 'self' as const, disabled: !!st?.disabled || !!st?.retired, retired: st?.retired, description: b.description?.slice(0, 80), version: b.version, candidate: b.candidate }; }),
  ].sort((a, b) => a.name.localeCompare(b.name)),
  setSkill: (name, disabled) => {
    if (SKILLS[name]) { setSkillDisabled(name, disabled); return { ok: true }; }
    if (!behaviors.get(name)) return { ok: false, error: `未知技能：${name}` };
    if (disabled) { behaviors.retire(name, '控制台手动禁用'); return { ok: true }; }
    return behaviors.restore(name) ? { ok: true } : { ok: false, error: `${name} 当前未禁用` };
  },
  deleteSkill: (name) => {
    if (SKILLS[name]) { setSkillDisabled(name, true); return { ok: true }; }
    if (!behaviors.get(name)) return { ok: false, error: `没有可删除的自学技能 ${name}` };
    behaviors.retire(name, '控制台删除');
    try { rmSync(path.join(config.dataDir, 'skills', name), { recursive: true, force: true }); } catch (e) { return { ok: false, error: `删除文件失败：${(e as Error).message}` }; }
    return { ok: true };
  },
  clearSkills: async () => {
    const skillsDir = path.join(config.dataDir, 'skills');
    const names = new Set(skillBook.list().filter((k) => k.source === 'self').map((k) => k.name));
    if (existsSync(skillsDir)) {
      for (const entry of readdirSync(skillsDir, { withFileTypes: true })) if (entry.isDirectory()) names.add(entry.name);
    }
    if (!names.size) return { ok: true, cleared: 0 };
    let cleared = 0;
    const errors: string[] = [];
    for (const name of names) {
      try { rmSync(path.join(skillsDir, name), { recursive: true, force: true }); cleared++; }
      catch (e) { errors.push(`${name}：${(e as Error).message}`); }
    }
    if (errors.length) return { ok: false, error: `部分技能删除失败（已删 ${cleared} 个）：${errors.join('；')}` };
    behaviors.forgetStats(names);
    skillBook.reload();
    bus.publish('skills_cleared', 'P1', `控制台清除了全部 ${cleared} 个自学技能`, { cleared });
    return { ok: true, cleared };
  },
}, feed ? [createObserverHandler(feed)] : [], { llmTrace, mcVersion: config.mc.version, env: { file: envFile, backupDir: path.join(config.dataDir, 'env-backups') } });
installSkillRestoreRequest(dashboard, behaviors, bus, path.join(config.dataDir, 'skill-restore-request.json'));

/**
 * 紧急救援（控制台按钮）：卡在坑底、矿道、墙缝里出不来时，找周围最近的露天平地，用 RCON /tp 传送过去。
 * 只用 RCON，不用重启服务器；先停下手上的事、下船，传送后让它按新位置重新想。
 */
let rescuing = false;
async function rescue(): Promise<{ ok: boolean; error?: string; to?: SurfaceSpot; from?: { x: number; y: number; z: number } }> {
  if (rescuing) return { ok: false, error: '上一次救援还没做完' };
  const s = adapter.state();
  if (!s.connected) return { ok: false, error: 'Bot 没连上服务器' };
  if (s.dim !== 'overworld') return { ok: false, error: `现在在 ${s.dim}，那里没有地表，紧急救援只支持主世界` };
  const from = { x: Math.round(s.pos.x * 10) / 10, y: Math.round(s.pos.y * 10) / 10, z: Math.round(s.pos.z * 10) / 10 };
  const spot = findSurfaceSpot((p) => adapter.blockAt(p), s.pos);
  if (!spot) return { ok: false, error: '周围 80 格内没找到露天平地（可能区块没加载，或全是水面/树冠）', from };
  rescuing = true;
  try {
    arbiter.cancel('紧急救援');
    if (adapter.state().riding && adapter.dismount) { try { await adapter.dismount(AbortSignal.timeout(3000)); } catch { /* tp 也会把人从载具上拉下来 */ } }
    try {
      await spectator.command(`tp ${config.mc.username} ${spot.x + 0.5} ${spot.y} ${spot.z + 0.5}`);
    } catch (e: any) {
      bus.publish('rescue', 'P1', `紧急救援失败：RCON 命令没发出去（${e?.message ?? e}）`);
      return { ok: false, error: `RCON 失败：${e?.message ?? e}`, from };
    }
    // 游戏里给所有人（主播的旁观客户端也在内）弹一行字幕、发一条聊天；失败不影响救援本身
    const notice = '紧急救援：主包的大手发力，拯救了鱼鱼';
    for (const cmd of [
      'title @a times 10 70 20',
      `title @a subtitle ${JSON.stringify({ text: notice, color: 'gold', bold: true })}`,
      `title @a title ${JSON.stringify({ text: '' })}`,
      `tellraw @a ${JSON.stringify({ text: notice, color: 'gold' })}`,
    ]) {
      try { await spectator.command(cmd); } catch { /* ignore */ }
    }
    for (let i = 0; i < 30; i++) { // 等服务器把新位置发回来
      const p = adapter.state().pos;
      if (Math.hypot(p.x - spot.x - 0.5, p.z - spot.z - 0.5) < 1.5 && Math.abs(p.y - spot.y) < 2) break;
      await sleep(100);
    }
    const at = (p: { x: number; y: number; z: number }) => `(${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)})`;
    bus.publish('rescue', 'P1', `紧急救援：操作者把我从 ${at(from)} 传送到最近的地表 ${at(spot)}（水平 ${spot.dist} 格外）`, { from, to: spot });
    mind.rescued(`刚才卡在 ${at(from)} 出不来，操作者把我传送到了地表 ${at(spot)}：先看清周围，再决定接着做什么`);
    return { ok: true, from, to: spot };
  } finally {
    rescuing = false;
  }
}

let shuttingDown = false;

/**
 * 一键天亮（控制台按钮）：用 RCON /time set day 把游戏时间跳到白天。
 * 顺手给所有人（主播的旁观客户端也在内）弹字幕、发聊天；然后让心智按“现在是白天”重新想。
 */
let dawning = false;
async function dawn(): Promise<{ ok: boolean; error?: string }> {
  if (dawning) return { ok: false, error: '上一次天亮还没做完' };
  const s = adapter.state();
  if (!s.connected) return { ok: false, error: 'Bot 没连上服务器' };
  dawning = true;
  try {
    try {
      await spectator.command('time set day');
    } catch (e: any) {
      bus.publish('dawn', 'P1', `天亮失败：RCON 命令没发出去（${e?.message ?? e}）`);
      return { ok: false, error: `RCON 失败：${e?.message ?? e}` };
    }
    const notice = '天亮了：主包看不下去了';
    for (const cmd of [
      'title @a times 10 70 20',
      `title @a subtitle ${JSON.stringify({ text: notice, color: 'gold', bold: true })}`,
      `title @a title ${JSON.stringify({ text: '' })}`,
      `tellraw @a ${JSON.stringify({ text: notice, color: 'gold' })}`,
    ]) {
      try { await spectator.command(cmd); } catch { /* ignore */ }
    }
    bus.publish('dawn', 'P1', `天亮：操作者把时间跳到了白天`, { notice });
    executive.replan();
    return { ok: true };
  } finally {
    dawning = false;
  }
}

/**
 * 给予物品（控制台）：用 RCON /give 把物品塞进 Bot 背包。
 * 物品名先去 minecraft: 前缀、按已知物品校验；数量夹在 1–640。
 */
let giving = false;
async function give(item: string, count: number): Promise<{ ok: boolean; error?: string; item?: string; count?: number }> {
  if (giving) return { ok: false, error: '上一次给予还没做完' };
  const s = adapter.state();
  if (!s.connected) return { ok: false, error: 'Bot 没连上服务器' };
  const name = item.toLowerCase().replace(/^minecraft:/, '');
  if (!adapter.isKnownItem(name)) return { ok: false, error: `未知物品：${item}` };
  const n = Math.max(1, Math.min(640, Math.floor(count)));
  giving = true;
  try {
    await spectator.command(`give ${config.mc.username} ${name} ${n}`);
    bus.publish('give', 'P2', `主包给予鱼鱼「${ITEM_ZH[name] ?? name}」×${n}`, { item: name, count: n });
    return { ok: true, item: name, count: n };
  } catch (e: any) {
    bus.publish('give', 'P1', `给予失败：RCON 命令没发出去（${e?.message ?? e}）`);
    return { ok: false, error: `RCON 失败：${e?.message ?? e}`, item: name, count: n };
  } finally {
    giving = false;
  }
}

/** 实体英文名 → 中文名：优先用刷怪蛋的中文翻译（zombie → 僵尸），没有就原样返回。 */
const entityZh = (name: string): string => {
  const zh = ITEM_ZH[`${name}_spawn_egg`] ?? ITEM_ZH[name];
  return zh ? zh.replace(/刷怪蛋$/, '') : name;
};

/** 所有可处死的生物类型（有刷怪蛋的都能 /kill）：英文名 + 中文名，供控制台「清除实体」中英文搜索。 */
function listEntities(): { name: string; zh: string }[] {
  const out: { name: string; zh: string }[] = [];
  for (const item of adapter.listItems?.() ?? []) {
    if (!item.endsWith('_spawn_egg')) continue;
    const name = item.slice(0, -'_spawn_egg'.length);
    out.push({ name, zh: entityZh(name) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 清除实体（控制台按钮）：用 RCON /kill 杀掉 Bot 周围指定类型、指定半径内的所有实体。
 * 类型要合法（防注入）、不能是玩家（会把 Bot 和旁观的人一起杀掉）；成功后给所有人弹字幕、发聊天。
 */
let killingEntities = false;
async function killEntities(type: string, radius: number): Promise<{ ok: boolean; error?: string; type?: string; radius?: number }> {
  if (killingEntities) return { ok: false, error: '上一次清除还没做完' };
  const s = adapter.state();
  if (!s.connected) return { ok: false, error: 'Bot 没连上服务器' };
  const name = type.toLowerCase().replace(/^minecraft:/, '').trim();
  if (!/^[a-z0-9_.:-]+$/.test(name)) return { ok: false, error: `非法的生物类型：${type}` };
  if (name === 'player') return { ok: false, error: '别清除玩家：会把 Bot 和旁观的人一起杀掉' };
  const r = Math.max(1, Math.min(128, Math.floor(radius)));
  killingEntities = true;
  try {
    const p = s.pos;
    await spectator.command(`kill @e[type=${name},x=${p.x.toFixed(1)},y=${p.y.toFixed(1)},z=${p.z.toFixed(1)},distance=..${r}]`);
    const zh = entityZh(name);
    const notice = `紧急救援：主包对「${zh}」大开杀戒了`;
    for (const cmd of [
      'title @a times 10 70 20',
      `title @a subtitle ${JSON.stringify({ text: notice, color: 'gold', bold: true })}`,
      `title @a title ${JSON.stringify({ text: '' })}`,
      `tellraw @a ${JSON.stringify({ text: notice, color: 'gold' })}`,
    ]) {
      try { await spectator.command(cmd); } catch { /* ignore */ }
    }
    bus.publish('kill', 'P1', `清除实体：主包对周围 ${r} 格内的「${zh}」大开杀戒`, { type: name, radius: r });
    return { ok: true, type: name, radius: r };
  } catch (e: any) {
    bus.publish('kill', 'P1', `清除实体失败：RCON 命令没发出去（${e?.message ?? e}）`);
    return { ok: false, error: `RCON 失败：${e?.message ?? e}`, type: name, radius: r };
  } finally {
    killingEntities = false;
  }
}

/** code：0 正常退出；RESTART_EXIT_CODE 请守护进程重启 */
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  bus.publish('shutdown', 'P1', '正在退出，保存记忆…');
  arbiter.cancel('退出');
  executive.stop();
  actionChat.stop();
  void live?.stop();
  episodic.stop();
  ledger.stop();
  curator.stop();
  methods.dispose();
  selfModel.close();
  observerInstall?.dispose();
  observerTasks?.dispose();
  feed?.dispose();
  memory.close();
  adapter.quit();
  processHealth.dispose();
  runStats.stop();
  memoryLlm?.stop();
  setTimeout(() => process.exit(code), 500);
}
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
/** 心跳给守护进程（scripts/supervise.mjs）、记录内存趋势、内存快满时先存档再请守护重启 */
const processHealth = installProcessHealth(bus, { onShutdown: () => shutdown(), onMemoryRestart: () => shutdown(RESTART_EXIT_CODE),
  extra: () => ({ ...dashboard.streamStats(), ...sandboxStats() }),
  snapshotAtBytes: config.heapSnapshotMb * 1048576, snapshotDir: path.join(config.dataDir, 'logs') });
