import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Vec3Like } from '../src/adapter/types.ts';
import { dedupePassages, passageGraph, passageRoute, passageSurfaceAnchor, passageSurfaceCandidates } from '../src/memory/passages.ts';

// 2026-11-05 现场形状：起点在旧矿道里，同分量有两个地表口——
// 一个 y 高 2 格但要从 y50 绕下去再爬回来，一个就在旁边。锚点应按路长选，而不是按 y 高选。
const start = { x: 0, y: 77, z: 0 };
const detour: Vec3Like[] = [
  { x: 0, y: 77, z: 0 }, { x: 0, y: 74, z: 0 }, { x: -1, y: 70, z: 0 }, { x: -2, y: 66, z: 0 },
  { x: -3, y: 62, z: 0 }, { x: -4, y: 58, z: 0 }, { x: -5, y: 54, z: 0 }, { x: -6, y: 50, z: 0 },
  { x: -7, y: 54, z: 0 }, { x: -8, y: 58, z: 0 }, { x: -9, y: 62, z: 0 }, { x: -10, y: 66, z: 0 },
  { x: -11, y: 70, z: 0 }, { x: -12, y: 74, z: 0 }, { x: -12, y: 79, z: 0 },
];
const near: Vec3Like[] = [{ x: 0, y: 77, z: 0 }, { x: 1, y: 78, z: 0 }, { x: 2, y: 79, z: 0 }];

const vRecord = { id: 'psg_detour', path: detour, entrances: [{ x: -12, y: 81, z: 0 }] };
const nearRecord = { id: 'psg_near', path: near, entrances: [{ x: 2, y: 79, z: 0 }] };

test('地表锚点按图上路长选：y 高 2 格但要绕 60 格的入口不选', () => {
  assert.deepEqual(passageSurfaceAnchor([vRecord, nearRecord], start), { x: 2, y: 79, z: 0 });
  // 只留那条绕路时仍能选它（不是按固定距离拒绝合法入口）
  assert.deepEqual(passageSurfaceAnchor([vRecord], start), { x: -12, y: 81, z: 0 });
});

test('地表候选带上代价和可指定记录 ID，按代价升序', () => {
  const candidates = passageSurfaceCandidates([vRecord, nearRecord], start);
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates[0]!.anchor, { x: 2, y: 79, z: 0 });
  assert.deepEqual(candidates[0]!.recordIds, ['psg_near']);
  assert.deepEqual(candidates[1]!.anchor, { x: -12, y: 81, z: 0 });
  assert.deepEqual(candidates[1]!.recordIds, ['psg_detour']);
  assert.ok(candidates[1]!.cost > candidates[0]!.cost + 20, `绕行入口的代价应明显更高：${candidates.map((c) => c.cost)}`);
});

test('地表带之外的入口不作为候选：比最高入口低太多的是深处入口', () => {
  const deep = {
    id: 'psg_deep',
    path: [{ x: 0, y: 77, z: 0 }, { x: 0, y: 72, z: 0 }, { x: 0, y: 67, z: 0 }, { x: 0, y: 62, z: 0 }, { x: 0, y: 60, z: 0 }],
    entrances: [{ x: 0, y: 60, z: 0 }],
  };
  const high = { id: 'psg_high', path: [{ x: 0, y: 77, z: 0 }, { x: 1, y: 78, z: 0 }, { x: 1, y: 79, z: 0 }], entrances: [{ x: 1, y: 79, z: 0 }] };
  const candidates = passageSurfaceCandidates([deep, high], start);
  assert.deepEqual(candidates.map((c) => c.anchor), [{ x: 1, y: 79, z: 0 }], 'y60 的深处入口不参与地表候选');
});

test('同一出口被多条记录重复记录时只算一个候选，保留所有记录 ID', () => {
  const a = { id: 'psg_a', path: [{ x: 0, y: 77, z: 0 }, { x: 1, y: 78, z: 0 }], entrances: [{ x: 2, y: 79, z: 0 }] };
  const b = { id: 'psg_b', path: [{ x: 0, y: 77, z: 0 }, { x: 2, y: 79, z: 1 }], entrances: [{ x: 2, y: 79, z: 1 }] };
  const candidates = passageSurfaceCandidates([a, b], start);
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0]!.recordIds.sort(), ['psg_a', 'psg_b']);
});

const edge = (ax: number, az: number, bx: number, bz: number, y = 40) =>
  ({ a: { x: ax, y, z: az }, b: { x: bx, y, z: bz } });

test('导航去重：点只差 1 格的重复记录只留 live 那条，不同的路保留', () => {
  const archived = { id: 'old', path: [{ x: 0, y: 40, z: 0 }, { x: 4, y: 40, z: 0 }, { x: 8, y: 40, z: 0 }], links: [edge(0, 0, 4, 0), edge(4, 0, 8, 0)], archivedAt: 1, lastUsedAt: 10 };
  const live = { id: 'new', path: [{ x: 0, y: 40, z: 1 }, { x: 4, y: 40, z: 1 }, { x: 8, y: 40, z: 1 }], links: [edge(0, 1, 4, 1), edge(4, 1, 8, 1)], lastUsedAt: 5 };
  const other = { id: 'other', path: [{ x: 100, y: 40, z: 0 }, { x: 104, y: 40, z: 0 }], archivedAt: 1, lastUsedAt: 1 };
  assert.deepEqual(dedupePassages([archived, live, other]).map((r) => r.id), ['new', 'other']);
});

