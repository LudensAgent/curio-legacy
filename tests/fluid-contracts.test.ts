import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { API_DOC, makeBridge, setReliableSkills } from '../src/codeskills/bridge.ts';
import { SKILLS } from '../src/skills/index.ts';
import { mineCell } from '../src/skills/movement/index.ts';
import { runSkill, type Skill } from '../src/skills/types.ts';
import { setBehaviorRegistry, useSkill } from '../src/skills/use-skill.ts';
import { AbortedError, sleep, TimeoutError } from '../src/util.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx, observeAllBlocks } from './survival-helpers.ts';

const pit = () => {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  [62, 61, 60, 59].forEach((y) => adapter.removed.add(`0,${y},0`));
  return adapter;
};

test('bucket actions reject stale ownership even when the caller supplies an independent signal', async (t) => {
  for (const invalidation of ['cancel', 'pause', 'session'] as const) await t.test(invalidation, async (t) => {
    const adapter = new FakeAdapter();
    adapter.inv.set('water_bucket', 1);
    const ctx = makeCtx(adapter);
    const arbiter = new Arbiter(adapter, ctx.memory, ctx.bus, ctx.senses);
    let release!: () => void, enter!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    SKILLS.test_bucket_owner = {
      name: 'test_bucket_owner', description: '', argsDoc: '{}', timeoutMs: 5000, movement: false,
      validate: () => ({ ok: true, args: {} }),
      async run(task) {
        enter();
        await gate;
        await task.adapter.useBucketAt!({ x: 1, y: 64, z: 0 }, 'water_bucket', new AbortController().signal);
        return { status: 'succeeded', summary: 'used bucket' };
      },
    };
    t.after(() => { delete SKILLS.test_bucket_owner; ctx.memory.close(); });
    const done = new Promise<TaskOutcome>((resolve) => arbiter.once('done', resolve));
    assert.ok(!('error' in arbiter.start({ skill: 'test_bucket_owner' }, 'llm')));
    await entered;
    if (invalidation === 'cancel') arbiter.cancel('new task');
    else if (invalidation === 'pause') arbiter.setPaused(true);
    else adapter.sessionId = 'new-session';
    release();
    assert.equal((await done).result.status, 'cancelled');
    assert.equal(arbiter.blockedActions, 1);
    assert.equal(adapter.inv.get('water_bucket'), 1);
    assert.deepEqual(adapter.actions, []);
  });
});

test('bucket actions inherit the owner signal and cancel an operation already waiting', async (t) => {
  const adapter = new FakeAdapter(), ctx = makeCtx(adapter);
  const arbiter = new Arbiter(adapter, ctx.memory, ctx.bus, ctx.senses);
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  let supplied: AbortSignal | undefined, owner: AbortSignal | undefined;
  adapter.useBucketAt = async (_pos, _item, signal) => {
    supplied = signal;
    enter();
    await sleep(5000, signal);
    assert.fail('cancelled bucket must not finish using an independent signal');
  };
  SKILLS.test_bucket_signal = {
    name: 'test_bucket_signal', description: '', argsDoc: '{}', timeoutMs: 5000, movement: false,
    validate: () => ({ ok: true, args: {} }),
    async run(task) {
      owner = task.signal;
      await task.adapter.useBucketAt!({ x: 1, y: 64, z: 0 }, 'water_bucket', new AbortController().signal);
      return { status: 'succeeded', summary: 'used bucket' };
    },
  };
  t.after(() => { delete SKILLS.test_bucket_signal; ctx.memory.close(); });
  const done = new Promise<TaskOutcome>((resolve) => arbiter.once('done', resolve));
  arbiter.start({ skill: 'test_bucket_signal' }, 'llm');
  await entered;
  assert.equal(supplied, owner);
  arbiter.cancel('cancel pending use');
  assert.equal((await done).result.status, 'cancelled');
  assert.equal(supplied?.aborted, true);
});

