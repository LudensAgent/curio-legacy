import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Vision } from '../src/perception/vision.ts';
import { assessLanding, assessLandings } from '../src/skills/landing.ts';
import { makeCtx, TestWorld } from './survival-helpers.ts';

test('visible landing geometry preserves fall risk, water depth, occlusion and fresh scope evidence', async (t) => {
  const adapter = new TestWorld(); adapter.pos = { x: .5, y: 70, z: .5 }; adapter.yaw = -Math.PI / 2; adapter.pitch = -.5;
  const vision = new Vision(adapter, { range: 24, hFov: 150, vFov: 150, cols: 15, rows: 11, bandCols: 0, bandRows: 0, hearRadius: 10 });
  vision.knownCount(); // Establish scope; seed only explicitly witnessed surfaces, without a game scan loop.
  const ground = { x: 1, y: 63, z: 0 }, water = { x: 1, y: 65, z: 1 }, hidden = { x: 4, y: 63, z: 0 };
  adapter.setBlock(water, 'water'); adapter.setBlock({ ...water, y: 64 }, 'water');
  for (let y = 64; y <= 74; y++) for (let z = -2; z <= 2; z++) adapter.setBlock({ x: 3, y, z }, 'stone');
  for (const [pos, name] of [[ground, 'grass_block'], [water, 'water'], [hidden, 'grass_block']] as const) {
    (vision as any).visibleSurfaces.set(`${pos.x},${pos.y},${pos.z}`, { pos, name, at: Date.now() });
  }
  const options = vision.landingOptions();
  const dry = options.find((o) => o.surface === 'ground' && o.support.pos.x === 1)!;
  assert.ok(dry, 'an actually visible floor can be assessed');
  assert.deepEqual(dry.target, { x: 1.5, y: 64, z: .5 });
  assert.equal(dry.drop, 6); assert.equal(dry.clearance, 'clear'); assert.equal(dry.corridor, 'clear');
  assert.equal(assessLanding(dry, 2).risk, 'lethal_estimate');
  assert.equal(assessLanding(dry, 20).estimatedFallDamage, 3);
  assert.equal(options.some((o) => o.support.pos.x === 4), false, 'a wall hides the farther floor despite its seeded old witness');
  const wet = options.find((o) => o.surface === 'water')!;
  assert.ok(wet); assert.equal(wet.waterDepth, 2); assert.equal(wet.target.y, water.y); assert.equal(wet.drop, 4);
  assert.equal(wet.receipt.worldId, adapter.worldId); assert.equal(wet.receipt.sessionId, adapter.sessionId);
  assert.deepEqual(wet.receipt.from, adapter.pos);
  adapter.setBlock({ ...water, y: 64 }, 'stone');
  assert.equal(vision.landingOptions().find((o) => o.surface === 'water')?.waterDepth, 'unknown', 'a water surface cannot imply deep water');
  const ctx = makeCtx(adapter, { senses: vision }); t.after(() => ctx.memory.close());
  ctx.senses.landingOptions = vision.landingOptions.bind(vision); ctx.senses.refresh = () => {};
  const result = await assessLandings.run(ctx, { radius: 6 });
  assert.equal(result.status, 'succeeded'); assert.equal(assessLandings.readOnly, true);
  assert.equal(adapter.actions.length, 0, 'assessment never moves, jumps or chooses a landing');
  adapter.sessionId = 'new-session';
  assert.deepEqual(vision.landingOptions(), [], 'old visual witnesses cannot cross a session boundary');
});
