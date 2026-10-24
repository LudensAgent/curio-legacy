import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorldMemory } from '../src/memory/store.ts';
import { buildLightMessages, lightUserPrompt, userPrompt, type PlanContext } from '../src/planner/prompt.ts';
import { SKILLS } from '../src/skills/index.ts';

const payload = (text: string) => JSON.parse(text.slice(text.indexOf('\n') + 1, text.lastIndexOf('\n')));

test('routine working context retains current question and exact evidence, while old guesses and authoring catalogs stay on demand', (t) => {
  const memory = new WorldMemory(null); t.after(() => memory.close()); memory.setWorld('w');
  memory.addIntent({ text: '继续自己的探索', whyNow: '刚发现一条值得看的路线', context: [], tradeoffs: [], status: 'active', source: 'model' });
  memory.addLesson('未经证实的旧结论', { source: 'model' });
  const inventory = Array.from({ length: 30 }, (_, i) => ({ name: `item_${i}`, count: i + 1 }));
  inventory.push({ name: 'white_bed', count: 1 });
  const focus = { claims: 'model_intention_not_world_facts', approach: '先确认眼前的变化', question: '哪个假设符合刚才观察',
    recent: [{ goal: '检查', executionStatus: 'succeeded', prediction: { status: 'unknown' } }] };
  const ctx: PlanContext = {
    reason: 'task_finished', current: null, userSuggestion: null,
    lastFailure: { skill: 'goto', code: 'STUCK', summary: '没有实际位移，原因尚未确认' },
    percept: { self: { pos: [1.5, 77, -2.5], dim: 'overworld', hp: 20, food: 20, inWater: false, inLava: false,
      contacts: { support: { block: 'crafting_table', pos: { x: 1, y: 76, z: -3 } } } },
      inventory: inventory.slice(0, 24), emptySlots: 4, time: { phase: 'day' }, vision: null,
      nearby: { hostile: [], passive: [], players: [], resources: [] }, exploration: {},
    } as any,
    worldState: { inventory } as any, workingFocus: focus,
    researchContext: { questions: [{ question: '不相关的历史问题', versions: '档案'.repeat(4000) }] },
    notes: ['过时的地点推测'.repeat(500)], thread: [{ thought: '过时的情绪', goal: '旧事' }],
    knownControls: Object.keys(SKILLS),
    results: [{ skill: 'goto', status: 'succeeded', data: { moved: 0, arrivedCell: false, targetCell: { x: 2, y: 77, z: -3 }, positionCell: { x: 1, y: 77, z: -3 } } }],
    decisionFeedback: { intentProgress: { consecutiveNoProgressAttempts: 4 } },
  };
  const messages = buildLightMessages('player', ctx, memory), light = payload(lightUserPrompt(ctx, memory));
  assert.deepEqual(light.working_focus, focus);
  assert.equal(light.decision_feedback.intentProgress.consecutiveNoProgressAttempts, 4);
  assert.deepEqual(light.last_results[0].data.targetCell, { x: 2, y: 77, z: -3 });
  assert.equal(light.last_results[0].data.arrivedCell, false);
  assert.equal(light.state.inventory.length, 31, 'a smaller decision still receives every actual inventory type');
  assert.equal(light.state.my_bed.in_inventory, true);
  assert.equal(light.state.self.contacts.support.pos.y, 76, 'support coordinates differ from feet coordinates');
  assert.doesNotMatch(messages[1].content, /不相关的历史问题|过时的地点推测|过时的情绪|未经证实的旧结论/);
  assert.doesNotMatch(messages[0].content, /^- experiment_method |^- build |^- boat /m);
  assert.match(messages[0].content, /^- assess_landings /m);
  assert.match(messages[0].content, /^- descend /m);
  const full = payload(userPrompt(ctx, memory));
  assert.equal(full.research_context.questions[0].question, '不相关的历史问题');
  assert.match(full.lessons[0], /自己的推测·未验证/);
  assert.deepEqual(full.working_focus, focus);
  assert.equal(full.state.inventory.length, 31);
  assert.equal(payload(userPrompt(ctx, memory, undefined, 0, 2)).state.inventory.length, 31, 'compaction only sheds historical inventories, never current possessions');
});