test('fall opt-in reaches both code entry points and preserves the observed risk receipt', async (t) => {
  assert.match(API_DOC, /api\.digAt\([^\n]+fall:true/);
  for (const method of ['digAt', 'act'] as const) await t.test(method, async (t) => {
    const adapter = pit(), ctx = makeCtx(adapter, { senses: { observeBlocks: observeAllBlocks(adapter) } });
    t.after(() => ctx.memory.close());
    const bridge = makeBridge(ctx);
    const blocked = await bridge(method, method === 'digAt' ? [0, 63, 0] : ['mine_cell', { at: [0, -1, 0], facing: 'N' }]) as { ok: boolean; code: string };
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'BAD_ARGS');
    assert.deepEqual(adapter.actions, []);
    const result = await bridge(method, method === 'digAt' ? [0, 63, 0, { fall: true }] : ['mine_cell', { at: [0, -1, 0], facing: 'N', fall: true }]) as { ok: boolean; data: { fallRisk: string; below: string | null; drop: number | null } };
    assert.equal(result.ok, true);
    assert.match(result.data.fallRisk, /3 格内未见落点/);
    assert.equal(result.data.below, null);
    assert.equal(result.data.drop, null, 'a bounded scan cannot invent the actual fall distance');
    assert.deepEqual(adapter.actions, ['dig:grass_block']);
  });
});

test('fall opt-in does not turn hidden landing blocks into observed facts', async (t) => {
  const adapter = pit();
  adapter.blocks.push({ name: 'lava', pos: { x: 0, y: 62, z: 0 } });
  const all = observeAllBlocks(adapter);
  const ctx = makeCtx(adapter, { senses: { observeBlocks: (positions) => all(positions.filter((p) => p.y >= 63)) } });
  t.after(() => ctx.memory.close());
  const result = await mineCell.run(ctx, { at: [0, -1, 0], facing: 'N', fall: true } as never);
  assert.equal(result.status, 'succeeded', result.summary);
  assert.match(String(result.data?.fallRisk), /未看清/);
  assert.equal(result.data?.below, null);
  assert.equal(result.data?.drop, null);
  assert.doesNotMatch(String(result.data?.fallRisk), /lava/);
});

test('recovery preserves fall authorization through nested step and code skills', async (t) => {
  for (const codeChild of [false, true]) for (const authorized of [false, true]) await t.test(`codeChild=${codeChild}, fall=${authorized}`, async (t) => {
    const adapter = pit(), ctx = makeCtx(adapter, { senses: { observeBlocks: observeAllBlocks(adapter) } });
    ctx.recovery = { skill: 'mine_cell', args: { at: [0, -1, 0], facing: 'N', ...(authorized ? { fall: true } : {}) }, target: { x: 0, y: 63, z: 0 } };
    const child = { name: 'fall-child', description: 'test', version: 1,
      steps: codeChild ? [] : [{ skill: 'mine_cell', args: { at: [0, -1, 0], facing: 'N', fall: true } }],
      ...(codeChild ? { code: 'const r = await api.digAt(0,63,0,{fall:true}); if (!r.ok) throw new Error(r.summary); return r;' } : {}),
    };
    const parent = { name: 'fall-parent', description: 'test', version: 1,
      steps: codeChild ? [{ skill: 'use_skill', args: { name: child.name } }] : [],
      ...(!codeChild ? { code: 'return await api.useSkill("fall-child");' } : {}),
    };
    const skills = [parent, child];
    setBehaviorRegistry({ get: (name) => skills.find((s) => s.name === name), list: () => skills });
    setReliableSkills(() => null);
    t.after(() => { setBehaviorRegistry(null); setReliableSkills(null); ctx.memory.close(); });
    const result = await useSkill.run(ctx, { name: parent.name });
    assert.equal(result.status, authorized ? 'succeeded' : 'failed', result.summary);
    if (!authorized) assert.match(result.summary, /fall:true/);
    assert.deepEqual(adapter.actions, authorized ? ['dig:grass_block'] : []);
  });
});

test('permission to dig during movement recovery does not also authorize falling', async (t) => {
  for (const permission of ['terrain', 'allowDig'] as const) await t.test(permission, async (t) => {
    const adapter = pit(), ctx = makeCtx(adapter, { senses: { observeBlocks: observeAllBlocks(adapter) } });
    ctx.recovery = { skill: 'walk_path', args: { routeId: 'rt_1' }, ...(permission === 'allowDig' ? { allowDig: true } : {}), target: { x: 2, y: 64, z: 0 } };
    t.after(() => ctx.memory.close());
    await assert.rejects(makeBridge(ctx)('act', ['mine_cell', { at: [0, -1, 0], facing: 'N', fall: true }]), /fall:true/);
    assert.deepEqual(adapter.actions, []);
  });
});

