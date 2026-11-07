import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Vec3Like } from '../src/adapter/types.ts';
import { passageDeepestAnchor, passageGraph, passageNext, passageRoute, passageSurfaceAnchor } from '../src/memory/passages.ts';


import { TestWorld } from './survival-helpers.ts';

// 一条 L 形矿道：从 (0,40,0) 往东到 (12,40,0)，再往南到 (12,40,12)；另一条从 (12,40,6) 往东岔出去
const main = { path: [{ x: 0, y: 40, z: 0 }, { x: 3, y: 40, z: 0 }, { x: 6, y: 40, z: 0 }, { x: 9, y: 40, z: 0 }, { x: 12, y: 40, z: 0 }, { x: 12, y: 40, z: 3 }, { x: 12, y: 40, z: 6 }, { x: 12, y: 40, z: 9 }, { x: 12, y: 40, z: 12 }] };
const branch = { path: [{ x: 14, y: 40, z: 6 }, { x: 17, y: 40, z: 6 }, { x: 20, y: 40, z: 6 }] };

/** 把记录脚点变成可站的通道：脚/头是空气、下方是实心。 */
const carve = (w: TestWorld, path: Vec3Like[]) => {
  for (const p of path) {
    const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
    w.setBlock({ x, y: y + 1, z }, 'air');
    w.setBlock({ x, y, z }, 'air');
    w.setBlock({ x, y: y - 1, z }, 'stone');
  }
};

test('沿记下的脚下点找路：同一条里前后相邻、不同条挨得近的点连起来', () => {
  const r = passageRoute([main, branch], { x: 0.5, y: 40, z: 0.5 }, { x: 20, y: 40, z: 6 })!;
  assert.deepEqual(r.map((p) => `${p.x},${p.z}`), ['0,0', '3,0', '6,0', '9,0', '12,0', '12,3', '12,6', '14,6', '17,6', '20,6']);
  assert.equal(passageRoute([main], { x: 0, y: 40, z: 0 }, { x: 50, y: 40, z: 50 }), null, '目标离通道太远');
  assert.equal(passageRoute([main], { x: 0, y: 80, z: 0 }, { x: 12, y: 40, z: 12 }), null, '自己离通道太远');
});

test('有 links 的通道：路由只沿真实走过的边，不因 ≤3.5 而几何抄近道', () => {
  const rec = {
    path: [] as Vec3Like[],
    links: [
      { a: { x: 0, y: 40, z: 0 }, b: { x: 1, y: 40, z: 0 } },
      { a: { x: 1, y: 40, z: 0 }, b: { x: 2, y: 40, z: 0 } },
      { a: { x: 2, y: 40, z: 0 }, b: { x: 3, y: 40, z: 0 } },
    ],
  };
  // (0,40,0) 和 (3,40,0) 直线相距 3（≤ link=3.5），但没走过这条边：路由应沿 0→1→2→3，不抄近道
  const r = passageRoute([rec], { x: 0, y: 40, z: 0 }, { x: 3, y: 40, z: 0 });
  assert.deepEqual(r!.map((p) => `${p.x},${p.z}`), ['0,0', '1,0', '2,0', '3,0']);
});

/** 图里从任意一个点出发能走到的节点数；等于总节点数说明只有一个连通分量。 */
const connected = (recs: Parameters<typeof passageGraph>[0]) => {
  const { nodes, edges } = passageGraph(recs);
  const seen = new Set<number>([0]);
  const stack = [0];
  while (stack.length) {
    const u = stack.pop()!;
    for (const v of edges.get(u) ?? []) if (!seen.has(v)) { seen.add(v); stack.push(v); }
  }
  return seen.size === nodes.length;
};

test('旧记录漏了一步：同一条 record 里正交相邻的两个脚点补上边，路线跨过 1 格缺口', () => {
  // 现场 psg_la3ozu 的形状：一条 record 的三段 links，(-2,84,-51) 与 (-2,84,-52) 之间漏了那一步
  const rec = {
    path: [] as Vec3Like[],
    links: [
      { a: { x: -2, y: 84, z: -51 }, b: { x: -2, y: 84, z: -50 } },
      { a: { x: -3, y: 84, z: -48 }, b: { x: -2, y: 84, z: -49 } },
      { a: { x: -2, y: 84, z: -52 }, b: { x: -2, y: 84, z: -53 } },
    ],
  };
  assert.equal(connected([rec]), true, '补上相邻缺口后是一条连通的道');
  const route = passageRoute([rec], { x: -0.3, y: 82, z: -54.5 }, { x: -2, y: 84, z: -51 });
  assert.deepEqual(route?.map((p) => `${p.x},${p.y},${p.z}`), ['-2,84,-53', '-2,84,-52', '-2,84,-51'], '路线跨过 (-2,84,-51)-(-2,84,-52)');
});

