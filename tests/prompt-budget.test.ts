import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { OpenAICompatibleProvider, type ChatMessage } from '../src/planner/llm.ts';
import { Planner } from '../src/planner/planner.ts';
import { buildMessages, enforcePromptBudget, promptCost, type PlanContext } from '../src/planner/prompt.ts';
import { ProjectCoordinator } from '../src/projects/coordinator.ts';
import { LLM_HIDDEN, SKILLS } from '../src/skills/index.ts';
import { BASIC_CONTROLS } from '../src/methods/controls.ts';
import { FakeAdapter } from './fake-adapter.ts';

const budget = 24000;
const historicalDetail = '此前曾试过沿河收集石材，但路线受水流和树叶遮挡，需要重新观察实际地形。';

function blockedFixture() {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  memory.setWorld(adapter.worldId);
  const intent = memory.addIntent({ text: '继续完成河边石材样本收藏', whyNow: '已有一部分样本，想比较不同岩层', context: [historicalDetail], tradeoffs: ['暂缓建造观景台'], status: 'active', source: 'model' });
  const projects = new ProjectCoordinator(memory, adapter);
  const project = projects.create({ intentId: intent.id, title: '收集并保存不同石材样本', successCondition: { type: 'inventory_min', item: 'cobblestone', count: 64 },
    milestones: Array.from({ length: 12 }, (_, i) => ({ title: `第${i + 1}次取样：${historicalDetail.repeat(2)}`, condition: { type: 'inventory_min' as const, item: 'cobblestone', count: (i + 1) * 4 } })) });
  project.currentMilestone = 5; project.status = 'blocked'; project.noProgressAttempts = 3;
  project.checkpoint = { ts: Date.now(), reason: 'three_attempts_without_progress', observationId: adapter.observationId };
  memory.saveProject(project);
  for (let i = 0; i < 8; i++) memory.addIntent({ text: `以后探索${i}号河湾`, whyNow: historicalDetail.repeat(3), context: Array(6).fill(historicalDetail.repeat(2)), tradeoffs: [historicalDetail], status: 'deferred', source: 'model' });
  for (let i = 0; i < 5; i++) memory.recordEvidence({ projectId: project.id, revision: project.revision, milestoneId: project.milestones[5].id,
    condition: project.milestones[5].condition, sessionId: adapter.sessionId, observationId: i, worldId: adapter.worldId,
    ts: Date.now() + i, source: 'adapter.state', status: 'unsatisfied', reason: 'sample_count_still_unchanged',
    actual: { count: 12, inventory: Array.from({ length: 36 }, (_, slot) => ({ slot, name: `sample_slot_${slot}`, count: slot % 3, historicalNote: historicalDetail.repeat(2) })) } });
  for (let i = 0; i < 4; i++) memory.recordGoal({ goal: `取样尝试${i}`, summary: historicalDetail.repeat(12), goalType: 'gather', source: 'llm', status: 'failed' });
  const continuity = { ...projects.context(), wishes: memory.intents().filter((i) => i.status === 'deferred'),
    works: Array.from({ length: 5 }, (_, i) => ({ id: `work_${i}`, name: `旧河岸小屋${i}`, version: i + 1, status: 'draft', defects: Array(4).fill(historicalDetail.repeat(3)), feedback: Array(3).fill(historicalDetail.repeat(3)) })) };
  const ctx: PlanContext = { reason: 'project_blocked', percept: new Perception(adapter, memory, bus, new Vision(adapter)).update(), current: null,
    lastFailure: { skill: 'gather', code: 'NO_PROGRESS', summary: 'CURRENT_FAILURE: 三次尝试都没有增加背包里的石材，须换方法或明确暂缓。' },
    userSuggestion: '保留这项收藏计划，先检查此前失败的取样地点。', worldState: adapter.state(), binding: projects.currentBinding(), continuity,
    memoryContext: { source: 'local', query: '此前石材取样失败', memories: Array.from({ length: 12 }, (_, i) => ({ id: `sample-memory-${i}`, text: historicalDetail.repeat(8), source: 'historical event' })) } };
  return { adapter, memory, bus, ctx, intent, project };
}

function contextPayload(messages: ChatMessage[]) {
  const text = messages[1].content;
  return JSON.parse(text.slice(text.indexOf('\n') + 1, text.lastIndexOf('\n')));
}

function assertCurrentContext(messages: ChatMessage[], fixture: ReturnType<typeof blockedFixture>) {
  const payload = contextPayload(messages);
  assert.equal(payload.reason, 'project_blocked');
  assert.equal(payload.last_failure.code, 'NO_PROGRESS');
  assert.match(payload.last_failure.summary, /CURRENT_FAILURE/);
  assert.equal(payload.continuity.intent.id, fixture.intent.id);
  assert.equal(payload.continuity.project.id, fixture.project.id);
  assert.equal(payload.continuity.project.status, 'blocked');
  assert.equal(payload.continuity.project.noProgressAttempts, 3);
  assert.deepEqual(payload.continuity.binding, fixture.ctx.binding);
  assert.deepEqual(payload.continuity.project.successCondition, fixture.project.successCondition);
  assert.ok(payload.continuity.project.milestones.some((m: { id: string }) => m.id === fixture.project.milestones[5].id));
  const latest = payload.continuity.evidence.at(-1);
  assert.equal(latest.observationId, 4);
  assert.equal(latest.status, 'unsatisfied');
  assert.equal(latest.actual.count, 12);
}

