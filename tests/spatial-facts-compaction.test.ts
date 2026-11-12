import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GONE_CONTAINER_KEEP,
  GONE_PLACE_KEEP,
  GONE_RESOURCE_KEEP,
} from '../src/spatial/semantic-store.ts';
import type { PlaceFact } from '../src/spatial/facts-adapter.ts';
import { semanticMemory } from './semantic-fixture.ts';

const WORLD = 'test';
const DIM = 'the_nether';

function gonePlace(index: number, observedAt: number): PlaceFact {
  return {
    id: `p${index}`,
    kind: 'place',
    label: `gone-${index}`,
    worldId: WORLD,
    dim: DIM,
    location: { kind: 'exact', pos: { x: index, y: 64, z: 0 } },
    observedAt,
    source: { source: 'program' },
    gone: true,
    goneAt: observedAt,
  };
}

test('compactGoneHistory 物理删除超过保留量的 gone 历史，并作废旧消失索引', () => {
  const { semantic } = semanticMemory(WORLD);
  // 先把历史堆到超过保留量；最老的一条用于确认 goneNear 的旧索引也被作废。
  for (let i = 0; i < GONE_PLACE_KEEP + 3; i += 1) semantic.facts.upsertPlace(gonePlace(i, 100 + i));
  const oldest = gonePlace(0, 100);
  assert.ok(semantic.goneNear(DIM, oldest.location.kind === 'exact' ? oldest.location.pos : oldest.location.center, 0).some((spot) => spot.label === 'gone-0'));

  const removed = semantic.compactGoneHistory();
  assert.equal(removed.places, 3);
  assert.equal(removed.resources, 0);
  assert.equal(removed.containers, 0);
  assert.equal(semantic.facts.places({ worldId: WORLD, includeGone: true }).total, GONE_PLACE_KEEP);
  assert.equal(semantic.goneNear(DIM, { x: 0, y: 64, z: 0 }, 0).some((spot) => spot.label === 'gone-0'), false);
});

test('compactGoneHistory 保留数量按含义分别作用，live 事实不受影响', () => {
  const { semantic } = semanticMemory(WORLD);
  semantic.facts.upsertPlace({
    id: 'live',
    kind: 'place',
    label: 'live-place',
    worldId: WORLD,
    dim: DIM,
    location: { kind: 'exact', pos: { x: 0, y: 64, z: 0 } },
    observedAt: 100,
    source: { source: 'program' },
    gone: false,
  });
  for (let i = 0; i < GONE_RESOURCE_KEEP + 2; i += 1) {
    const id = `r${i}`;
    semantic.facts.upsertResource({
      id,
      worldId: WORLD,
      dim: DIM,
      label: 'lava',
      sourceCell: { x: i, y: 64, z: 0 },
      observedAt: 100 + i,
      source: { source: 'program' },
      revoked: true,
      revokedAt: 100 + i,
    });
  }
  for (let i = 0; i < GONE_CONTAINER_KEEP + 1; i += 1) {
    const id = `c${i}`;
    semantic.facts.upsertContainer({
      id,
      worldId: WORLD,
      dim: DIM,
      pos: { x: i, y: 64, z: 0 },
      externalRef: `chest:${i}`,
      observedAt: 100 + i,
      source: { source: 'program' },
      gone: true,
      goneAt: 100 + i,
    });
  }

  const removed = semantic.compactGoneHistory();
  assert.equal(removed.resources, 2);
  assert.equal(removed.containers, 1);
  assert.equal(removed.places, 0);
  assert.equal(semantic.facts.places({ worldId: WORLD }).total, 1, 'live place 必须保留');
  assert.equal(semantic.facts.resources({ worldId: WORLD, includeGone: true }).total, GONE_RESOURCE_KEEP);
  assert.equal(semantic.facts.containers({ worldId: WORLD, includeGone: true }).total, GONE_CONTAINER_KEEP);
});
