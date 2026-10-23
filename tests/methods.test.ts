import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { ResourceKnowledge } from '../src/methods/knowledge.ts';
import { MethodLibrary } from '../src/methods/learning.ts';
import { createMethodSkills } from '../src/methods/skills.ts';
import { SKILLS } from '../src/skills/index.ts';
import { Vision } from '../src/perception/vision.ts';
import { sleep } from '../src/util.ts';
import { FakeAdapter } from './fake-adapter.ts';

const candidate = (name: string) => ({ name, description: '按参数取样并确认真实持有量', parameters: { amount: { type: 'integer', min: 1, max: 8, default: 4 } },
  program: { type: 'sequence', steps: [{ type: 'if', condition: { type: 'inventory_min', item: 'stone', count: { param: 'amount' } }, then: { type: 'call', skill: 'craft', args: { item: 'stone', count: 1 } }, else: { type: 'repeat', times: 1, body: { type: 'call', skill: 'craft', args: { item: 'stone', count: { param: 'amount' } } } } }] },
  postcondition: { type: 'inventory_min', item: 'stone', count: { param: 'amount' } } });

function fixture(t: { after: (fn: () => void) => void }, file: string | null = null, isolated = true) {
  const adapter = new FakeAdapter();
  const memory = new WorldMemory(null);
  memory.setWorld(adapter.worldId);
  const bus = new EventBus();
  const library = new MethodLibrary(file, adapter, memory, bus, { trialWorldIds: isolated ? [adapter.worldId] : [] });
  const arbiter = new Arbiter(adapter, memory, bus, new Vision(adapter));
  t.after(() => { arbiter.cancel('cleanup'); library.dispose(); memory.close(); });
  const run = async (name: string, args = {}): Promise<TaskOutcome> => {
    const result = new Promise<TaskOutcome>((resolve) => arbiter.once('done', resolve));
    const started = arbiter.start({ skill: name, args }, 'llm');
    assert.ok(!('error' in started), 'error' in started ? started.error : '');
    return result;
  };
  return { adapter, memory, library, arbiter, run };
}

test('resource queries expose versioned alternatives, facilities, inventory deficits and reservations without invented locations', () => {
  const knowledge = new ResourceKnowledge('1.20.1');
  const result = knowledge.query('stone_pickaxe', 1, [{ name: 'stick', count: 2 }, { name: 'cobblestone', count: 2 }], [{ name: 'stick', count: 1 }]);
  const cobblestone = result.methods.find((m) => m.kind === 'craft' && m.inputs.some((i) => i.item === 'cobblestone'))!;
  assert.equal(result.source, 'minecraft-data:1.20.1');
  assert.equal(cobblestone.facility, 'crafting_table');
  assert.equal(cobblestone.inputs.find((i) => i.item === 'cobblestone')?.missing, 1);
  assert.equal(cobblestone.inputs.find((i) => i.item === 'stick')?.missing, 1);
  assert.equal(result.locations, 'unknown');
  const smelting = knowledge.query('iron_ingot').methods.find((m) => m.kind === 'smelt' && m.inputs[0].item === 'raw_iron');
  assert.equal(smelting?.facility, 'furnace');
  assert.equal(smelting?.fuelRequired, true);
  assert.equal(knowledge.query('cobblestone').methods.some((m) => m.kind === 'gather' && m.tools?.length), true);
  assert.throws(() => knowledge.query('made_up_material'));
});

test('unsupported primitives stay honest gaps; arbitrary code, recursion and unbounded loops never register skills', (t) => {
  const { library } = fixture(t);
  assert.equal(library.propose({ ...candidate('unsupported_test'), program: { type: 'call', skill: 'make_magic_portal' } }, { intentId: 'interest' }).ok, false);
  assert.equal(library.abilityGaps()[0].intentId, 'interest');
  assert.equal(library.abilityGaps()[0].status, 'open');
  for (const program of [{ type: 'javascript', code: 'process.exit()' }, { type: 'call', skill: 'macro:foo' }, { type: 'repeat', times: 999, body: { type: 'call', skill: 'craft', args: { item: 'stone' } } }]) {
    assert.equal(library.propose({ ...candidate('invalid_program'), program }).ok, false);
  }
  assert.equal(library.propose({ ...candidate('missing_proof'), postcondition: undefined }).ok, false);
  assert.equal(SKILLS['method:unsupported_test'], undefined);
});

