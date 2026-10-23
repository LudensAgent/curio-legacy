import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeDrives } from '../src/brain/drives.ts';
import { DecisionFeedback } from '../src/brain/decision-feedback.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { validatePlan, type Plan } from '../src/planner/plan.ts';
import { buildMessages, enforcePromptBudget, promptCost, systemPrompt, userPrompt, type PlanContext } from '../src/planner/prompt.ts';
import type { ChatMessage } from '../src/planner/llm.ts';
import { FakeAdapter } from './fake-adapter.ts';

function fixture() {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null);
  memory.setWorld(adapter.worldId);
  const percept = new Perception(adapter, memory, new EventBus(), new Vision(adapter)).update();
  const ctx: PlanContext = { reason: 'no_goal', percept, current: null, lastFailure: null, userSuggestion: null, worldState: adapter.state() };
  return { adapter, memory, percept, ctx };
}

function payload(text: string) {
  return JSON.parse(text.slice(text.indexOf('\n') + 1, text.lastIndexOf('\n')));
}

test('工具动机反映可用材料，不把空背包当成必须反复找树的命令', (t) => {
  const w = fixture();
  t.after(() => w.memory.close());
  const tools = () => computeDrives(w.percept, w.memory).drives.find((d) => d.drive === 'tools')!;
  const unknown = tools();
  assert.ok(unknown.level < computeDrives(w.percept, w.memory).drives.find((d) => d.drive === 'explore')!.level);
  assert.match(unknown.why, /当前观察和记忆中没有木料线索/);
  assert.match(unknown.why, /其他区域仍未知/);
  assert.match(unknown.suggest, /调整方法或暂缓/);
  assert.doesNotMatch(unknown.suggest, /look_around|gather log.*craft wooden_pickaxe/);

  w.percept.nearby.resources.push({ block: 'oak_log', count: 4, nearest: 25, dir: 'E', seen: 'now' });
  const visible = tools();
  assert.ok(visible.level > unknown.level);
  assert.match(visible.why, /看见 E 25 格外有木料/);
  assert.match(visible.suggest, /若当前活动需要工具/);

  w.percept.nearby.resources[0].seen = 'memory';
  assert.match(tools().why, /记得 E 25 格外有木料/);
  w.percept.nearby.resources = [];
  w.percept.inventory.push({ name: 'oak_log', count: 3 });
  const stocked = tools();
  assert.ok(stocked.level > unknown.level);
  assert.match(stocked.why, /背包已有木料/);
});

test('近期尝试保留路线、时序和耗时，最后一句环顾摘要不再抹掉探索经历', (t) => {
  const w = fixture();
  t.after(() => w.memory.close());
  w.memory.recordGoal({ goal: '比较东侧地形', goalType: 'explore', source: 'llm', status: 'succeeded', summary: '环顾了一圈',
    durationSec: 72, steps: ['explore:E', 'look_around'], plan: [{ skill: 'explore', args: { direction: 'E', distance: 80 } }, { skill: 'look_around', args: { seconds: 4 } }] });
  w.ctx.decisionFeedback = { movedBlocks: 78, newlyObservedResources: [], inventoryChanges: [] };
  const context = payload(userPrompt(w.ctx, w.memory));
  assert.equal(context.recent_attempts[0].ts, w.memory.recentGoals(1)[0].ts);
  assert.equal(context.recent_attempts[0].duration_s, 72);
  assert.equal(context.recent_attempts[0].steps[0].skill, 'explore');
  assert.deepEqual(context.recent_attempts[0].steps[0].args, { direction: 'E', distance: 80 });
  assert.deepEqual(context.decision_feedback, w.ctx.decisionFeedback);
});

test('紧缩上下文和移除历史记忆时仍保留最新尝试与实际技能结果', (t) => {
  const w = fixture();
  t.after(() => w.memory.close());
  for (let i = 0; i < 4; i++) w.memory.recordGoal({ goal: `route-${i}`, goalType: 'explore', source: 'llm', status: 'succeeded',
    summary: `${i === 3 ? 'LATEST_ROUTE' : 'OLD_ROUTE'} ${'历史地形观察。'.repeat(160)}`, durationSec: i + 20, steps: [`explore:${['N', 'E', 'S', 'W'][i]}`] });
  w.ctx.results = [{ skill: 'gather', status: 'failed', summary: 'OLD_RESULT', data: { details: '历史记录'.repeat(2000) } },
    { ts: Date.now(), skill: 'look_around', status: 'succeeded', summary: 'LATEST_RESULT', data: { newResources: [], moved: 0 } }];
  w.ctx.decisionFeedback = { observationChanged: false, movedBlocks: 0 };
  const latestOnly = payload(userPrompt(w.ctx, w.memory, undefined, 0, 2));
  assert.equal(latestOnly.recent_attempts.length, 1);
  assert.equal(latestOnly.recent_attempts[0].goal, 'route-3');
  assert.equal(latestOnly.tool_results[0].summary, 'LATEST_RESULT');
  assert.deepEqual(latestOnly.decision_feedback, w.ctx.decisionFeedback);

  const messages: ChatMessage[] = [{ role: 'system', content: '根据当前事实自主选择。' }, { role: 'user', content: userPrompt(w.ctx, w.memory) }];
  assert.ok(promptCost(messages) > 4500);
  enforcePromptBudget(messages, 4500);
  assert.ok(promptCost(messages) <= 4500);
  const compacted = payload(messages[1].content);
  assert.equal(compacted.recent_attempts.at(-1).goal, 'route-3');
  assert.equal(compacted.tool_results.at(-1).summary, 'LATEST_RESULT');
});

