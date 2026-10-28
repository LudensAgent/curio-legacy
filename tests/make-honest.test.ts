import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Arbiter, spentNote, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import type { GameAdapter } from '../src/adapter/types.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Vision } from '../src/perception/vision.ts';
import { SKILLS } from '../src/skills/index.ts';
import { fail, ok, runSkill, validateSkill, type Skill } from '../src/skills/types.ts';
import { validateDraft } from '../src/mind/thinker.ts';
import { makeBridge } from '../src/codeskills/bridge.ts';
import { executeProgram, validateProgram } from '../src/methods/program.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

test('结果里没提到、却被顺手用掉的东西：如实补一句', () => {
  const before = new Map([['oak_planks', 8], ['coal', 3], ['cobblestone', 10]]);
  const after = new Map([['oak_planks', 3], ['coal', 2], ['cobblestone', 10]]);
  assert.equal(spentNote(before, after, '烧好了 2 个 iron_ingot'), '；顺带用掉了 oak_planks×5、coal×1');
  assert.equal(spentNote(before, after, '用 oak_planks 做了船，烧了 coal'), '');
});

test('make:false：动作不顺手做缺的东西（craft 自己除外）；顺手用掉的写进结果', async () => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const arbiter = new Arbiter(adapter, memory, bus, new Vision(adapter));
  adapter.inv.set('oak_planks', 10);
  // 一个会顺手做船的动作：先 craft，再用
  const sideMaker: Skill<{}> = {
    name: 'test_side_maker', description: 'x', argsDoc: '{}', timeoutMs: 5000, movement: false,
    validate: () => ({ ok: true, args: {} }),
    async run(ctx) {
      try { await ctx.adapter.craft('oak_boat', 1, ctx.signal); } catch (e) { return fail('MISSING_MATERIALS', (e as Error).message); }
      adapter.inv.set('oak_planks', 5);
      return ok('划到了对岸');
    },
  };
  SKILLS.test_side_maker = sideMaker;
  try {
    let done = new Promise<TaskOutcome>((r) => arbiter.once('done', r));
    arbiter.start({ skill: 'test_side_maker', args: { make: true } }, 'llm');
    let o = await done;
    assert.equal(o.result.status, 'succeeded');
    assert.match(o.result.summary, /顺带用掉了 oak_planks×5/);
    done = new Promise<TaskOutcome>((r) => arbiter.once('done', r));
    arbiter.start({ skill: 'test_side_maker', args: { make: false } }, 'llm');
    o = await done;
    assert.equal(o.result.status, 'failed');
    assert.match(o.result.summary, /NO_MAKE.*oak_boat/);
  } finally { delete SKILLS.test_side_maker; }
  memory.close();
});

test('model draft preserves make:false through validation and Arbiter; preparation requires explicit opt-in', async (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  adapter.light = 0;
  adapter.inv.set('coal', 1); adapter.inv.set('stick', 1);
  const arbiter = new Arbiter(adapter, memory, bus, new Vision(adapter));
  t.after(() => { arbiter.cancel('cleanup'); memory.close(); });
  assert.equal(arbiter.validate({ skill: 'place_torch', args: { make: 'false' } }).ok, false);
  const draft = validateDraft({ what: '补光但不制造', steps: [{ skill: 'place_torch', args: { count: 1, make: false } }] }, adapter, memory, []);
  assert.ok(!('error' in draft));
  assert.equal((draft.steps[0].args as { make?: boolean }).make, false);
  const run = async (args: unknown) => {
    const done = new Promise<TaskOutcome>((resolve) => arbiter.once('done', resolve));
    assert.ok(!('error' in arbiter.start({ skill: 'place_torch', args }, 'llm')));
    return done;
  };
  assert.equal((await run(draft.steps[0].args)).result.status, 'failed');
  assert.equal((await run({ count: 1 })).result.status, 'failed');
  assert.deepEqual(adapter.actions, []);
  assert.equal((await run({ count: 1, make: true })).result.status, 'succeeded');
  assert.deepEqual(adapter.actions, ['craft:torch', 'place:torch']);
});