test('同一条 record 的连续记录之间按 observedStep 补桥：小缺口接上，大缺口/落差/非连续抄近道不连', () => {
  const rec = (links: { a: Vec3Like; b: Vec3Like; run?: number; cut?: boolean }[]) => ({ path: [] as Vec3Like[], links });
  // 连续两条 link 之间漏采了中间步（2 格同层）：身体确实从 (1,40,0) 走到 (3,40,0)，补上
  const sampled = rec([
    { a: { x: 0, y: 40, z: 0 }, b: { x: 1, y: 40, z: 0 } },
    { a: { x: 3, y: 40, z: 0 }, b: { x: 4, y: 40, z: 0 } },
  ]);
  assert.equal(connected([sampled]), true, '连续记录之间的 2 格同层缺口要补');
  // 连续两条之间是 12 格：不是观测间隔内的正常移动，不补
  const far = rec([
    { a: { x: 0, y: 40, z: 0 }, b: { x: 1, y: 40, z: 0 } },
    { a: { x: 13, y: 40, z: 0 }, b: { x: 14, y: 40, z: 0 } },
  ]);
  assert.equal(connected([far]), false, '连续记录之间的 12 格缺口不补');
  // 连续两条之间是 4 格落差：不能当成可走的边
  const drop = rec([
    { a: { x: 0, y: 64, z: 0 }, b: { x: 1, y: 64, z: 0 } },
    { a: { x: 1, y: 60, z: 0 }, b: { x: 2, y: 60, z: 0 } },
  ]);
  assert.equal(connected([drop]), false, '连续记录之间的 4 格落差不当成可走边');
  // 两条不相邻的 link 端点离得近，但记录顺序相隔很远：不按几何硬连
  const shortcut = rec([
    { a: { x: 0, y: 40, z: 0 }, b: { x: 1, y: 40, z: 0 } },
    { a: { x: 20, y: 40, z: 0 }, b: { x: 21, y: 40, z: 0 } },
    { a: { x: 1, y: 40, z: 2 }, b: { x: 2, y: 40, z: 2 } },
  ]);
  assert.equal(connected([shortcut]), false, '非连续记录之间不按几何距离抄近道');

  // merge/dedupe 拼接进来的 cut 边界：数组顺序不代表连续行程，不能跨过去补边
  const chain = (x0: number, z: number, n: number) => Array.from({ length: n }, (_, i) => ({
    a: { x: x0 + i, y: 40, z }, b: { x: x0 + i + 1, y: 40, z },
  }));
  const merged = rec([
    ...chain(0, 0, 4),
    ...chain(5, 1, 4).map((l, i) => i === 0 ? { ...l, cut: true } : l),
    { a: { x: 4, y: 40, z: 0 }, b: { x: 5, y: 40, z: 1 }, cut: true },
  ]);
  const { nodes, edges } = passageGraph([merged]);
  const idx = (x: number, z: number) => nodes.findIndex((p) => p.x === x && p.y === 40 && p.z === z);
  const a = idx(9, 1), b = idx(4, 0);
  assert.ok(a >= 0 && b >= 0, '两端节点都在图里');
  // 不标 cut 时，(9,40,1) 会和 (4,40,0) 相距 ~5.1 被 legacyStep 接成跨段假边。
  assert.equal(edges.get(a)?.has(b), false, 'cut 边界两侧不能补出跨段假边');
});

