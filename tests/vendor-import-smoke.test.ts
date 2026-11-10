import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  InMemoryFactStore,
  VoxelMap,
  createVoxelFactsQueryPort,
  searchLandRoute,
} from 'curio-minecraft-3d-memory';
import type {
  MemoryHostCapabilities,
  SpatialQueryPort,
} from 'curio-minecraft-3d-memory';

test('vendor import smoke: current runtime exports are present', () => {
  assert.equal(typeof VoxelMap, 'function');
  assert.equal(typeof InMemoryFactStore, 'function');
  assert.equal(typeof createVoxelFactsQueryPort, 'function');
  assert.equal(typeof searchLandRoute, 'function');
});

test('vendor import smoke: type-only exports resolve', () => {
  const capabilities: MemoryHostCapabilities | null = null;
  const queryPort: SpatialQueryPort | null = null;
  assert.equal(capabilities, null);
  assert.equal(queryPort, null);
});
