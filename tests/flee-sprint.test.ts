import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MoveOpts, MoveTarget } from '../src/adapter/types.ts';
import { flee } from '../src/skills/combat.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

test('flee 默认走路，Agent 写 sprint:true 才跑；参数校验拒绝非布尔', async (t) => {
  const a = new FakeAdapter();
  a.entities.push({ id: 1, name: 'zombie', kind: 'hostile', pos: { x: 4, y: 64, z: 0 }, dist: 4 });
  const opts: (boolean | undefined)[] = [];
  a.moveTo = (async (_target: MoveTarget, o: MoveOpts) => { opts.push(o.sprint); }) as typeof a.moveTo;
  const ctx = makeCtx(a, { senses: { perceivedEntities: () => [{ id: 1, name: 'zombie', kind: 'hostile', pos: { x: 4, y: 64, z: 0 }, dist: 4 }] } });
  t.after(() => ctx.memory.close());
  const walk = flee.validate({}, a);
  assert.ok(walk.ok && walk.args.sprint === false);
  await flee.run(ctx, walk.args);
  const run = flee.validate({ sprint: true }, a);
  assert.ok(run.ok);
  await flee.run(ctx, run.args);
  assert.deepEqual(opts, [false, true]);
  assert.ok(!flee.validate({ sprint: 'yes' }, a).ok);
});
