import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Vision } from '../src/perception/vision.ts';
import { FakeAdapter } from './fake-adapter.ts';

test('visible natural Nether ground becomes a legitimate gathering target and remains dimension scoped', () => {
  const adapter = new FakeAdapter();
  adapter.dim = 'the_nether';
  adapter.blocks = [{ name: 'netherrack', pos: { x: 4, y: 64, z: 0 } }, { name: 'blackstone', pos: { x: 5, y: 64, z: 1 } }];
  const vision = new Vision(adapter);
  vision.scan();
  assert.ok(vision.knownBlocks(['netherrack'], 16).length > 0, 'a seen Nether rock must not disappear between perception and gather');
  adapter.dim = 'the_end';
  adapter.blocks = [{ name: 'end_stone', pos: { x: 4, y: 64, z: 0 } }];
  vision.scan();
  assert.equal(vision.knownBlocks(['netherrack'], 16).length, 0);
  assert.ok(vision.knownBlocks(['end_stone'], 16).length > 0);
});
