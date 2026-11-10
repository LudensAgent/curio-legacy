import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FragmentStore, TopologyStore } from 'curio-minecraft-3d-memory';
import { semanticMemory } from './semantic-fixture.ts';

test('反复看见同一处资源不再每帧写事实；同一快照内查地标不重新分页', () => {
  const { memory, stores } = semanticMemory();
  // 旧路线拓扑仍可能存在于归档库中；语义组合不引用它，事实查询也不读它。
  const legacyTopology = new TopologyStore(new FragmentStore('test'));
  for (let i = 0; i < 1200; i++) {
    legacyTopology.saveNode({ id: `route_${i}`, kind: 'turn', source: 'program', worldId: 'test', dim: 'the_nether', location: { kind: 'exact', pos: { x: i, y: 64, z: 0 } } });
  }
  assert.equal(legacyTopology.nodes({ limit: 1 }).total, 1200);
  memory.addLandmark('resource', 'nether_quartz_ore', 'the_nether', { x: 5, y: 60, z: 5 });

  let writes = 0;
  let queries = 0;
  const upsertResource = stores.facts.upsertResource.bind(stores.facts);
  const upsertPlace = stores.facts.upsertPlace.bind(stores.facts);
  stores.facts.upsertResource = ((fact) => { writes++; return upsertResource(fact); }) as typeof stores.facts.upsertResource;
  stores.facts.upsertPlace = ((fact) => { writes++; return upsertPlace(fact); }) as typeof stores.facts.upsertPlace;
  for (const method of ['places', 'resources', 'containers'] as const) {
    const original = stores.facts[method].bind(stores.facts) as (...args: unknown[]) => unknown;
    stores.facts[method] = ((...args: unknown[]) => { queries++; return original(...args); }) as never;
  }

  // 视野里每帧都重复看见同一块矿：200 次重复确认。
  for (let i = 0; i < 200; i++) memory.addLandmark('resource', 'nether_quartz_ore', 'the_nether', { x: 5, y: 60, z: 5 });
  assert.equal(writes, 0, '刚确认过的地标重复看见不写事实');
  assert.ok(queries <= 3, `同一快照只分页一次，实际 ${queries} 次`);
  assert.equal(memory.landmarks().filter((l) => l.label === 'nether_quartz_ore').length, 1);

  // 过了刷新间隔再看见，才刷新一次观察时间。
  const real = Date.now;
  Date.now = () => real() + 61_000;
  try { memory.addLandmark('resource', 'nether_quartz_ore', 'the_nether', { x: 5, y: 60, z: 5 }); } finally { Date.now = real; }
  assert.equal(writes, 1, '超过刷新间隔才写一次');
});

test('同一快照内反复查地标复用同一份事实拷贝，写入后立即看到新内容', () => {
  const { memory, stores } = semanticMemory();
  for (let i = 0; i < 50; i++) memory.addLandmark('resource', `ore_${i}`, 'the_nether', { x: i * 40, y: 60, z: 0 });
  memory.landmarks();

  let queries = 0;
  for (const method of ['places', 'resources', 'containers'] as const) {
    const original = stores.facts[method].bind(stores.facts) as (...args: unknown[]) => unknown;
    stores.facts[method] = ((...args: unknown[]) => { queries++; return original(...args); }) as never;
  }

  // 一帧里按视野方块逐格查：100 次查询不应每次都重新分页。
  for (let i = 0; i < 100; i++) memory.landmarks();
  assert.equal(queries, 0, `同一快照内不重新分页，实际 ${queries} 次`);

  memory.addLandmark('danger', 'lava', 'the_nether', { x: 999, y: 60, z: 0 });
  assert.ok(memory.landmarks().some((l) => l.label === 'lava'), '写入后缓存失效，新地标可见');
  assert.ok(queries > 0, '写入后重新读取事实');
  const victim = memory.landmarks().find((l) => l.label === 'ore_3')!;
  memory.removeLandmark(victim.id);
  assert.ok(!memory.landmarks().some((l) => l.id === victim.id), '删除后缓存失效');
});