test('bounded parameter programs execute through Arbiter; two independent observed trials promote a version', async (t) => {
  const { library, adapter, run } = fixture(t);
  const proposed = library.propose(candidate('sample_twice'));
  assert.equal(proposed.ok, true);
  if (!proposed.ok) return;
  assert.equal(SKILLS['method:sample_twice'], undefined);
  assert.equal((await run(proposed.name)).result.status, 'succeeded');
  assert.equal(library.list()[0].status, 'candidate');
  assert.equal(library.list()[0].trials[0].status, 'verified');
  adapter.inv.clear();
  adapter.pos.x = 32; // New observed location, independent trial context.
  assert.equal((await run(proposed.name, { parameters: { amount: 6 } })).result.status, 'succeeded');
  assert.equal(library.list()[0].status, 'verified');
  assert.ok(SKILLS['method:sample_twice']);
  adapter.inv.clear();
  assert.equal((await run('method:sample_twice', { parameters: { amount: 2 } })).result.status, 'succeeded');
  assert.equal(adapter.inv.get('stone'), 2);
  assert.equal(SKILLS[proposed.name].validate({ parameters: { amount: 99 } }, adapter).ok, false);
});

test('partial success and already true postconditions cannot promote a candidate', async (t) => {
  const { library, adapter, run } = fixture(t);
  const proposed = library.propose(candidate('partial_sample'));
  if (!proposed.ok) return assert.fail(proposed.error);
  adapter.craft = async (item) => { adapter.inv.set(item, 1); return { ok: true, crafted: 1 }; };
  assert.equal((await run(proposed.name)).result.status, 'failed');
  assert.equal(library.list()[0].trials[0].status, 'failed');
  assert.equal(library.list()[0].status, 'candidate');
  adapter.inv.set('stone', 4);
  adapter.craft = async (item) => { adapter.inv.set(item, 4); return { ok: true, crafted: 1 }; };
  assert.equal((await run(proposed.name)).result.status, 'succeeded');
  assert.equal(library.list()[0].trials[1].status, 'uninformative');
  assert.equal(library.promote('partial_sample', 1), false);
});

test('trial isolation is configuration, never a model claim', (t) => {
  const { library, adapter } = fixture(t, null, false);
  const proposed = library.propose(candidate('world_isolation'));
  if (!proposed.ok) return assert.fail(proposed.error);
  const validation = SKILLS[proposed.name].validate({ isolated: true, parameters: { amount: 4 } }, adapter);
  assert.equal(validation.ok, false);
  assert.equal(library.list()[0].status, 'candidate');
});

test('cancelled methods cannot run their remaining nodes or acquire verification evidence', async (t) => {
  const { library, adapter, arbiter, run } = fixture(t);
  const proposed = library.propose({ ...candidate('cancelled_sample'), program: { type: 'sequence', steps: [{ type: 'call', skill: 'craft', args: { item: 'stone', count: 4 } }, { type: 'call', skill: 'craft', args: { item: 'diamond', count: 1 } }] } });
  if (!proposed.ok) return assert.fail(proposed.error);
  const result = run(proposed.name);
  await sleep(5);
  arbiter.cancel('user pause');
  assert.equal((await result).result.status, 'cancelled');
  await sleep(80);
  assert.equal(adapter.actions.includes('craft:diamond'), false);
  assert.equal(library.list()[0].trials.length, 0);
});

test('candidate versions and evidence persist atomically, with verified fallback after retiring a revision', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-methods-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'methods.json');
  const { library, adapter, memory, run } = fixture(t, file);
  const first = library.propose(candidate('versioned_sample'));
  if (!first.ok) return assert.fail(first.error);
  await run(first.name);
  adapter.inv.clear(); adapter.pos.x = 48;
  await run(first.name);
  assert.equal(library.list()[0].status, 'verified');
  assert.equal(library.propose(candidate('versioned_sample')).ok, true);
  assert.equal(library.list()[1].version, 2);
  library.dispose();
  const restored = new MethodLibrary(file, adapter, memory, new EventBus(), { trialWorldIds: [adapter.worldId] });
  t.after(() => restored.dispose());
  assert.equal(restored.list()[0].trials.length, 2);
  assert.equal(restored.list()[1].status, 'candidate');
  assert.ok(SKILLS['method:versioned_sample']);
  restored.retire('versioned_sample', 2, '候选需要继续修改');
  assert.ok(SKILLS['method:versioned_sample']);
  assert.equal(fs.existsSync(file + '.tmp'), false);
});

test('knowledge tools are explicitly read only and return structured evidence to the next decision', async (t) => {
  const { library, memory } = fixture(t);
  const tools = createMethodSkills(library, new ResourceKnowledge('1.20.1'));
  assert.equal(tools.every((tool) => tool.readOnly === true && !tool.movement), true);
  const catalog = tools.find((tool) => tool.name === 'method_catalog')!;
  assert.deepEqual((await catalog.run({} as any, {})).data?.methods, []);
  const controller = new AbortController(); controller.abort('stale task');
  const recordGap = tools.find((tool) => tool.name === 'record_ability_gap')!;
  await assert.rejects(recordGap.run({ signal: controller.signal, memory } as any, { description: '迟到的缺口' }), /aborted|stale task/i);
  assert.equal(library.abilityGaps().length, 0);
});
