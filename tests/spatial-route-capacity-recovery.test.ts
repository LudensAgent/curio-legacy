import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SectionKey } from 'curio-minecraft-3d-memory';
import { acquireRouteResidency } from '../src/spatial/skill-residency.ts';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';

const key: SectionKey = { worldId: 'w', dim: 'the_nether', cx: 1, cz: -2, sy: 4 };

function fake(initial: 'failed' | 'ready') {
  let mode = initial, checkpoints = 0;
  const capacity = { kind: 'byte_capacity' as const, message: 'cannot fit 1 sections (1292522 resident bytes): no eligible candidate to evict' };
  const spatial = {
    session: {
      voxelLoading: 'manual' as const,
      sectionResidency: () => ({ residency: 'not_resident' as const }),
    },
    prepare: async () => mode === 'failed'
      ? { status: 'failed' as const, result: { status: 'failed' as const, capacity, evictionRejected: [{ key, reason: 'dirty' }], noRecord: [], notReady: [], loaded: [], lease: { token: '', keys: [] } }, lease: null }
      : { status: 'ready' as const, result: { status: 'ready' as const, noRecord: [], notReady: [], loaded: [key], capacity: null, evictionRejected: [] }, lease: { token: 'lease-1', keys: [key] } },
    checkpoint: async () => { checkpoints += 1; mode = 'ready'; return {}; },
    releasePins() {},
  } as unknown as SharedSpatialSession;
  return { spatial, setMode: (next: 'failed' | 'ready') => { mode = next; }, checkpoints: () => checkpoints };
}

test('容量不足时异步保存一次并重试 prepare；冷却期内不反复保存', async () => {
  const w = fake('failed');
  const options = { deadline: Date.now() + 30_000 };
  const first = await acquireRouteResidency(w.spatial, [key], options);
  assert.equal(first.status, 'ready', '保存后重试成功');
  assert.equal(w.checkpoints(), 1);

  w.setMode('failed');
  const second = await acquireRouteResidency(w.spatial, [key], options);
  assert.equal(second.status, 'not_ready');
  if (second.status !== 'not_ready') return;
  assert.match(second.message, /不可换出：dirty×1/);
  assert.equal(w.checkpoints(), 1, '冷却期内不再保存');
  assert.doesNotMatch(second.message, /已保存并重试一次/);
});