test('cancelled swim_path keeps observed partial displacement and exact coords through the arbiter', async () => {
  const adapter = new FakeAdapter();
  adapter.inWater = true; adapter.oxygen = 10;
  adapter.blocks.push({ name: 'water', pos: { x: 4, y: 64, z: 1 } });
  const ctx = makeCtx(adapter);
  const arbiter = new Arbiter(adapter, ctx.memory, ctx.bus, ctx.senses);
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { entered = resolve; });
  adapter.swimTo = async (_target, signal) => {
    adapter.pos = { x: -3.5, y: 62.25, z: 10.5 }; // 部分位移：小数 + 负值
    adapter.oxygen = 6;
    entered();
    await new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => {
        const e = new AbortedError(String(signal.reason));
        (e as Error & { partial?: Record<string, unknown> }).partial = { landed: false, surfaced: false, pos: { ...adapter.pos }, oxygen: adapter.oxygen };
        reject(e);
      });
    });
    return { ok: false, reason: 'WATER_ESCAPE_TIMEOUT', landed: false, surfaced: false, oxygen: 6 };
  };
  const done = new Promise<TaskOutcome>((resolve) => arbiter.once('done', resolve));
  assert.ok(!('error' in arbiter.start({ skill: 'swim_path', args: { mode: 'water_point', xyz: [4, 64, 1] } }, 'llm')));
  await gate;
  arbiter.cancel('替换任务');
  const outcome = await done;
  assert.equal(outcome.result.status, 'cancelled');
  assert.deepEqual(outcome.result.data?.pos, { x: -3.5, y: 62.25, z: 10.5 }, '保留取消前已发生的小数/负值位移');
  assert.equal(outcome.result.data?.oxygen, 6);
  ctx.memory.close();
});

test('runSkill survives a null/undefined rejection and still keeps a real partial', async () => {
  const adapter = new FakeAdapter(), ctx = makeCtx(adapter);
  // null/undefined rejection：不得崩溃，退回通用 ERROR 失败（旧失败行为）。
  for (const bad of [null, undefined]) {
    const skill: Skill<{}> = { name: `test_reject_${String(bad)}`, description: '', argsDoc: '{}', timeoutMs: 5000, movement: false,
      validate: () => ({ ok: true, args: {} }), run: async () => { throw bad; } };
    const result = await runSkill(ctx, skill, {});
    assert.equal(result.status, 'failed');
    assert.equal(result.failureCode, 'ERROR');
    assert.equal(result.data, undefined);
  }
  // 真正的 partial（TimeoutError）仍要原样保留。
  const timed: Skill<{}> = { name: 'test_reject_partial', description: '', argsDoc: '{}', timeoutMs: 5000, movement: false,
    validate: () => ({ ok: true, args: {} }), run: async () => {
      const e = new TimeoutError('timeout');
      (e as Error & { partial?: Record<string, unknown> }).partial = { pos: { x: 1, y: 2, z: 3 }, oxygen: 5 };
      throw e;
    } };
  const result = await runSkill(ctx, timed, {});
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'TIMEOUT');
  assert.deepEqual(result.data?.pos, { x: 1, y: 2, z: 3 });
  assert.equal(result.data?.oxygen, 5);
  ctx.memory.close();
});

test('timed-out swim_path keeps partial facts instead of discarding them', async () => {
  const adapter = new FakeAdapter();
  adapter.inWater = true; adapter.oxygen = 10;
  adapter.blocks.push({ name: 'water', pos: { x: 4, y: 64, z: 1 } });
  const ctx = makeCtx(adapter);
  const arbiter = new Arbiter(adapter, ctx.memory, ctx.bus, ctx.senses);
  adapter.swimTo = async () => {
    adapter.pos = { x: 1.25, y: 62.5, z: -0.5 };
    adapter.oxygen = 7;
    const e = new TimeoutError('timeout after 500ms');
    (e as Error & { partial?: Record<string, unknown> }).partial = { landed: false, surfaced: false, pos: { ...adapter.pos }, oxygen: adapter.oxygen };
    throw e;
  };
  const done = new Promise<TaskOutcome>((resolve) => arbiter.once('done', resolve));
  arbiter.start({ skill: 'swim_path', args: { mode: 'water_point', xyz: [4, 64, 1] } }, 'llm');
  const outcome = await done;
  assert.equal(outcome.result.status, 'failed');
  assert.equal(outcome.result.failureCode, 'TIMEOUT');
  assert.deepEqual(outcome.result.data?.pos, { x: 1.25, y: 62.5, z: -0.5 });
  assert.equal(outcome.result.data?.oxygen, 7);
  ctx.memory.close();
});
