import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Arbiter, spentNote, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Vision } from '../src/perception/vision.ts';
import { SKILLS } from '../src/skills/index.ts';
import { fail, ok, type Skill } from '../src/skills/types.ts';
import { FakeAdapter } from './fake-adapter.ts';

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
      (ctx.adapter as any).inv.set('oak_planks', 5);
      return ok('划到了对岸');
    },
  };
  SKILLS.test_side_maker = sideMaker as any;
  try {
    let done = new Promise<TaskOutcome>((r) => arbiter.once('done', r));
    arbiter.start({ skill: 'test_side_maker', args: {} }, 'llm');
    let o = await done;
    assert.equal(o.result.status, 'succeeded');
    assert.match(o.result.summary, /顺带用掉了 oak_planks×5/);
    done = new Promise<TaskOutcome>((r) => arbiter.once('done', r));
    arbiter.start({ skill: 'test_side_maker', args: { make: false } }, 'llm');
    o = await done;
    assert.equal(o.result.status, 'failed');
    assert.match(o.result.summary, /make":false，不顺手做 oak_boat/);
  } finally { delete SKILLS.test_side_maker; }
});
