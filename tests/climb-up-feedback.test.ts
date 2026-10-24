import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GameAdapter, MoveOpts, MoveTarget } from '../src/adapter/types.ts';
import { climbUp } from '../src/skills/body.ts';
import type { SkillCtx } from '../src/skills/types.ts';

test('climb_up preserves explicit false through validation and rejects acknowledged movement without an actual ascent', async () => {
  let moves = 0;
  const adapter = {
    state: () => ({ pos: { x: 0.5, y: 77, z: 0.5 }, inventory: [{ name: 'cobblestone', count: 8 }] }),
    blockAt: () => 'air', lightAt: () => ({ block: 0, sky: 15 }),
    async moveTo(target: MoveTarget, opts: MoveOpts) { moves++; assert.equal(target.kind, 'xyz'); assert.equal(opts.allowTerrainChanges, true); },
  } as unknown as GameAdapter;
  for (const raw of [{ untilSky: false }, { until_sky: false }]) {
    const parsed = climbUp.validate(raw, adapter);
    assert.ok(parsed.ok); assert.equal(parsed.args.untilSky, false); assert.equal(parsed.args.height, 3);
    assert.deepEqual(climbUp.validate(parsed.args, adapter), parsed, 'arbiter validation must keep the normalized stop flags');
  }
  const parsed = climbUp.validate({ height: 3, untilSky: false, untilExit: true }, adapter);
  assert.ok(parsed.ok);
  const ctx = { adapter, signal: new AbortController().signal, deadline: Date.now() + 10_000, senses: { refresh() {} } } as unknown as SkillCtx;
  const result = await climbUp.run(ctx, parsed.args);
  assert.equal(moves, 1, 'visible sky must not stop an exit-only climb before its first attempt');
  assert.equal(result.status, 'failed'); assert.equal(result.failureCode, 'STUCK');
  assert.equal(result.data?.climbed, 0); assert.equal(result.data?.goalReached, false);
  assert.deepEqual(result.data?.exits, []);
  assert.equal((result.data?.effectEvidence as any).changed, false);
  assert.match(result.summary, /未实际爬升/);
});
