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

test('同一修订号内反复查地标复用同一份语义节点拷贝，写入后立即看到新内容', () => {
  const { memory, stores } = semanticMemory();
  for (let i = 0; i < 50; i++) memory.addLandmark('resource', `ore_${i}`, 'the_nether', { x: i * 40, y: 60, z: 0 });
  memory.landmarks();
  let reads = 0;
  const getNode = stores.topology.getNode.bind(stores.topology);
  stores.topology.getNode = ((id) => { reads++; return getNode(id); }) as typeof stores.topology.getNode;

  // 一帧里按视野方块逐格查：100 次查询不应每次都把 50 个节点重新深拷贝一遍。
  for (let i = 0; i < 100; i++) memory.landmarks();
  assert.equal(reads, 0, `同一修订号内不重新拷贝节点，实际读了 ${reads} 次`);

  memory.addLandmark('danger', 'lava', 'the_nether', { x: 999, y: 60, z: 0 });
  assert.ok(memory.landmarks().some((l) => l.label === 'lava'), '写入后缓存失效，新地标可见');
  const victim = memory.landmarks().find((l) => l.label === 'ore_3')!;
  memory.removeLandmark(victim.id);
  assert.ok(!memory.landmarks().some((l) => l.id === victim.id), '删除后缓存失效');
});
