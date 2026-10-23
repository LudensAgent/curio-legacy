/** Real LLM / real server review. Run against an independently prepared test world. */
import fs from 'node:fs';
import path from 'node:path';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { Arbiter } from '../src/arbiter/arbiter.ts';
import { Executive } from '../src/brain/executive.ts';
import { Reflex } from '../src/brain/reflex.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { JsonlWriter } from '../src/log.ts';
import { ActionChat } from '../src/observer/action-chat.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { EpisodicMemory } from '../src/memory/episodic.ts';
import { MethodLibrary } from '../src/methods/learning.ts';
import { ResourceKnowledge } from '../src/methods/knowledge.ts';
import { createMethodSkills } from '../src/methods/skills.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { OpenAICompatibleProvider } from '../src/planner/llm.ts';
import { LlmTrace } from '../src/planner/llm-trace.ts';
import { Planner } from '../src/planner/planner.ts';
import { SKILLS } from '../src/skills/index.ts';
import { sleep } from '../src/util.ts';

if (config.llm.provider === 'mock') throw new Error('真实行为评审需要配置实际 LLM；mock 不能作为自主性证据');
const seconds = Number(process.env.AGENT_REVIEW_SECONDS ?? 90);
const port = Number(process.env.AGENT_REVIEW_PORT ?? 25585);
if (!Number.isInteger(seconds) || seconds < 10 || seconds > 1800 || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('评审时长或端口无效');
const directory = path.join(config.dataDir, 'reviews', `agent-${Date.now()}`);
fs.mkdirSync(directory, { recursive: true });
const cfg = { ...config, mc: { ...config.mc, host: process.env.AGENT_REVIEW_HOST ?? '127.0.0.1', port, username: 'CurioQA' },
  memory: { ...config.memory, provider: 'local' as const, worldId: process.env.AGENT_REVIEW_WORLD_ID ?? `qa:${port}` },
  dataDir: directory, observerFeed: false };
const bus = new EventBus();
const events = new JsonlWriter(directory, 'events');
bus.on('event', (event) => {
  events.write(event);
  if (['spawn', 'intent_decision', 'llm_error', 'llm_invalid', 'task_start', 'task_end', 'project_blocked'].includes(event.type)) console.log(event.type, event.msg);
});
const adapter = new MineflayerAdapter(cfg, bus);
const memory = new WorldMemory(path.join(directory, 'world-memory.json'));
const vision = new Vision(adapter, cfg.vision);
const perception = new Perception(adapter, memory, bus, vision);
const arbiter = new Arbiter(adapter, memory, bus, vision);
const recall = new EpisodicMemory(cfg.memory, memory, bus, () => adapter.state(), directory);
const trace = new LlmTrace();
const planner = new Planner(cfg, new OpenAICompatibleProvider(cfg.llm), adapter, memory, bus, new JsonlWriter(directory, 'llm'), trace, recall);
const methods = new MethodLibrary(path.join(directory, 'method-library.json'), adapter, memory, bus);
for (const skill of createMethodSkills(methods, new ResourceKnowledge(cfg.mc.version))) SKILLS[skill.name] = skill;
const executive = new Executive({ adapter, memory, bus, perception, arbiter, planner,
  onLearnSkill: (raw) => { methods.propose(raw, { intentId: memory.currentIntent()?.id }); } });
const reflex = new Reflex(adapter, arbiter, bus, vision);
const actionChat = new ActionChat(adapter, bus, { ...cfg.actionChat, canSend: () => !executive.paused });
adapter.on('spawn', () => executive.onSpawn());
adapter.on('death', () => executive.onDeath());
adapter.on('disconnected', () => executive.onDisconnected());

const preference = process.env.AGENT_REVIEW_PREFERENCE;
if (preference) memory.addPreference({ text: preference.slice(0, 300), source: 'user', support: ['评审起始偏好'], counterexamples: [], adjustmentReason: '用于比较不同偏好下的开放行为，不指定行动清单' });
try {
  adapter.connect();
  const connectDeadline = Date.now() + 60_000;
  while (!adapter.state().observationReady && Date.now() < connectDeadline) await sleep(200);
  if (!adapter.state().observationReady) throw new Error('独立测试服务器未提供有效观测');
  recall.start(); perception.start(); executive.start(); reflex.start(); actionChat.start();
  console.log(`真实评审开始，记录目录：${directory}`);
  await sleep(seconds * 1000);
} finally {
  executive.pause(); actionChat.stop(); executive.stop(); reflex.stop(); perception.stop(); recall.stop(); methods.dispose();
  memory.flush();
  fs.writeFileSync(path.join(directory, 'model-trace.json'), JSON.stringify(trace.recent(), null, 2));
  fs.writeFileSync(path.join(directory, 'review.json'), JSON.stringify({ worldId: cfg.memory.worldId, server: `${cfg.mc.host}:${port}`,
    realServer: true, realLlm: true, specifiedGoal: null, preference: preference ?? null,
    intents: memory.intents(), decisions: memory.decisions(), projects: memory.projects(), goals: memory.recentGoals(100),
    finalState: adapter.state(), planner: planner.stats, limitations: ['单次开放行为记录；不代替多种子建筑/跨维度/Boss能力验收'] }, null, 2));
  memory.close(); adapter.quit();
  console.log(`评审结束：${memory.decisions().length} 次选择，${memory.recentGoals(100).length} 次尝试；记录 ${directory}`);
}
