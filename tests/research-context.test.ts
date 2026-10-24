import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AgentState, GameAdapter } from '../src/adapter/types.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import type { ResourceKnowledge } from '../src/methods/knowledge.ts';
import { MethodLibrary, type MethodTrial } from '../src/methods/learning.ts';
import { createMethodSkills } from '../src/methods/skills.ts';
import { lightUserPrompt } from '../src/planner/prompt.ts';
import { SKILLS } from '../src/skills/index.ts';

// Saved evidence fixtures only: no game, planner, clocks or method programs execute.
test('self-chosen questions retain scoped support, counterexamples and unknown evidence across revisions and reloads', async (t) => {
  const state = { connected: true, alive: true, observationReady: true, worldId: 'research-world', sessionId: 'session', observationId: 1,
    dim: 'overworld', pos: { x: 0, y: 64, z: 0 }, inventory: [] } as unknown as AgentState;
  const adapter = { state: () => structuredClone(state), isKnownItem: (name: string) => name === 'stone' } as unknown as GameAdapter;
  const memory = new WorldMemory(null); memory.setWorld(state.worldId);
  const bus = new EventBus(), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-research-records-')), file = path.join(directory, 'methods.json');
  const libraries: MethodLibrary[] = [], previous = SKILLS.research_probe;
  SKILLS.research_probe = { name: 'research_probe', description: 'record fixture', argsDoc: '{}', timeoutMs: 1000, movement: false,
    validate: () => ({ ok: true, args: {} }), run: async () => { throw new Error('this test must not execute a method'); } };
  t.after(() => {
    for (const library of libraries) library.dispose(); memory.close();
    if (previous) SKILLS.research_probe = previous; else delete SKILLS.research_probe;
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const open = () => { const library = new MethodLibrary(file, adapter, memory, bus); libraries.push(library); return library; };
  const library = open(), skills = createMethodSkills(library, {} as ResourceKnowledge);
  const raw = { name: 'research_question', description: '验证自己的一个有限预测', question: '这一操作是否会改变我能观察到的结果？',
    hypothesis: '在这次条件下，单次操作会得到一块石头。', parameters: { setting: { type: 'integer', default: 1, min: 1, max: 3 } }, program: { type: 'call', skill: 'research_probe' },
    postcondition: { type: 'inventory_min', item: 'stone', count: 1 } };
  const validation = skills.find((s) => s.name === 'experiment_method')!.validate(raw, adapter);
  assert.ok(validation.ok);
  assert.equal(library.propose(validation.args).ok, true);
  assert.equal(library.researchContext().questions[0].hypothesis, raw.hypothesis);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')), definition = saved.methods[0];
  const base: MethodTrial = { id: 'support', ts: 1, worldId: state.worldId, dimension: state.dim, sessionId: state.sessionId, observationId: 2,
    contextKey: 'one-context', parameters: { setting: 1 }, expected: raw.postcondition, before: { count: 0 }, after: { count: 1 },
    beforeStatus: 'unsatisfied', afterStatus: 'satisfied', executionStatus: 'succeeded', status: 'verified', reason: '观察到预测变化', source: 'adapter.state' };
  definition.trials = [base,
    { ...base, id: 'counterexample', ts: 2, parameters: { setting: 2 }, status: 'failed', afterStatus: 'unsatisfied', after: { count: 0 }, reason: '有效观测明确未达到预测' },
    { ...base, id: 'unobserved', ts: 3, status: 'failed', afterStatus: 'unknown', after: null, reason: '未获得有效观测' },
    { ...base, id: 'execution_failed', ts: 4, status: 'failed', afterStatus: 'unsatisfied', executionStatus: 'failed',
      failureCode: 'PATH_NOT_FOUND', after: { count: 0 }, reason: '动作没有完成，不能判断机制' }];
  saved.methods.push({ ...definition, name: 'unobserved_question', question: '尚未观察清楚的问题',
    trials: [1, 2, 3].map((i) => ({ ...definition.trials.at(-1), id: `unknown-${i}`, ts: i })) });
  fs.writeFileSync(file, JSON.stringify(saved));
  const restored = open(), context = restored.researchContext();
  assert.equal(context.claims, 'model_hypotheses');
  assert.equal(context.evidence, 'historical_not_current_state');
  assert.deepEqual(context.questions[0].outcomes, { supported: 1, counterexample: 1, unknown: 2 });
  assert.deepEqual(context.questions[0].recentEvidence.map((e) => e.outcome), ['supported', 'counterexample', 'unknown']);
  assert.deepEqual(context.questions[0].recentEvidence[1].parameters, { setting: 2 });
  assert.equal(context.questions[0].recentEvidence.at(-1)?.failureCode, 'PATH_NOT_FOUND');
  assert.equal(context.questions[0].methodStatus, 'candidate', 'one supporting context cannot prove a method or its hypothesis');
  restored.pruneStale();
  assert.equal(restored.list().find((d) => d.name === 'unobserved_question')!.status, 'candidate', 'three unknown results cannot refute or retire a hypothesis');
  const revised = restored.propose({ ...raw, hypothesis: '这个结果可能还取决于我尚未区分的条件。' });
  assert.ok(revised.ok); assert.equal(revised.version, 2);
  const question = restored.researchContext().questions[0];
  assert.deepEqual(question.outcomes, { supported: 0, counterexample: 0, unknown: 0 }, 'old evidence is not assigned to a revised hypothesis');
  assert.equal(question.recentEvidence[0].version, 1);
  assert.equal(question.recentEvidence[0].hypothesis, raw.hypothesis);
  const catalog = createMethodSkills(restored, {} as ResourceKnowledge).find((s) => s.name === 'method_catalog')!;
  const selected = await catalog.run({} as any, { name: raw.name });
  assert.equal((selected.data?.method as any).question, raw.question);
  assert.equal((selected.data?.method as any).hypothesis, question.hypothesis);
  const percept = { self: { pos: [0, 64, 0], dim: state.dim }, inventory: [], emptySlots: 36, nearby: { resources: [] }, time: {} } as any;
  const prompt = lightUserPrompt({ reason: 'test', percept, current: null, lastFailure: null, userSuggestion: null,
    results: [{ skill: 'method_catalog', status: 'succeeded', summary: selected.summary, data: selected.data }] }, memory);
  const light = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1, prompt.lastIndexOf('\n'))).last_results[0].data.method;
  assert.equal(light.question, raw.question); assert.equal(light.hypothesis, question.hypothesis); assert.equal(light.claims, 'model_hypotheses');
  assert.ok(Buffer.byteLength(JSON.stringify(restored.researchContext()), 'utf8') <= 4500);
  assert.ok(Buffer.byteLength(JSON.stringify(restored.researchContext({ maxBytes: 1000 })), 'utf8') <= 1000);
  state.worldId = 'another-world'; assert.deepEqual(restored.researchContext().questions, []);
});
