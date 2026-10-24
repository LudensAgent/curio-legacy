import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { AgentState, GameAdapter } from '../src/adapter/types.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { MethodLibrary, type MethodTrial } from '../src/methods/learning.ts';
import type { ResourceKnowledge } from '../src/methods/knowledge.ts';
import { createMethodSkills } from '../src/methods/skills.ts';
import type { Percept } from '../src/perception/perception.ts';
import { lightUserPrompt } from '../src/planner/prompt.ts';
import { SKILLS } from '../src/skills/index.ts';
import type { SkillCtx } from '../src/skills/types.ts';

// Register/read method definitions only. No program, primitive, model or game loop executes.
function fixture(t: TestContext) {
  const state: AgentState = { connected: true, alive: true, observationReady: true, worldId: 'catalog-world', sessionId: 's', observationId: 1,
    username: 'test', pos: { x: 0, y: 64, z: 0 }, dim: 'overworld', hp: 20, food: 20, oxygen: 20,
    timeOfDay: 1000, isDay: true, biome: 'plains', onGround: true, inWater: false, inLava: false, inventory: [], emptySlots: 36, held: null };
  const adapter = { state: () => state, isKnownItem: (name: string) => name === 'stone' } as unknown as GameAdapter;
  const memory = new WorldMemory(null); memory.setWorld(state.worldId);
  const library = new MethodLibrary(null, adapter, memory, new EventBus());
  t.after(() => { library.dispose(); memory.close(); });
  const proposal = { name: 'catalog_sample', description: '供查询的参数化候选',
    parameters: { amount: { type: 'integer', default: 1, min: 1, max: 4 }, direction: { type: 'string', default: 'N', values: ['N', 'S'] } },
    program: { type: 'call', skill: 'wait', args: { seconds: 1 } }, postcondition: { type: 'inventory_gain', item: 'stone', count: { param: 'amount' } } };
  const first = library.propose(proposal);
  assert.ok(first.ok, first.ok ? '' : first.error);
  const second = library.propose({ ...proposal, program: { ...proposal.program, args: { seconds: 2 } } });
  assert.ok(second.ok, second.ok ? '' : second.error);
  const definitions = library.list();
  definitions[1].trials = [0, 1, 2].map((n): MethodTrial => ({ id: `trial-${n}`, ts: n, worldId: state.worldId, dimension: state.dim,
    sessionId: 's', observationId: n, contextKey: `context-${n}`, parameters: { amount: 2, direction: 'S' },
    before: { count: 0 }, after: { count: n === 2 ? 1 : 2 }, status: n === 2 ? 'failed' : 'verified', reason: n === 2 ? '预期增加两块，实际只增加一块' : '库存实测增加', source: 'adapter.state' }));
  t.mock.method(library, 'list', () => structuredClone(definitions));
  const catalog = createMethodSkills(library, {} as ResourceKnowledge).find((s) => s.name === 'method_catalog')!;
  const query = async (raw: unknown) => {
    const validated = catalog.validate(raw, adapter);
    assert.ok(validated.ok, validated.ok ? '' : validated.error);
    return catalog.run({} as SkillCtx, validated.args);
  };
  const render = (data: unknown) => {
    const percept = { self: { pos: [0, 64, 0], dim: 'overworld', hp: 20, food: 20 }, inventory: [], emptySlots: 36,
      nearby: { resources: [], passive: [], hostile: [], players: [] }, vision: null, time: { timeOfDay: 1000, phase: 'day' },
      learn_candidates: [], exploration: { visitedChunks: 1 }, curiosities: [], drives: [] } as unknown as Percept;
    const text = lightUserPrompt({ reason: 'no_goal', percept, worldState: state, current: null, lastFailure: null, userSuggestion: null,
      results: [{ skill: 'method_catalog', status: 'succeeded', summary: '查询结果', data }] }, memory);
    return JSON.parse(text.slice(text.indexOf('\n') + 1, text.lastIndexOf('\n'))).last_results[0].data;
  };
  return { catalog, query, render, definitions, library };
}

test('selected method constraints, actual trial failures and versions survive light prompts', async (t) => {
  const w = fixture(t);
  assert.equal(w.catalog.validate({ version: 2 }, {} as GameAdapter).ok, false);
  assert.equal(w.catalog.validate({ name: 'trial:catalog_sample:v1', version: 2 }, {} as GameAdapter).ok, false);
  const latest = await w.query({ name: 'catalog_sample' });
  const selected = latest.data?.method as any;
  assert.equal(selected.version, 2);
  assert.equal(selected.trials.length, 2);
  assert.deepEqual(selected.trials.map((trial: any) => trial.actual.count), [2, 1]);
  const light = w.render(latest.data);
  assert.equal(light.method.callName, 'trial:catalog_sample:v2');
  assert.deepEqual(light.parameters.amount, { type: 'integer', default: 1, min: 1, max: 4 });
  assert.deepEqual(light.parameters.direction.values, ['N', 'S']);
  assert.equal(light.expected.type, 'inventory_gain');
  assert.equal(light.trials.at(-1).status, 'failed');
  assert.match(light.trials.at(-1).reason, /实际只增加一块/);
  assert.equal(light.method.historical, true);
  assert.ok(Buffer.byteLength(JSON.stringify(light), 'utf8') <= 1800);
  const older = await w.query({ name: 'trial:catalog_sample:v1' });
  assert.equal((older.data?.method as any).version, 1);
  assert.match(SKILLS['trial:catalog_sample:v2'].argsDoc, /"min":1,"max":4/);
  assert.match(SKILLS['trial:catalog_sample:v2'].argsDoc, /"values":\["N","S"\]/);
});

test('catalog overviews stay bounded and oversized constraints are explicitly deferred to full context', async (t) => {
  const w = fixture(t);
  const sample = w.definitions[1];
  w.definitions.splice(0, w.definitions.length, ...Array.from({ length: 20 }, (_, n) => ({ ...structuredClone(sample), name: `catalog_sample_${n}` })));
  t.mock.method(w.library, 'abilityGaps', () => [{ id: 'gap', description: '需要验证状态变化', missingPrimitive: 'observe_state' }] as any);
  const overview = await w.query({});
  assert.equal((overview.data?.methods as any[]).length, 8);
  const light = w.render(overview.data);
  assert.ok(light.methods.length <= 8);
  assert.equal(light.gaps[0].id, 'gap');
  assert.equal(light.totalVersions, 20);
  assert.ok(Buffer.byteLength(JSON.stringify(light), 'utf8') <= 1800);
  sample.parameters.direction.values = Array.from({ length: 20 }, (_, n) => `${n}${'方向'.repeat(38)}`);
  sample.parameters.direction.default = sample.parameters.direction.values[0];
  const selected = w.render({ source: 'method_catalog', method: { ...sample, callName: 'trial:catalog_sample:v2', trials: [{ status: 'failed', reason: '参数设想未通过', actual: { count: 0 } }] } });
  assert.equal(selected.requiresFullContext, true);
  assert.equal(selected.parameters, undefined, 'never display an incomplete enum as the allowed argument set');
  assert.equal(selected.trials[0].reason, '参数设想未通过');
  assert.ok(Buffer.byteLength(JSON.stringify(selected), 'utf8') <= 1800);
});
