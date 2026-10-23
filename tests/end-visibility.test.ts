import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Vision } from '../src/perception/vision.ts';
import { FakeAdapter } from './fake-adapter.ts';

function scene(dim: string) {
  const adapter = new FakeAdapter();
  adapter.dim = dim;
  adapter.light = 0;
  adapter.entities.push({ id: 1, name: 'ender_dragon', kind: 'hostile', pos: { x: 40, y: 65, z: 0 }, height: 8, phase: 0, dist: 40 });
  adapter.blocks.push({ name: 'end_stone', pos: { x: 20, y: 64, z: 0 } });
  return { adapter, vision: new Vision(adapter) };
}

test('End ambient visibility sees distant exposed terrain and dragon despite raw zero light', () => {
  const { vision } = scene('the_end');
  vision.scan();
  assert.ok([...vision.visibleNow.values()].some((b) => b.name === 'end_stone'));
  assert.ok(vision.seen.some((e) => e.name === 'ender_dragon' && e.phase === 0));
});

test('End ambient visibility preserves occlusion and the Overworld darkness limit', () => {
  const { adapter, vision } = scene('the_end');
  for (let y = 64; y <= 80; y++) for (let z = -8; z <= 8; z++) adapter.blocks.push({ name: 'obsidian', pos: { x: 8, y, z } });
  vision.scan();
  assert.equal(vision.seen.length, 0);
  assert.ok(![...vision.visibleNow.values()].some((b) => b.name === 'end_stone'));
  const dark = scene('overworld').vision;
  dark.scan();
  assert.equal(dark.seen.length, 0);
  assert.ok(![...dark.visibleNow.values()].some((b) => b.name === 'end_stone'));
});
