import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  planRoute,
  RoutePlanRegistryImpl,
  WalkRouteExecutor,
} from 'curio-minecraft-3d-memory';
import type {
  MemoryHostCapabilities,
  SpatialQueryPort,
} from 'curio-minecraft-3d-memory';

test('vendor import smoke: runtime exports are present', () => {
  assert.equal(typeof planRoute, 'function');
  assert.equal(typeof RoutePlanRegistryImpl, 'function');
  assert.equal(typeof WalkRouteExecutor, 'function');
});

test('vendor import smoke: type-only exports resolve', () => {
  const capabilities: MemoryHostCapabilities | null = null;
  const queryPort: SpatialQueryPort | null = null;
  assert.equal(capabilities, null);
  assert.equal(queryPort, null);
});
