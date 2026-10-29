/**
 * 单独验证 LLM 接入：用一份假的游戏状态请求一次计划，打印延迟、原始输出和校验结果。
 * 用法：npm run check:llm
 */
import { config } from '../src/config.ts';
import type { GameAdapter } from '../src/adapter/types.ts';
import { WorldMemory } from '../src/memory/store.ts';
import type { Percept } from '../src/perception/perception.ts';
import { MockProvider, OpenAICompatibleProvider } from '../src/planner/llm.ts';
import { extractJson, ruleProposal } from '../src/planner/plan.ts';
import { deliberateSystem } from '../src/mind/prompt.ts';
import { parseDecision } from '../src/mind/thinker.ts';

const percept: Percept = {
  ts: Date.now(),
  connected: true,
  time: { timeOfDay: 2000, phase: 'day' },
  self: { pos: [12, 70, -30], dim: 'overworld', hp: 20, food: 18, biome: 'forest', inWater: false, inLava: false, held: null },
  inventory: [{ name: 'oak_log', count: 2 }],
  emptySlots: 34,
  nearby: {
    hostile: [],
    passive: ['cow x2'],
    players: [],
    resources: [{ block: 'oak_log', count: 23, nearest: 15, dir: 'NE', seen: 'now' }, { block: 'coal_ore', count: 3, nearest: 17, dir: 'W', seen: 'memory' }],
  },
  vision: {
    facing: 'N', fov: 100, range: 64,
    view: 'sky 42%、grass 30%、leaves 12%、wood 6%、stone 5%',
    openness: { left: 40, center: 64, right: 18 },
    visible_resources: [{ block: 'oak_log', count: 23, nearest: 15, dir: 'NE', rel: '右前' }],
    remembered_resources: [{ block: 'coal_ore', count: 3, nearest: 17, dir: 'W', rel: '左侧' }],
    seen_entities: [{ id: 1, name: 'cow', pos: { x: 12, y: 70, z: -39 }, dist: 9, dir: 'N', rel: '正前' }],
    heard: [],
    nearest_land: { dir: 'N', dist: 0 },
    last_look_around_s: 30,
  },
  death_recovery: null,
  curiosities: [{ what: 'pumpkin', dir: 'E', dist: 60 }],
  objective: '先做出石镐，再建一个小屋',
  drives: [{ drive: 'tools', level: 0.7, why: '当前镐子等级：none', suggest: 'gather log → craft wooden_pickaxe' }],
  stock: null,
  efficiency: [{ block: 'oak_log', mined: 6, avg_s: 3, tool: '空手', better: [{ tool: 'wooden_axe', est_s: 1.5, speedup: 2, have: false, materials: '3 木板 + 2 木棍' }], cheaper: [] }],
  light: { here: 15, block: 0, sky: 15, level: 'bright', mob_spawn_risk: false, dark_view_pct: 0, underground: false, torches: 0 },
  storage: null,
  farms: [],
  learn_candidates: [{ steps: 'gather:log → craft:wooden_pickaxe', times: 2 }],
  reflection_due: true,
  exploration: { visitedChunks: 3, noveltyByDir: { N: 1, NE: 1, E: 0.9, SE: 1, S: 0.6, SW: 1, W: 1, NW: 1 }, base: { dist: 6, dir: 'S' } },
};

// 离线校验用的最小适配器：只实现名称解析
const fakeAdapter = {
  resolveBlockNames: (q: string) => (q ? [q] : []),
  isKnownItem: (n: string) => /^[a-z_]+$/.test(n),
} as unknown as GameAdapter;

const memory = new WorldMemory(null);
const provider = config.llm.provider === 'openai' ? new OpenAICompatibleProvider(config.llm) : new MockProvider(config.llm.fakeDelayMs, () => ruleProposal(percept));
const messages = [
  { role: 'system' as const, content: deliberateSystem(config.persona) },
  { role: 'user' as const, content: `${JSON.stringify({ body: percept.self, inventory: percept.inventory, surroundings: percept.nearby, current_activity: null, why_thinking_now: '连通性检查' })}\n现在你在想什么、打算怎么做？只输出一个 JSON 对象。` },
];

console.log(`Provider: ${provider.name}  BaseURL: ${config.llm.baseUrl}  Model: ${config.llm.model}`);
console.log(`Prompt 长度：${messages.reduce((a, m) => a + m.content.length, 0)} 字符\n`);
try {
  const c = await provider.complete(messages, AbortSignal.timeout(config.llm.timeoutMs + config.llm.fakeDelayMs + 1000), { percept });
  console.log(`延迟：${c.latencyMs} ms  用量：${JSON.stringify(c.usage ?? {})}`);
  console.log('原始输出：\n' + c.text + '\n');
  const d = parseDecision(extractJson(c.text), fakeAdapter, memory, false);
  if (!('error' in d)) console.log('✅ 决定有效：', JSON.stringify({ decision: d.kind, monologue: d.monologue, activity: d.activity?.what, steps: d.activity?.steps }, null, 2));
  else {
    console.log('❌ 决定无效：', d.error);
    process.exitCode = 1;
  }
} catch (e: any) {
  console.error('❌ 调用失败：', e?.message ?? e);
  process.exitCode = 1;
}
