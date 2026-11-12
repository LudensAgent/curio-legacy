import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PersistenceError } from 'curio-minecraft-3d-memory/storage/sqlite';
import { acquireRouteResidency } from '../src/spatial/skill-residency.ts';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';

const KEY = { worldId: 'w', dim: 'overworld', cx: 0, cz: 0, sy: 4 };

function fakeSpatial(busyCalls: number) {
  let calls = 0;
  const spatial = {
    session: {
      voxelLoading: 'manual',
      sectionResidency: () => ({ residency: 'not_resident' }),
    },
    prepare: async () => {
      calls += 1;
      if (calls <= busyCalls) throw new PersistenceError('busy', 'a persistence request is in flight');
      return {
        status: 'ready',
        lease: { token: 'lease-1', keys: [KEY] },
        result: { noRecord: [], notReady: [], prepared: [KEY], alreadyResident: [], loaded: [KEY], missing: [] },
      };
    },
    getPersistenceState: () => ({ inFlightCheckpointId: calls <= busyCalls ? 'cp-1' : null, dirty: true }),
    release: () => {},
  };
  return { spatial: spatial as unknown as SharedSpatialSession, calls: () => calls };
}

test('busy prepare 在等待窗口内轮询重试，checkpoint 释放后拿到 lease', async () => {
  const fx = fakeSpatial(2);
  const residency = await acquireRouteResidency(fx.spatial, [KEY], { deadline: Date.now() + 2_000 });
  assert.equal(residency.status, 'ready');
  assert.equal(fx.calls(), 3, 'busy 两次后第三次 prepare 成功，而不是立即放弃');
  if (residency.status === 'ready') assert.deepEqual(residency.sections, [KEY]);
});

test('调用方 deadline 很短时，busy 等待按 deadline 停下并标为 cancelled', async () => {
  const fx = fakeSpatial(Number.POSITIVE_INFINITY);
  const started = Date.now();
  const residency = await acquireRouteResidency(fx.spatial, [KEY], { deadline: started + 120 });
  assert.equal(residency.status, 'not_ready');
  assert.equal(residency.status === 'not_ready' ? residency.reason : '', 'cancelled');
  assert.match(residency.status === 'not_ready' ? residency.message : '', /deadline/);
  assert.ok(Date.now() - started < 1_000, '按调用方 deadline 停止，不等满内部窗口');
});