test('24000-byte blocked-project prompt retains current evidence and disclosed controls without restoring an activity menu', () => {
  const fixture = blockedFixture();
  try {
    fixture.ctx.knownControls = ['boat'];
    const messages = buildMessages('Curio', fixture.ctx, fixture.memory, 100, budget);
    assert.ok(promptCost(messages) <= budget, `prompt cost ${promptCost(messages)}/${budget}`);
    assertCurrentContext(messages, fixture);
    for (const skill of [...BASIC_CONTROLS, 'boat'].flatMap((name) => SKILLS[name] && !LLM_HIDDEN.has(name) ? [SKILLS[name]] : [])) {
      assert.ok(messages[0].content.includes(`- ${skill.name} ${skill.argsDoc}`), `missing skill schema ${skill.name}`);
    }
    assert.doesNotMatch(messages[0].content, /^- (hunt|farm|expedition|build) /m);
    assert.equal(fixture.memory.activeProject()!.status, 'blocked');
  } finally { fixture.memory.close(); }
});

test('budget pressure removes old recall exchanges together and preserves the latest query and its evidence', () => {
  const fixture = blockedFixture();
  try {
    const messages = buildMessages('Curio', fixture.ctx, fixture.memory, 100, budget);
    for (let i = 0; i < 8; i++) messages.push({ role: 'assistant', content: JSON.stringify({ kind: 'recall', query: `old-query-${i}` }) },
      { role: 'user', content: `old-result-${i}: ${historicalDetail.repeat(12)}` });
    const latest = [{ role: 'assistant' as const, content: '{"kind":"recall","query":"LATEST_QUERY"}' },
      { role: 'user' as const, content: `LATEST_EVIDENCE: 旧地点仍属历史记忆，当前数量只有12；${historicalDetail.repeat(8)}` }];
    messages.push(...latest);
    assert.ok(promptCost(messages) > budget);
    enforcePromptBudget(messages, budget);
    assert.ok(promptCost(messages) <= budget);
    assert.deepEqual(messages.slice(-2), latest);
    assert.equal((messages.length - 2) % 2, 0, 'recall request and response must be retained or removed together');
    for (let i = 2; i < messages.length; i += 2) {
      assert.equal(messages[i].role, 'assistant'); assert.equal(messages[i + 1].role, 'user');
    }
    assertCurrentContext(messages, fixture);
  } finally { fixture.memory.close(); }
});

test('latest validation correction survives history compaction with the blocked reason intact', () => {
  const fixture = blockedFixture();
  try {
    const messages = buildMessages('Curio', fixture.ctx, fixture.memory, 100, budget);
    for (let i = 0; i < 8; i++) messages.push({ role: 'assistant', content: `old invalid plan ${i}: ${historicalDetail.repeat(10)}` }, { role: 'user', content: `old correction ${i}` });
    messages.push({ role: 'assistant', content: '{"decision":{"kind":"revise"},"steps":[]}' },
      { role: 'user', content: 'LATEST_CORRECTION: revise 需要提供新的项目验收条件；保留原项目 ID，再给一个有效的 JSON 对象。' });
    enforcePromptBudget(messages, budget);
    assert.ok(promptCost(messages) <= budget);
    assert.match(messages.at(-1)!.content, /LATEST_CORRECTION/);
    assertCurrentContext(messages, fixture);
  } finally { fixture.memory.close(); }
});

