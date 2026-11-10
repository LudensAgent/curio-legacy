import assert from 'node:assert/strict';
import { test } from 'node:test';
// 当前 v0.11 运行时值导出：voxel + facts + navigation search。
import { InMemoryFactStore, VoxelMap, createVoxelFactsQueryPort, searchLandRoute } from 'curio-minecraft-3d-memory';
// 类型导出：只 import type，不当运行时对象。
import type { ChangeReport, NavProblem, NavResult, Observation, SpatialQueryPort } from 'curio-minecraft-3d-memory';

test('空间库公开包入口可导入当前运行时值与类型', () => {
  assert.equal(typeof VoxelMap, 'function', 'VoxelMap 是运行时类');
  assert.equal(typeof InMemoryFactStore, 'function', 'InMemoryFactStore 是运行时类');
  assert.equal(typeof createVoxelFactsQueryPort, 'function', 'voxel+facts 查询组合是运行时函数');
  assert.equal(typeof searchLandRoute, 'function', 'voxel land search 是运行时函数');
});

test('voxel+facts 查询组合只报告当前查询 kind', () => {
  const worldId = 'smoke-world';
  const voxel = new VoxelMap(worldId, { validityWindowMs: 60_000 });
  const facts = new InMemoryFactStore();
  const port: SpatialQueryPort = createVoxelFactsQueryPort({ worldId, voxel, facts, query: { now: () => 1000 } });
  const caps = port.query({ kind: 'capabilities' } as never);
  assert.equal(caps.status, 'ok');
  if (caps.data?.kind !== 'capabilities') throw new Error('capabilities 查询必须返回 capabilities data');
  assert.equal(caps.data.capabilities.query.cells, true);
  assert.equal(caps.data.capabilities.query.nodes, true);
  for (const key of ['fragments', 'traversals', 'edges', 'historyRoute', 'anchors', 'components', 'segments', 'portals', 'frontiers']) {
    assert.equal(key in caps.data.capabilities.query, false, `退役 query.${key} 不应存在`);
  }
  assert.equal('plan' in caps.data.capabilities, false, '旧 plan 域不应存在');
});

// 这些类型变量只在编译期使用，运行时无对应导出；仅用于类型检查。
const _types: { r?: ChangeReport; o?: Observation; n?: NavResult; pr?: NavProblem } = {};
void _types;
