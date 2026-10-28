import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wait } from '../src/skills/wait.ts';
import { makeCtx, TestWorld } from './survival-helpers.ts';

test('等待参数是现实秒，结果把游戏时长标为估算', async (t) => {
  const world = new TestWorld();
  const ctx = makeCtx(world);
  t.after(() => ctx.memory.close());
  assert.match(wait.argsDoc, /现实秒/);
  const args = wait.validate({ seconds: 2, look: false }, world);
  assert.ok(args.ok);
  const result = await wait.run(ctx, args.args);
  assert.equal(result.status, 'succeeded');
  const elapsed = result.summary.match(/(\d+) 现实秒（按 20 TPS 估算约 ([\d.]+) 游戏分钟/);
  assert.ok(elapsed);
  assert.ok(Number(elapsed[1]) >= 2);
  assert.ok(Math.abs(Number(elapsed[2]) - Number(elapsed[1]) * 1.2) < 0.7);
});