test('planner recalls on demand and retries within 24000, while the next request starts a fresh conversation', async () => {
  const fixture = blockedFixture();
  let calls = 0, memoryCalls = 0;
  const cfg = { ...config, llm: { ...config.llm, provider: 'openai' as const, fakeDelayMs: 0, maxCallsPerHour: 10, maxPromptTokens: budget, maxRecallRounds: 2 } };
  const latestMemory = { id: 'latest-observed-route', text: `LATEST_RECALL: 河湾上次有水流阻挡，需现场确认。${historicalDetail.repeat(25)}`, source: 'historical event' };
  const planner = new Planner(cfg, { name: 'budget-regression', async complete(messages) {
    assert.ok(promptCost(messages) <= budget);
    assertCurrentContext(messages, fixture);
    if (calls === 0 || calls === 3) assert.equal(messages.length, 2, 'every new planning request starts with only current system and observation');
    if (calls === 0) assert.equal(memoryCalls, 0, 'ordinary planning does not trigger a memory query');
    if (calls === 1) assert.match(messages.at(-1)!.content, /LATEST_RECALL/);
    if (calls === 2) { assert.equal(messages.at(-1)!.role, 'user'); assert.match(messages.at(-1)!.content, /not_registered/); }
    if (calls === 3) assert.doesNotMatch(JSON.stringify(messages), /LATEST_RECALL|not_registered/, 'previous recall and invalid response do not leak into a new request');
    const outputs = [{ kind: 'recall', query: '上次取样遇到的阻碍' }, { goal: '无效技能输出', steps: [{ skill: 'not_registered', args: {} }], thought: historicalDetail.repeat(60) },
      { goal: '重新观察取样位置', steps: [{ skill: 'look_around', args: { seconds: 2 } }], decision: { kind: 'change_method', reason: '三次没有增量，先观察水流与路线再继续取样' } }];
    return { latencyMs: 1, text: JSON.stringify(outputs[Math.min(calls++, 2)]) };
  } }, fixture.adapter, fixture.memory, fixture.bus, null, null, { async recall(_ctx, query) {
    memoryCalls++;
    return query ? { source: 'local', query, memories: [latestMemory] } : fixture.ctx.memoryContext!;
  } });
  try {
    const plan = await planner.propose(fixture.ctx);
    assert.equal(plan.decision?.kind, 'change_method');
    assert.equal(calls, 3); assert.equal(planner.stats.invalid, 1); assert.equal(planner.stats.ok, 1);
    assert.equal(memoryCalls, 1, 'only the explicit recall asks the memory backend');
    assert.equal(planner.stats.inFlightSince, null);
    assert.equal(fixture.memory.activeProject()!.status, 'blocked', 'proposal must not mutate project acceptance');
    await planner.propose({ ...fixture.ctx, memoryContext: undefined });
    assert.equal(calls, 4); assert.equal(memoryCalls, 1);
  } finally { fixture.memory.close(); }
});

test('irreducible preflight failures are reported in planner stats without a model call', async () => {
  const fixture = blockedFixture();
  let calls = 0;
  const planner = new Planner({ ...config, llm: { ...config.llm, maxPromptTokens: 1024, maxCallsPerHour: 10 } },
    { name: 'unreachable-budget-model', async complete() { calls++; return { text: '{}', latencyMs: 1 }; } }, fixture.adapter, fixture.memory, fixture.bus, null);
  try {
    await assert.rejects(planner.propose(fixture.ctx), /PROMPT_BUDGET_EXCEEDED/);
    assert.equal(calls, 0); assert.equal(planner.stats.calls, 0); assert.equal(planner.stats.errors, 1);
    assert.match(planner.stats.lastError!, /PROMPT_BUDGET_EXCEEDED/);
    assert.equal(planner.stats.inFlightSince, null);
  } finally { fixture.memory.close(); }
});

test('128000 input budget compacts large historical context before the 75 percent soft limit', () => {
  const fixture = blockedFixture();
  try {
    const limits = { contextWindowTokens: 1000000, compactAtRatio: 0.75, maxOutputTokens: 16384 };
    const full = buildMessages('Curio', fixture.ctx, fixture.memory, 100, 1000000, false, limits);
    assert.ok(promptCost(full) > 128000 * 0.75, 'the fixture must exercise the soft threshold rather than only a small prompt');
    const messages = buildMessages('Curio', fixture.ctx, fixture.memory, 100, 128000, false, limits);
    assert.ok(promptCost(messages) <= 128000 * 0.75);
    assertCurrentContext(messages, fixture);
  } finally { fixture.memory.close(); }
});

test('a smaller model context reserves the configured output even when the input budget is larger', async () => {
  const fixture = blockedFixture();
  let calls = 0;
  const contextWindowTokens = 40000, maxTokens = 16384;
  const cfg = { ...config, llm: { ...config.llm, provider: 'openai' as const, maxCallsPerHour: 10, maxPromptTokens: 128000,
    contextWindowTokens, maxTokens, compactAtRatio: 0.75 } };
  const planner = new Planner(cfg, { name: 'small-context-regression', async complete(messages) {
    calls++;
    assert.ok(promptCost(messages) + maxTokens <= contextWindowTokens, 'the reserved completion must fit alongside the complete input');
    assertCurrentContext(messages, fixture);
    return { latencyMs: 1, text: JSON.stringify({ goal: '观察取样路线', steps: [{ skill: 'look_around', args: { seconds: 2 } }],
      decision: { kind: 'change_method', reason: '原路线连续没有增量，先观察周围' } }) };
  } }, fixture.adapter, fixture.memory, fixture.bus, null);
  try { await planner.propose(fixture.ctx); assert.equal(calls, 1); }
  finally { fixture.memory.close(); }
});

test('OpenAI-compatible requests transmit the full 16384 completion allowance', async (t) => {
  let body: Record<string, any> | undefined;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    body = JSON.parse(String(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] }), { status: 200 });
  });
  const provider = new OpenAICompatibleProvider({ ...config.llm, apiKey: '', stream: false, fakeDelayMs: 0, maxTokens: 16384, timeoutMs: 120000 });
  await provider.complete([{ role: 'user', content: 'current observation only' }], new AbortController().signal);
  assert.equal(body?.max_tokens, 16384);
  assert.deepEqual(body?.messages, [{ role: 'user', content: 'current observation only' }]);
});
