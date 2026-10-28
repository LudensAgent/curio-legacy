import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_VISION, Vision } from '../src/perception/vision.ts';
import { FakeAdapter } from './fake-adapter.ts';

test('a visible part of a stair landing is observable without seeing through the ledge', () => {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.2, y: 64, z: 0.5 };
  adapter.yaw = -Math.PI / 2;
  adapter.pitch = Math.atan2(-3.12, 1.3);
  adapter.removed.add('1,63,0');
  const target = { x: 1, y: 62, z: 0 };
  adapter.blocks.push({ name: 'diamond_ore', pos: target });
  adapter.lightAt = () => ({ block: 15, sky: 15 });
  const vision = new Vision(adapter, { ...DEFAULT_VISION, range: 16 });

  // The center ray crosses the block underfoot; the far side of the top face
  // is exposed through the dug step and can actually be seen from this stance.
  assert.equal(vision.observeBlocks([target])[0]?.name, 'diamond_ore');
  adapter.removed.delete('1,63,0');
  assert.deepEqual(vision.observeBlocks([target]), [], 'the intact step hides the entire target');
  adapter.removed.add('1,63,0');
  adapter.yaw = Math.PI / 2;
  assert.deepEqual(vision.observeBlocks([target]), [], 'a target behind the observer remains unknown');
});
