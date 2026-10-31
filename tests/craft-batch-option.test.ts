import assert from 'node:assert/strict';
import { test } from 'node:test';
import { craft } from '../src/skills/work.ts';
import { runSkill, validateSkill } from '../src/skills/types.ts';
import type { GameAdapter } from '../src/adapter/types.ts';
import { TestWorld, makeCtx } from './survival-helpers.ts';

test('batch size survives validation and the nested preparation adapter', async () => {
  const world = new TestWorld();
  let options: Parameters<GameAdapter['craft']>[3];
  const original = world.craft.bind(world);
  world.craft = async (item, count, signal, opts?: Parameters<GameAdapter['craft']>[3]) => {
    options = opts;
    return original(item, count, signal);
  };
  const parsed = validateSkill(craft, { item: 'stick', count: 40, batchSize: 4 }, world);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.args.batchSize, 4);
  await runSkill(makeCtx(world), craft, parsed.args);
  assert.equal(options?.batchSize, 4);
  assert.equal(options?.prepare, false);
});
