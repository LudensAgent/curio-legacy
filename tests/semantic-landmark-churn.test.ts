import assert from 'node:assert/strict';
import { test } from 'node:test';
import { semanticMemory } from './semantic-fixture.ts';

test('反复看见同一处资源不再每帧写事实；同一快照内查地标不重新分页', () => {
  const { memory, stores } = semanticMemory();
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

test('同一快照内反复查地标复用同一份事实拷贝，自己写入后就地更新、不整表重读', () => {
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
  assert.ok(memory.landmarks().some((l) => l.label === 'lava'), '写入后新地标可见');
  const victim = memory.landmarks().find((l) => l.label === 'ore_3')!;
  memory.removeLandmark(victim.id);
  assert.ok(!memory.landmarks().some((l) => l.id === victim.id), '删除后不再出现');
  assert.equal(queries, 0, `自己的写入按返回记录并进缓存，不应重新分页，实际 ${queries} 次`);
  // 绕过语义层直接写库（例如传送门记录）：修订号变了，下一次读取按库重读
  stores.facts.upsertPlace({ id: 'zz_external', kind: 'place', label: '外部写入', worldId: memory.worldId, dim: 'the_nether',
    location: { kind: 'exact', pos: { x: 1, y: 60, z: 1 } }, observedAt: Date.now(), source: { source: 'program' }, gone: false } as never);
  assert.ok(memory.landmarks().some((l) => l.label === '外部写入'), '库被别处改过就重读');
  assert.ok(queries > 0);
});

test('增量更新后的地标顺序与整表重读一致', () => {
  const { memory, stores } = semanticMemory();
  for (let i = 0; i < 30; i++) memory.addLandmark(i % 2 ? 'danger' : 'resource', i % 2 ? 'lava' : `ore_${i}`, 'the_nether', { x: i * 40, y: 60, z: 0 });
  memory.removeLandmark(memory.landmarks()[5]!.id);
  const incremental = memory.landmarks().map((l) => l.id);
  stores.facts.upsertPlace({ id: 'zz_external', kind: 'place', label: '外部写入', worldId: memory.worldId, dim: 'overworld',
    location: { kind: 'exact', pos: { x: 1, y: 60, z: 1 } }, observedAt: Date.now(), source: { source: 'program' }, gone: true, goneAt: Date.now(), goneSource: { source: 'program' } } as never);
  assert.deepEqual(memory.landmarks().map((l) => l.id), incremental);
});
