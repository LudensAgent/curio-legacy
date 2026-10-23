import type { Vec3Like } from '../adapter/types.ts';

export interface ArrowShot {
  direction: Vec3Like;
  path: Vec3Like[];
}

/** Full-draw Java arrow: move, 0.99 air drag, then 0.05 gravity per tick. */
export function solveArrowShot(from: Vec3Like, target: Vec3Like): ArrowShot | null {
  const dx = target.x - from.x, dz = target.z - from.z;
  const range = Math.hypot(dx, dz), height = target.y - from.y;
  if (range < 0.1 || range > 64) return null;
  const simulate = (pitch: number) => {
    let horizontal = 0, y = 0, vx = 3 * Math.cos(pitch), vy = 3 * Math.sin(pitch);
    const path: Vec3Like[] = [{ ...from }];
    for (let tick = 0; tick < 120; tick++) {
      const fraction = Math.min(1, (range - horizontal) / vx);
      horizontal += vx * fraction; y += vy * fraction;
      path.push({ x: from.x + dx * horizontal / range, y: from.y + y, z: from.z + dz * horizontal / range });
      if (fraction < 1 || horizontal >= range - 1e-8) return { height: y, path };
      vx *= 0.99; vy = vy * 0.99 - 0.05;
    }
    return null;
  };
  // Select the first (lower) physical arc. Very steep/unreachable shots are
  // refused rather than assuming that a straight lookAt will hit a high tower.
  let previous: { pitch: number; error: number } | null = null;
  for (let degrees = -80; degrees <= 80; degrees += 5) {
    const pitch = degrees * Math.PI / 180, sample = simulate(pitch);
    if (!sample) continue;
    const error = sample.height - height;
    if (previous && previous.error <= 0 && error >= 0) {
      let lo = previous.pitch, hi = pitch;
      for (let step = 0; step < 22; step++) {
        const mid = (lo + hi) / 2, shot = simulate(mid);
        if (!shot || shot.height < height) lo = mid; else hi = mid;
      }
      const selected = (lo + hi) / 2, shot = simulate(selected)!;
      return { direction: { x: dx / range * Math.cos(selected), y: Math.sin(selected), z: dz / range * Math.cos(selected) }, path: shot.path };
    }
    previous = { pitch, error };
  }
  return null;
}

/** A crystal is two blocks wide; choose an actual body point through a gap. */
export function crystalArrowShot(from: Vec3Like, crystal: Vec3Like, height: number, segmentClear: (from: Vec3Like, to: Vec3Like) => boolean): ArrowShot | null {
  for (const y of [0.5, 0.75, 0.25]) for (const x of [0, -0.55, 0.55]) for (const z of [0, -0.55, 0.55]) {
    const shot = solveArrowShot(from, { x: crystal.x + x, y: crystal.y + height * y, z: crystal.z + z });
    if (shot && shot.path.slice(1).every((point, index) => segmentClear(shot.path[index], point))) return shot;
  }
  return null;
}