test('nested api.act honors local make:false, explicit preparation, and an outer prohibition', async (t) => {
  const adapter = new FakeAdapter(), ctx = makeCtx(adapter);
  adapter.light = 0;
  t.after(() => ctx.memory.close());
  const act = makeBridge(ctx);
  assert.equal((await act('act', ['place_torch', { count: 1, make: false }]) as { ok: boolean }).ok, false);
  assert.deepEqual(adapter.actions, []);
  assert.equal((await act('act', ['place_torch', { count: 1, make: true }]) as { ok: boolean }).ok, true);
  assert.deepEqual(adapter.actions, ['craft:torch', 'place:torch']);
  adapter.actions = [];
  const locked = makeBridge({ ...ctx, make: false });
  const result = await locked('act', ['place_torch', { count: 1, make: true }]) as { ok: boolean; code: string };
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BAD_ARGS');
  assert.deepEqual(adapter.actions, []);
});

test('explicit nested craft may make its target while adapter preparation remains disabled', async (t) => {
  const adapter = new FakeAdapter(), ctx = makeCtx(adapter);
  const calls: { item: string; prepare: boolean | undefined }[] = [];
  const body: GameAdapter = adapter;
  body.craft = async (item, count, _signal, options) => { calls.push({ item, prepare: options?.prepare }); return { ok: true, crafted: count }; };
  t.after(() => ctx.memory.close());
  const bridge = makeBridge({ ...ctx, make: false });
  const result = await bridge('act', ['craft', { item: 'stick', count: 2 }]) as { ok: boolean };
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ item: 'stick', prepare: false }]);
});

test('method programs preserve and apply make permissions to each call', async (t) => {
  const adapter = new FakeAdapter(), ctx = makeCtx(adapter);
  adapter.light = 0;
  t.after(() => ctx.memory.close());
  const program = validateProgram({ type: 'call', skill: 'place_torch', args: { count: 1, make: false } }, {}, adapter, ctx.memory, adapter.state());
  const outcome = await executeProgram(program, {}, { ...ctx, make: true });
  assert.equal(outcome.status, 'failed');
  assert.deepEqual(adapter.actions, []);
  const authorized = { type: 'call' as const, skill: 'place_torch', args: { count: 1, make: true } };
  assert.equal((await executeProgram(authorized, {}, ctx)).status, 'succeeded');
  assert.deepEqual(adapter.actions, ['craft:torch', 'place:torch']);
});

test('craft and smelt pass preparation permissions into adapter internals', async (t) => {
  const adapter = new FakeAdapter(), ctx = makeCtx(adapter);
  adapter.inv.set('raw_iron', 1); adapter.inv.set('coal', 1);
  const calls: { action: string; prepare: boolean | undefined }[] = [];
  const body: GameAdapter = adapter;
  body.craft = async (_item, count, _signal, options) => { calls.push({ action: 'craft', prepare: options?.prepare }); return { ok: true, crafted: count }; };
  body.smelt = async (_item, count, _fuel, _signal, options) => { calls.push({ action: 'smelt', prepare: options?.prepare }); return { ok: true, made: count }; };
  t.after(() => ctx.memory.close());
  for (const make of [false, true]) {
    for (const name of ['craft', 'smelt']) {
      const skill = SKILLS[name];
      const v = validateSkill(skill, { item: name === 'craft' ? 'stick' : 'raw_iron', count: 1, make }, adapter);
      assert.ok(v.ok);
      assert.equal((await runSkill(ctx, skill, v.args)).status, 'succeeded');
    }
  }
  assert.deepEqual(calls, [{ action: 'craft', prepare: false }, { action: 'smelt', prepare: false }, { action: 'craft', prepare: true }, { action: 'smelt', prepare: true }]);
});
