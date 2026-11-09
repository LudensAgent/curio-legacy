import assert from 'node:assert/strict';
import { test } from 'node:test';
import { semanticMemory } from './semantic-fixture.ts';

test('反复看见同一处资源不再每帧写拓扑；同一修订号内查地标不重新分页扫全部节点', () => {
  const { memory, stores } = semanticMemory();
  // 模拟走过很多路后拓扑里有上千个与地标无关的路线节点。
  for (let i = 0; i < 1200; i++) {
    stores.topology.saveNode({ id: `route_${i}`, kind: 'turn', source: 'program', worldId: 'test', dim: 'the_nether', location: { kind: 'exact', pos: { x: i, y: 64, z: 0 } } });
  }
  memory.addLandmark('resource', 'nether_quartz_ore', 'the_nether', { x: 5, y: 60, z: 5 });
  const revision = stores.topology.revision;
  let pages = 0;
  const nodes = stores.topology.nodes.bind(stores.topology);
  stores.topology.nodes = ((query) => { pages++; return nodes(query); }) as typeof stores.topology.nodes;

  // 视野里每帧都重复看见同一块矿：200 次重复确认。
  for (let i = 0; i < 200; i++) memory.addLandmark('resource', 'nether_quartz_ore', 'the_nether', { x: 5, y: 60, z: 5 });
  assert.equal(stores.topology.revision, revision, '刚确认过的地标重复看见不写拓扑');
  assert.ok(pages <= 13, `同一修订号只扫一遍全部节点（约 13 页），实际 ${pages} 页`);
  assert.equal(memory.landmarks().filter((l) => l.label === 'nether_quartz_ore').length, 1);

  // 过了刷新间隔再看见，才刷新一次观察时间。
  const real = Date.now;
  Date.now = () => real() + 61_000;
  try { memory.addLandmark('resource', 'nether_quartz_ore', 'the_nether', { x: 5, y: 60, z: 5 }); } finally { Date.now = real; }
  assert.ok(stores.topology.revision > revision, '超过刷新间隔才写一次');
});