test('碎片化通道：站在接不回地表的支巷里，把全部通道连成网后仍能给出通向地表的下一步', () => {
  // 主竖井：地表 y64 一路下到 y32；支巷：在井底 y40 横向岔出去、最远 10 格，自己没记入口
  const shaft = { path: [{ x: 0, y: 64, z: 0 }, { x: 0, y: 60, z: 0 }, { x: 0, y: 56, z: 0 }, { x: 0, y: 52, z: 0 }, { x: 0, y: 48, z: 0 }, { x: 0, y: 44, z: 0 }, { x: 0, y: 40, z: 0 }, { x: 0, y: 36, z: 0 }, { x: 0, y: 32, z: 0 }], entrances: [{ x: 0, y: 66, z: 0 }] };
  const branch = { path: [{ x: 2, y: 40, z: 0 }, { x: 6, y: 40, z: 0 }, { x: 10, y: 40, z: 0 }], entrances: [] };
  const here = { x: 10, y: 40, z: 0 };
  // 单条支巷自己最高只有 y40，走不回地表
  assert.ok(passageRoute([branch], here, { x: 2, y: 40, z: 0 })!.every((p) => p.y === 40), '单条支巷的路线到不了地表');
  // 全网锚点取到主竖井的地表入口，路线一路回到 y64
  const anchor = passageSurfaceAnchor([shaft, branch], here);
  assert.deepEqual(anchor, { x: 0, y: 66, z: 0 });
  assert.ok(passageRoute([shaft, branch], here, anchor!)!.some((p) => p.y >= 64), '连网后的路线通到地表');
  const g = passageNext([shaft, branch], here, anchor!);
  assert.ok(g, '连网后能给出下一步');
  assert.deepEqual(g!.next, { x: 6, y: 40, z: 0 });
  assert.equal(g!.inside, true);
  // 下更深则取全网最深的脚点
  assert.deepEqual(passageDeepestAnchor([shaft, branch]), { x: 0, y: 32, z: 0 });
});

test('地表锚点取够得着的分量里最高入口，不取脚边但更深的归档入口', () => {
  // 当前位置在 y65 的竖井里。旁边一条归档通道在 y57 有个“入口”参考点，
  // 但它是脚下深处；同一条可走分量里最高到 y77。回地表不能选 y57。
  const shaft = {
    path: [{ x: 0, y: 65, z: 0 }, { x: 0, y: 70, z: 0 }, { x: 0, y: 77, z: 0 }],
    entrances: [{ x: 0, y: 61, z: 0 }],
  };
  const archived = {
    path: [{ x: 1, y: 57, z: 0 }, { x: 1, y: 50, z: 0 }],
    entrances: [{ x: 1, y: 57, z: 0 }],
  };
  const anchor = passageSurfaceAnchor([shaft, archived], { x: 0, y: 65, z: 0 });
  assert.equal(anchor?.y, 77, '选择可达分量的最高点，而不是水平最近的深处入口');
});

test('passageDeepestAnchor 只取从 here 连得上的最深处，另一团互不相连的碎片不算', () => {
  // 深井在原点附近，浅巷在 100 格外，两团相隔很远、连不上
  const deep = { path: [{ x: 0, y: 20, z: 0 }, { x: 0, y: 15, z: 0 }, { x: 0, y: 10, z: 0 }] };
  const shallow = { path: [{ x: 100, y: 55, z: 0 }, { x: 100, y: 50, z: 0 }] };
  // 不带 here：全网最深
  assert.deepEqual(passageDeepestAnchor([deep, shallow]), { x: 0, y: 10, z: 0 });
  // 站在浅巷附近：只取浅巷那团的最深（50），不取连不上的深井（10）
  assert.deepEqual(passageDeepestAnchor([deep, shallow], { x: 100, y: 52, z: 0 }), { x: 100, y: 50, z: 0 });
  // 站在深井附近：取深井那团的最深
  assert.deepEqual(passageDeepestAnchor([deep, shallow], { x: 0, y: 15, z: 0 }), { x: 0, y: 10, z: 0 });
});

test('同一份 records 复用图缓存；links 增加后缓存失效', () => {
  const rec = {
    path: [{ x: 0, y: 40, z: 0 }],
    links: [
      { a: { x: 0, y: 40, z: 0 }, b: { x: 1, y: 40, z: 0 } },
      { a: { x: 1, y: 40, z: 0 }, b: { x: 2, y: 40, z: 0 } },
    ],
  };
  const recs = [rec];
  const first = passageGraph(recs);
  assert.equal(passageGraph(recs), first, '同一份数组复用已建好的图');
  rec.links.push({ a: { x: 2, y: 40, z: 0 }, b: { x: 3, y: 40, z: 0 } });
  const next = passageGraph(recs);
  assert.notEqual(next, first, 'links 数量变化后必须重建');
  assert.ok(next.edges.get(2)?.has(3), '新加的 link 进入新图');
});

test('大图：几千节点的直道仍能完整路由（空间分桶不漏边）', () => {
  const path: Vec3Like[] = Array.from({ length: 5400 }, (_, x) => ({ x, y: 40, z: 0 }));
  const links = path.slice(1).map((b, i) => ({ a: path[i]!, b }));
  const route = passageRoute([{ path: [], links }], path[0]!, path[path.length - 1]!, { near: 6 });
  assert.equal(route?.length, path.length);
});