test('导航去重：长巷里包含一条短巷时不误删长巷', () => {
  const long = { id: 'long', path: [{ x: 0, y: 40, z: 0 }, { x: 4, y: 40, z: 0 }, { x: 8, y: 40, z: 0 }, { x: 12, y: 40, z: 0 }], links: [edge(0, 0, 4, 0), edge(4, 0, 8, 0), edge(8, 0, 12, 0)] };
  const short = { id: 'short', path: [{ x: 4, y: 40, z: 0 }, { x: 8, y: 40, z: 0 }], links: [edge(4, 0, 8, 0)] };
  assert.deepEqual(dedupePassages([long, short]).map((r) => r.id), ['long', 'short']);
});

test('导航去重：只有 links 的旧记录也能比对（path 为空时退回边端点）', () => {
  const onlyLinks = (id: string, z: number) => ({ id, path: [] as Vec3Like[], links: [edge(0, z, 4, z), edge(4, z, 8, z)], archivedAt: 1, lastUsedAt: 1 });
  const out = dedupePassages([onlyLinks('old', 0), onlyLinks('old-copy', 1)]);
  assert.deepEqual(out.map((r) => r.id), ['old'], 'links 端点基本重合的旧记录合并成一条');
});

test('导航去重：被合并记录的 links/entrances 并进代表，不丢唯一的桥', () => {
  const archived = {
    id: 'old', archivedAt: 1, lastUsedAt: 10,
    path: [{ x: 0, y: 40, z: 0 }, { x: 4, y: 40, z: 0 }, { x: 8, y: 40, z: 0 }],
    // 这条记录握有 0↔8 的直连边：直接丢掉它会把这条路切断。
    links: [edge(0, 0, 4, 0), edge(4, 0, 8, 0), edge(0, 0, 8, 0)],
    entrances: [{ x: 8, y: 41, z: 0 }],
  };
  const live = {
    id: 'new', lastUsedAt: 5,
    path: [{ x: 0, y: 40, z: 1 }, { x: 4, y: 40, z: 1 }, { x: 8, y: 40, z: 1 }],
    links: [edge(0, 1, 4, 1), edge(4, 1, 8, 1)],
    entrances: [{ x: 8, y: 41, z: 1 }],
  };
  const out = dedupePassages([archived, live]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.id, 'new', 'live 优先当代表');
  assert.ok(out[0]!.links!.some((l) => l.a.x === 0 && l.a.z === 0 && l.b.x === 8 && l.b.z === 0), '被合并记录的桥必须保留');
  assert.equal(out[0]!.entrances!.length, 2, '被合并记录的入口也保留');
});

/** 图的连通分量数；去重只允许减少记录数，不允许增加分量数。 */
const componentCount = (recs: Parameters<typeof passageGraph>[0]) => {
  const { nodes, edges } = passageGraph(recs);
  const seen = new Set<number>();
  let count = 0;
  for (let i = 0; i < nodes.length; i++) {
    if (seen.has(i)) continue;
    count++;
    const stack = [i];
    seen.add(i);
    while (stack.length) for (const v of edges.get(stack.pop()!) ?? []) if (!seen.has(v)) { seen.add(v); stack.push(v); }
  }
  return count;
};

test('导航去重不减少连通分量：被并记录连到邻团的那一段必须保留', () => {
  const chain = (id: string, zs: number[], entrances: Vec3Like[] = []) => ({
    id, path: zs.map((z) => ({ x: 0, y: 40, z })), entrances,
    links: zs.slice(1).map((z, i) => ({ a: { x: 0, y: 40, z: zs[i]! }, b: { x: 0, y: 40, z } })),
  });
  // A 与 B 是同一段的重复记录（尾点相差 2 格）；B 的尾点 (0,40,14) 与 C 的 (0,40,16) 相距 2 格，
  // 跨记录自愈才会把它们连起来。B 被并进 A 后，这段桥点不能消失。
  const a = chain('A', [0, 3, 6, 9, 12]);
  const b = chain('B', [0, 3, 6, 9, 14]);
  const c = chain('C', [16, 17, 18, 19], [{ x: 0, y: 40, z: 19 }]);
  assert.equal(componentCount([a, b, c]), 1, '去重前是一整条连通通道');
  const deduped = dedupePassages([a, b, c]);
  assert.equal(deduped.length, 2, 'A/B 合成一条');
  assert.equal(componentCount(deduped), 1, '去重后不能多出分量');
  assert.ok(passageSurfaceCandidates(deduped, { x: 0, y: 40, z: 0 }).some((x) => x.anchor.z === 19), 'C 的入口仍然可选');
});

test('passageRoute 的终点不因附近有别的分量而失效', () => {
  const reachable = { path: [{ x: 0, y: 40, z: 0 }, { x: 5, y: 40, z: 0 }, { x: 10, y: 40, z: 0 }] };
  // 另一团孤立的通道恰好离目标 (10,40,2) 更近（1.8 格），但它和主通道断开 3.8 格。
  const isolated = { path: [{ x: 10, y: 40, z: 3.8 }, { x: 20, y: 40, z: 3.8 }] };
  const route = passageRoute([reachable, isolated], { x: 0, y: 40, z: 0 }, { x: 10, y: 40, z: 2 });
  assert.ok(route, '附近有断开的碎片时仍应能走到主通道那侧');
  assert.deepEqual(route!.at(-1), { x: 10, y: 40, z: 0 });
});
