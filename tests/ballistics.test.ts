import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crystalArrowShot, solveArrowShot } from '../src/combat/ballistics.ts';

test('full draw solutions reach both ordinary and high crystal body points with air drag', () => {
  for (const target of [{ x: 40, y: 1, z: 0 }, { x: 14, y: 36, z: 7 }, { x: -12, y: 5, z: -20 }]) {
    const from = { x: 0, y: 1.52, z: 0 }, shot = solveArrowShot(from, target);
    assert.ok(shot);
    assert.ok(Math.hypot(shot.path.at(-1)!.x - target.x, shot.path.at(-1)!.y - target.y, shot.path.at(-1)!.z - target.z) < 1e-5);
    assert.ok(shot.path.length > 2);
    assert.ok(Math.abs(Math.hypot(shot.direction.x, shot.direction.y, shot.direction.z) - 1) < 1e-8);
  }
  assert.equal(solveArrowShot({ x: 0, y: 0, z: 0 }, { x: 64, y: 300, z: 0 }), null);
});

test('crystal aiming checks the whole arc and refuses a fully blocked cage', () => {
  const from = { x: 0, y: 1.52, z: 0 }, crystal = { x: 20, y: 10, z: 0 };
  let checks = 0;
  const gap = crystalArrowShot(from, crystal, 2, (a, b) => {
    checks++;
    // A narrow bar along the central line; a real off-center body point is needed.
    return !(a.x <= 18 && b.x >= 18 && Math.abs(b.z) < 0.15);
  });
  assert.ok(gap);
  assert.ok(Math.abs(gap.path.at(-1)!.z) > 0.15);
  assert.ok(checks > gap.path.length);
  assert.equal(crystalArrowShot(from, crystal, 2, (a, b) => !(a.x <= 18 && b.x >= 18)), null);
});
