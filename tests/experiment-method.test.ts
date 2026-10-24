import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import type { AgentState, GameAdapter } from '../src/adapter/types.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import type { ResourceKnowledge } from '../src/methods/knowledge.ts';
import { MethodLibrary } from '../src/methods/learning.ts';
import { createMethodSkills } from '../src/methods/skills.ts';
import { SKILLS } from '../src/skills/index.ts';
import { ok, type SkillCtx } from '../src/skills/types.ts';

// Exercise the real proposal/DSL/proof lifecycle using one synchronous inventory primitive.
// No Minecraft connection, pathfinding, game clock or model calls.
function fixture(t: TestContext) {
  const state: AgentState = { connected: true, alive: true, observationReady: true, worldId: 'experiment-world', sessionId: 's', observationId: 1,
    username: 'player', pos: { x: 0, y: 64, z: 0 }, dim: 'overworld', hp: 20, food: 20, oxygen: 20, timeOfDay: 1000,
    isDay: true, biome: 'plains', onGround: true, inWater: false, inLava: false, inventory: [], emptySlots: 36, held: null };
  const adapter = { state: () => structuredClone(state), isKnownItem: (name: string) => name === 'stone' } as unknown as GameAdapter;
  const memory = new WorldMemory(null); memory.setWorld(state.worldId);
  const bus = new EventBus(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-method-experiment-')), file = path.join(dir, 'methods.json');
  const library = new MethodLibrary(file, adapter, memory, bus);
  const skill = createMethodSkills(library, {} as ResourceKnowledge).find((s) => s.name === 'experiment_method')!;
  const previous = SKILLS.experiment_sample;
  let calls = 0;
  SKILLS.experiment_sample = { name: 'experiment_sample', description: 'test observation', argsDoc: '{}', timeoutMs: 1000, movement: false,
    validate: (raw: any) => Number.isInteger(raw.count) && raw.count > 0 && raw.count <= 8 ? { ok: true, args: { count: raw.count } } : { ok: false, error: 'count' },
    run: async (ctx, args) => {
      assert.equal(ctx.signal, signal); calls++;
      const held = state.inventory.find((i) => i.name === 'stone');
      if (held) held.count += args.count; else state.inventory.push({ name: 'stone', count: args.count });
      state.observationId++; return ok('primitive returned');
    } };
  const signal = new AbortController().signal;
  const ctx: SkillCtx = { adapter, memory, bus, signal, deadline: Date.now() + 10000, taskId: 'experiment', progress() {},
    senses: { refresh() {}, markSweep() {}, knownBlocks: () => [], perceivedEntities: () => [] } };
  t.after(() => {
    library.dispose(); memory.close();
    if (previous) SKILLS.experiment_sample = previous; else delete SKILLS.experiment_sample;
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(dir, { recursive: true, force: true });
  });
  const run = async (raw: unknown) => {
    const validated = skill.validate(raw, adapter);
    if (!validated.ok) assert.fail(validated.error);
    return skill.run(ctx, validated.args);
  };
  return { state, library, file, run, calls: () => calls };
}

test('a parameterized proposal is immediately tried and saved, but only two observed contexts establish a method', async (t) => {
  const w = fixture(t);
  const proposal = { name: 'experimental_chain', description: '试验一种参数化取样组合', parameters: { amount: { type: 'integer', default: 1, min: 1, max: 8 } },
    program: { type: 'call', skill: 'experiment_sample', args: { count: { param: 'amount' } } },
    postcondition: { type: 'inventory_gain', item: 'stone', count: { param: 'amount' } }, arguments: { amount: 2 } };
  const first = await w.run(proposal);
  assert.equal(first.status, 'succeeded', first.summary);
  assert.equal(w.calls(), 1, 'the same invocation executes the proposal instead of merely naming a future trial');
  assert.equal(first.data?.methodStatus, 'candidate'); assert.equal(first.data?.verified, false);
  assert.equal(SKILLS['method:experimental_chain'], undefined);
  const saved = JSON.parse(fs.readFileSync(w.file, 'utf8')).methods[0];
  assert.equal(saved.trials[0].status, 'verified'); assert.equal(saved.status, 'candidate');
  w.state.pos.x = 32;
  const second = await w.run(proposal);
  assert.equal(second.data?.version, 1); assert.equal(second.data?.methodStatus, 'verified');
  assert.equal(w.library.list()[0].trials.length, 2);
  assert.ok(SKILLS['method:experimental_chain']);
});

test('failed expected results remain recorded and the same name can immediately try a revised version', async (t) => {
  const w = fixture(t);
  const proposal = { name: 'revised_experiment', description: '根据实际结果修订机制组合',
    program: { type: 'call', skill: 'experiment_sample', args: { count: 1 } },
    postcondition: { type: 'inventory_gain', item: 'stone', count: 2 } };
  const failed = await w.run(proposal);
  assert.equal(failed.status, 'failed'); assert.equal(failed.data?.trialStatus, 'failed');
  assert.ok(failed.data?.actual); assert.ok(failed.data?.expected);
  assert.match(failed.summary, /同名.*修订/);
  assert.equal(w.library.list()[0].trials[0].status, 'failed');
  const revised = await w.run({ ...proposal, program: { type: 'call', skill: 'experiment_sample', args: { count: 2 } } });
  assert.equal(revised.status, 'succeeded', revised.summary);
  assert.equal(revised.data?.version, 2); assert.equal(revised.data?.methodStatus, 'candidate');
  assert.equal(w.library.list().length, 2); assert.equal(w.library.list()[1].trials[0].status, 'verified');
  assert.equal(SKILLS['method:revised_experiment'], undefined, 'one successful revision does not prove general mastery');
});
