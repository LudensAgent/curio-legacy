import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { FakeAdapter } from './fake-adapter.ts';

test('stance observation covers actual fractional contacts without inventing terrain or waiting for a center-cell change', async (t) => {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 63.9375, z: 0.5 };
  for (const x of [-1, 0]) for (const z of [-1, 0]) adapter.blocks.push({ name: 'dirt_path', pos: { x, y: 63, z } });
  const dir = mkdtempSync(join(tmpdir(), 'perception-stance-'));
  const spatial = await SharedSpatialSession.open({ worldId: adapter.worldId, databasePath: join(dir, 'memory.db') });
  const memory = new WorldMemory(null);
  const perception = new Perception(adapter, memory, new EventBus(), new Vision(adapter), spatial);
  spatial.beginSession({ worldId: adapter.worldId, dim: adapter.dim, sessionId: adapter.sessionId });
  const voxel = spatial.session.voxel;
  try {
    perception.update();
    const top = voxel.cellAt(adapter.dim, 0, 65, 0);
    assert.ok(top.observed, 'feet at .9375 extend into the third vertical body cell');
    assert.equal(top.evidence.observation.source, 'local_rescan');
    assert.equal(top.evidence.observation.state.name, 'air');
    assert.equal(voxel.cellAt(adapter.dim, -1, 65, -1).observed, false, 'untouched neighboring space is not inferred');

    adapter.pos = { x: 0.2, y: 63.9375, z: 0.2 };
    perception.update();
    for (const x of [-1, 0]) for (const z of [-1, 0]) for (const y of [63, 64, 65]) {
      const view = voxel.cellAt(adapter.dim, x, y, z);
      assert.ok(view.observed, `newly touched column must not wait for the old 5-second center-cell key: ${x},${y},${z}`);
      assert.equal(view.evidence.observation.source, 'local_rescan');
      assert.equal(view.evidence.observation.state.name, y === 63 ? 'dirt_path' : 'air');
    }
    assert.equal(voxel.cellAt(adapter.dim, 1, 64, 0).observed, false, 'does not query forward terrain outside the current body');

    const read = adapter.blockStateAt.bind(adapter);
    t.mock.method(adapter, 'blockStateAt', (pos) => pos.x === 2 && pos.y === 65 && pos.z === 0 ? null : read(pos));
    adapter.pos = { x: 1.8, y: 63.9375, z: 0.5 };
    perception.update();
    assert.equal(voxel.cellAt(adapter.dim, 2, 64, 0).observed, true);
    assert.equal(voxel.cellAt(adapter.dim, 2, 65, 0).observed, false, 'unavailable blockstate is not inferred as air');

    adapter.onGround = false;
    adapter.pos = { x: 3.5, y: 64, z: 0.5 };
    perception.update();
    assert.equal(voxel.cellAt(adapter.dim, 3, 64, 0).observed, false, 'an airborne sample does not establish a current stance');

    adapter.onGround = true;
    adapter.pos = { x: 0.2, y: 63.9375, z: 0.2 };
    perception.update();
    adapter.sessionId = 'new-session';
    spatial.beginSession({ worldId: adapter.worldId, dim: adapter.dim, sessionId: adapter.sessionId });
    perception.update();
    const renewed = voxel.cellAt(adapter.dim, -1, 65, -1);
    assert.ok(renewed.observed);
    assert.equal(renewed.evidence.observation.sessionId, adapter.sessionId, 'a new session at the same stance must not inherit the old throttle key');
  } finally {
    memory.close();
    const result = await spatial.shutdown();
    if (result.close?.completed && result.close.error === null) rmSync(dir, { recursive: true, force: true });
  }
});