test('最新结果正文过大时保留紧缩后的失败依据，不被较小的旧结果替换', (t) => {
  const w = fixture();
  t.after(() => w.memory.close());
  w.ctx.results = [{ skill: 'explore', status: 'succeeded', summary: 'OLD_RESULT' },
    { skill: 'surface', status: 'failed', summary: `LATEST_FAILURE: ${'仍在水中。'.repeat(500)}`, data: { landed: false, details: '观察详情'.repeat(2000) } }];
  const result = payload(userPrompt(w.ctx, w.memory, undefined, 0, 2)).tool_results;
  assert.equal(result.length, 1);
  assert.equal(result[0].status, 'failed');
  assert.match(result[0].summary, /^LATEST_FAILURE:/);
  assert.equal(result[0].data.landed, false);
});

test('六次完整反馈紧缩及 24000 字节规划预算保留最新经历与当前水中危险证据', (t) => {
  const w = fixture(), feedback = new DecisionFeedback();
  t.after(() => w.memory.close());
  for (let i = 0; i < 6; i++) {
    const plan: Plan = { id: `route-${i}`, source: 'llm', thought: '附近的地形似乎还没有变化。', goal: `比较第 ${i + 1} 段沿岸地形`, goalType: 'explore',
      steps: [{ skill: 'explore', args: { direction: 'E', distance: 64 } }, { skill: 'look_around', args: { seconds: 4 } }],
      index: 0, abortIf: {}, createdAt: Date.now(), retries: 0 };
    feedback.begin(plan, w.adapter.state(), w.percept);
    w.adapter.pos.x += 64;
    w.percept.self.pos[0] = w.adapter.pos.x;
    w.percept.exploration.visitedChunks += 4;
    w.percept.vision!.view = 'snow 50%、water 30%、sky 20%';
    if (i === 5) { w.adapter.inWater = true; w.adapter.oxygen = 8; w.percept.self.inWater = true; }
    plan.index = plan.steps.length;
    const after = { ...w.adapter.state(), onGround: !w.adapter.inWater };
    feedback.end(plan, i === 5 ? 'interrupted' : 'succeeded', i === 5 ? 'LATEST_WATER_FAILURE：尚未确认安全上岸，仍在水中' : '探索了一段雪原，未发现新的资源线索', after, w.percept);
  }
  const current = { ...w.adapter.state(), onGround: false };
  w.ctx.worldState = current;
  w.ctx.decisionFeedback = feedback.context(current, w.percept);
  w.ctx.lastFailure = { skill: 'surface', code: 'STUCK', summary: 'LATEST_WATER_FAILURE：尚未确认安全上岸，仍在水中' };
  w.ctx.results = [{ ts: Date.now(), skill: 'surface', source: 'reflex', status: 'failed', summary: w.ctx.lastFailure.summary, data: { landed: false } }];
  assert.equal(payload(userPrompt(w.ctx, w.memory)).decision_feedback.recentAttempts.length, 6);

  const assertLatestEvidence = (context: any) => {
    const evidence = context.decision_feedback;
    assert.equal(evidence.recentAttempts.at(-1).planId, 'route-5');
    assert.match(evidence.recentAttempts.at(-1).summary, /LATEST_WATER_FAILURE/);
    assert.equal(evidence.recentAttempts.at(-1).after.inWater, true);
    assert.equal(evidence.currentState.inWater, true);
    assert.equal(evidence.currentState.oxygen, 8);
    assert.equal(evidence.currentState.onGround, false);
    assert.equal(evidence.repeatedStepPattern.consecutiveAttempts, 6);
    assert.equal(context.tool_results.at(-1).data.landed, false);
    assert.equal(context.last_failure.code, 'STUCK');
  };
  const compact = payload(userPrompt(w.ctx, w.memory, undefined, 0, 2));
  assert.equal(compact.decision_feedback.recentAttempts.length, 1);
  assertLatestEvidence(compact);

  const messages = buildMessages('Curio', w.ctx, w.memory, 100, 24000);
  assert.ok(promptCost(messages) <= 24000, `prompt cost ${promptCost(messages)}/24000`);
  assertLatestEvidence(payload(messages[1].content));
});

test('决策说明支持因事实改法或暂缓，格式示例使用不同玩法而非固定环顾流程', () => {
  const prompt = systemPrompt('Curio', 100, '');
  assert.match(prompt, /其他可行方法或暂缓/);
  assert.match(prompt, /原地且事实未变时再次扫视通常没有新信息/);
  assert.match(prompt, /先获得证据再决定/);
  assert.match(prompt, /reason 只写简短依据/);
  const examples = prompt.split('\n').filter((line) => line.startsWith('{"kind":"plan"')).map((line) => JSON.parse(line));
  assert.equal(examples.length, 2);
  assert.deepEqual(examples.map((e) => e.steps[0].skill), ['gather', 'explore']);
  for (const example of examples) {
    const checked = validatePlan(example, new FakeAdapter(), 'llm');
    assert.equal(checked.ok, true, !checked.ok ? checked.error : '');
    assert.ok(example.thought.length <= 60);
  }
});
