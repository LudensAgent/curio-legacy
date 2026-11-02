import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PassageTracker, passageEntranceDescent, passageLevels, passageRoute } from '../src/memory/passages.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { describePassage, myFacilities } from '../src/mind/facilities.ts';

const W = 'w1', D = 'overworld';
const at = (x: number, y: number, z: number) => ({ x, y, z });

/** 从地表 (0,64,0) 挖台阶往东下到 y40，再横着往东推 12 格；每一步都挖掉两格 */
function digDown(tr: PassageTracker, t0 = 1_000) {
  let t = t0;
  tr.observe({ worldId: W, dim: D, pos: at(0, 64, 0), place: 'surface' }, [], t);
  for (let i = 1; i <= 24; i++) {
    t += 1000;
    const pos = at(i, 64 - i, 0);
    tr.observe({ worldId: W, dim: D, pos, place: 'underground' }, [{ pos: at(i, 64 - i, 0), name: 'stone', ts: t }, { pos: at(i, 65 - i, 0), name: 'stone', ts: t }], t);
  }
  for (let i = 25; i <= 36; i++) {
    t += 1000;
    tr.observe({ worldId: W, dim: D, pos: at(i, 40, 0), place: 'underground' }, [{ pos: at(i, 40, 0), name: i === 30 ? 'iron_ore' : 'stone', ts: t }], t);
  }
  return t;
}

test('通道：挖台阶下去、横着推一段，记下入口、最深处、横巷那一层和挖到的矿；回到地表收尾', () => {
  const m = new WorldMemory(null); m.setWorld(W);
  const tr = new PassageTracker(m, () => 'p1');
  const t = digDown(tr);
  tr.observe({ worldId: W, dim: D, pos: at(36, 41, 0), place: 'other' }, [], t + 500);
  tr.observe({ worldId: W, dim: D, pos: at(36, 50, 0), place: 'surface' }, [], t + 9000);
  const [p] = m.passages(D);
  assert.equal(p.id, 'p1');
  // 下去的口是亲手挖开的那一格，挖上来冒出地表的口（这次没挖开）仍记站的位置
  assert.deepEqual(p.entrances, [at(1, 64, 0), at(36, 50, 0)]);
  assert.equal(p.deepestY, 40);
  assert.equal(p.ores.iron_ore, 1);
  assert.ok(p.dug >= 30);
  assert.deepEqual(passageLevels(p), [40]);
  m.close();
});

test('通道：走进天然洞穴、没怎么挖，记为走过的路（不算我挖的通道）；死了被传送，前后不连成一条', () => {
  const m = new WorldMemory(null); m.setWorld(W);
  const tr = new PassageTracker(m);
  tr.observe({ worldId: W, dim: D, pos: at(0, 64, 0), place: 'surface' }, [], 0);
  for (let i = 1; i <= 10; i++) tr.observe({ worldId: W, dim: D, pos: at(i * 2, 50, 0), place: 'underground' }, [], i * 1000);
  tr.observe({ worldId: W, dim: D, pos: at(20, 64, 0), place: 'surface' }, [], 20_000);
  // 天然洞穴：只走没挖 → 记为 walked，不是"我挖的通道"
  const walked = m.passages(D).filter((p) => p.kind === 'walked');
  assert.equal(walked.length, 1);
  assert.equal(walked[0].dug, 0);
  digDown(tr, 30_000);
  // 挖过的才是 dug
  const dug = m.passages(D).find((p) => p.kind !== 'walked');
  assert.ok(dug && dug.dug >= 30);
  // 死了，重生在 300 格外的地下：不能接到刚才那条挖过的上
  tr.observe({ worldId: W, dim: D, pos: at(300, 30, 0), place: 'underground' }, [], 90_000);
  const after = m.passages(D).find((p) => p.kind !== 'walked' && (p.dug ?? 0) >= 30);
  assert.ok(after && !after.path.some((q) => q.x === 300));
  m.close();
});

test('通道：从另一个口下到以前挖过的通道里，接着那一条记，多一个入口、多用一次', () => {
  const m = new WorldMemory(null); m.setWorld(W);
  let n = 0;
  const tr = new PassageTracker(m, () => `p${++n}`);
  const t = digDown(tr);
  tr.observe({ worldId: W, dim: D, pos: at(36, 64, 0), place: 'surface' }, [], t + 60_000);
  // 换个地方，从 (30,64,8) 挖下来接到 y40 那条横巷上
  tr.observe({ worldId: W, dim: D, pos: at(30, 64, 8), place: 'surface' }, [], t + 70_000);
  // 一级级挖下来（每 0.7 秒看一次，不会一下跳 20 格）
  for (let y = 62; y >= 41; y -= 3) tr.observe({ worldId: W, dim: D, pos: at(30, y, y > 50 ? 8 : 1), place: y > 60 ? 'other' : 'underground' }, [], t + 70_000 + (64 - y) * 500);
  const [p] = m.passages(D);
  assert.equal(m.passages(D).length, 1);
  assert.equal(p.uses, 2);
  // 原来下去的口、横巷尽头上到地表的口、新挖下来的口
  assert.equal(p.entrances.length, 3);
  assert.ok(p.entrances.some((e) => e.x === 30 && e.z === 8));
  m.close();
});

test('两条已记下的通道，从一条走进另一条时并成一条（碎片自愈）', () => {
  const m = new WorldMemory(null); m.setWorld(W);
  let n = 0;
  const tr = new PassageTracker(m, () => `p${++n}`);
  // 浅层横巷（y=60），点之间隔 4 格（≥ STEP=3 才会各记一个脚点），每点挖两格让它成"我挖的通道"
  const tunnel = (xs: number[], t0: number) => {
    tr.observe({ worldId: W, dim: D, pos: at(xs[0], 64, 0), place: 'surface' }, [], t0);
    let t = t0 + 1000;
    for (const x of xs) {
      tr.observe({ worldId: W, dim: D, pos: at(x, 60, 0), place: 'underground' }, [{ pos: at(x, 60, 0), name: 'stone', ts: t }, { pos: at(x, 61, 0), name: 'stone', ts: t }], t);
      t += 500;
    }
    tr.observe({ worldId: W, dim: D, pos: at(xs[xs.length - 1], 64, 0), place: 'surface' }, [], t + 9000);
  };
  tunnel([0, 4, 8], 0);          // A
  tunnel([12, 16, 20], 30_000);  // B，和 A 隔 4 格，创建时不合并
  assert.equal(m.passages(D).length, 2);
  // 从 B 走回 A：x=8 进入 A 的 3 格内，两条并成一条
  tr.observe({ worldId: W, dim: D, pos: at(20, 64, 0), place: 'surface' }, [], 50_000);
  for (const x of [16, 12, 8]) tr.observe({ worldId: W, dim: D, pos: at(x, 60, 0), place: 'underground' }, [], 51_000 + (20 - x) * 500);
  const ps = m.passages(D);
  assert.equal(ps.length, 1, '并成一条');
  assert.ok(ps[0].path.some((q) => q.x <= 1) && ps[0].path.some((q) => q.x >= 19), '脚点覆盖两头');
  m.close();
});

test('刚挖开的格子挨着另一条通道（人还没站进去）也并成一条（放宽到挖开的点）', () => {
  const m = new WorldMemory(null); m.setWorld(W);
  let n = 0;
  const tr = new PassageTracker(m, () => `p${++n}`);
  // A：浅层横巷 x=[0,4,8]，每点挖两格让它成"我挖的通道"
  const tunnel = (xs: number[], t0: number) => {
    tr.observe({ worldId: W, dim: D, pos: at(xs[0], 64, 0), place: 'surface' }, [], t0);
    let t = t0 + 1000;
    for (const x of xs) {
      tr.observe({ worldId: W, dim: D, pos: at(x, 60, 0), place: 'underground' }, [{ pos: at(x, 60, 0), name: 'stone', ts: t }, { pos: at(x, 61, 0), name: 'stone', ts: t }], t);
      t += 500;
    }
    tr.observe({ worldId: W, dim: D, pos: at(xs[xs.length - 1], 64, 0), place: 'surface' }, [], t + 9000);
  };
  tunnel([0, 4, 8], 0);
  assert.equal(m.passages(D).length, 1);
  // 从地表在 x=12 挖下来（站的位置离 A 的 x=8 还差 4 格 > PASSAGE_LINK），但挖开的那格 x=10 挨着 A 的 x=8（2 格）
  tr.observe({ worldId: W, dim: D, pos: at(12, 64, 0), place: 'surface' }, [], 30_000);
  tr.observe({ worldId: W, dim: D, pos: at(12, 60, 0), place: 'underground' }, [{ pos: at(10, 60, 0), name: 'stone', ts: 30_000 }], 31_000);
  assert.equal(m.passages(D).length, 1, '挖开的点挨着 A，并进 A 而不是另起一条');
  m.close();
});

test('通道给双向路线：回入口向上、朝最深处向下', () => {
  const m = new WorldMemory(null); m.setWorld(W);
  const tr = new PassageTracker(m, () => 'p1');
  digDown(tr);
  tr.observe({ worldId: W, dim: D, pos: at(36, 41, 0), place: 'other' }, [], 50_000);
  tr.observe({ worldId: W, dim: D, pos: at(36, 50, 0), place: 'surface' }, [], 60_000);
  const [p] = m.passages(D);
  const mid = at(18, 46, 0);
  const d = describePassage(p, mid);
  assert.equal(d.inside, true);
  assert.ok(d.next && d.nextDown, '双向都有下一步');
  assert.ok(d.next.y > mid.y, '回入口是向上');
  assert.ok(d.nextDown.y < mid.y, '朝最深处是向下');
  m.close();
});

test('我的设施：通道说明历史位置和未知的当前通路；箱子按数量说最多的几样；房子不混进来', () => {
  const m = new WorldMemory(null); m.setWorld(W);
  digDown(new PassageTracker(m, () => 'p1'));
  m.addLandmark('discovery', '我的床', D, at(36, 40, 1), 2);
  m.addLandmark('discovery', '我的白桦小舍', D, at(5, 64, 5), 4);
  m.addLandmark('resource', 'coal_ore', D, at(20, 44, 30));
  m.setChest(D, at(2, 64, 2), [{ name: 'oak_sapling', count: 4 }, { name: 'string', count: 2 }, { name: 'spider_eye', count: 1 }, { name: 'dirt', count: 3 }, { name: 'sand', count: 5 }, { name: 'sandstone', count: 1 }, { name: 'iron_ingot', count: 1 }, { name: 'cobblestone', count: 344 }]);
  const list = myFacilities(m, { worldId: W, dim: D, pos: at(10, 64, 0) });
  const tunnel = list.find((f) => f.kind === 'passage')!;
  assert.match(tunnel.text, /入口 \(1,64,0\)（水平 9 格外），曾到达最低 y40，历史脚点较多的高度有 y40，挖到过 iron_ore×1/);
  assert.match(tunnel.text, /历史路线附近记得有床.*洞口可能被堵或地形变了，走到附近再确认/);
  assert.doesNotMatch(tunnel.text, /能走到|会顺着/);
  const withoutSurface = describePassage({ ...m.passages(D)[0], entrances: [] }, at(10, 64, 0));
  assert.match(withoutSurface.text, /历史路线最高记录点 .*当前路线是否可通尚未确认/);
  assert.doesNotMatch(withoutSurface.text, /地表位置|入口/);
  assert.doesNotMatch(tunnel.text, /coal_ore/, '离通道太远的矿不算沿途');
  const chest = list.find((f) => f.kind === 'chest')!;
  assert.match(chest.text, /cobblestone×344、sand×5、oak_sapling×4、dirt×3、string×2、spider_eye×1/);
  assert.match(chest.text, /，8格$/);
  assert.ok(!list.some((f) => /小舍/.test(f.text)));
  // 人在通道里
  assert.equal(describePassage(m.passages(D)[0], at(30, 40, 0)).inside, true);
  m.close();
});

test('地标：同一格的“工作台”和“我的工作台”只留自己的；读档时把以前留下的成对的合并掉', () => {
  const m = new WorldMemory(null); m.setWorld(W);
  m.addLandmark('discovery', '工作台', D, at(1, 64, 1), 6);
  m.addLandmark('discovery', '我的工作台', D, at(1, 64, 1), 2);
  m.addLandmark('discovery', '工作台', D, at(1, 64, 1), 6);
  m.addLandmark('discovery', '工作台', D, at(40, 64, 1), 6);
  const labels = m.landmarks().map((l) => `${l.label}@${l.pos.x}`).sort();
  assert.deepEqual(labels, ['工作台@40', '我的工作台@1']);
  m.close();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-twins-'));
  const file = path.join(dir, 'world-memory.json');
  const lm = (label: string, x: number) => ({ id: label + x, kind: 'discovery', label, dim: D, pos: at(x, 64, 0), ts: 1, worldId: W });
  fs.writeFileSync(file, JSON.stringify({ version: 3, worldId: W, landmarks: [lm('熔炉', 5), lm('我的熔炉', 5), lm('熔炉', 50)] }));
  const loaded = new WorldMemory(file);
  assert.deepEqual(loaded.landmarks().map((l) => `${l.label}@${l.pos.x}`).sort(), ['我的熔炉@5', '熔炉@50']);
  loaded.close();
});

test('按需提醒：想下矿或回地面时说明历史路线与当前通路未知', async () => {
  const { situationalReminders } = await import('../src/mind/prompt.ts');
  const { SelfModel } = await import('../src/mind/self.ts');
  const { Perception } = await import('../src/perception/perception.ts');
  const { Vision } = await import('../src/perception/vision.ts');
  const { EventBus } = await import('../src/events.ts');
  const { FakeAdapter } = await import('./fake-adapter.ts');
  const adapter = new FakeAdapter();
  const m = new WorldMemory(null); m.setWorld(adapter.state().worldId);
  const world = adapter.state().worldId, dim = adapter.state().dim;
  // 在 FakeAdapter 的世界里记一条：入口 (0,64,0)，下到 y40
  const tr = new PassageTracker(m, () => 'p1');
  tr.observe({ worldId: world, dim, pos: at(0, 64, 0), place: 'surface' }, [], 0);
  for (let i = 1; i <= 24; i++) tr.observe({ worldId: world, dim, pos: at(i, 64 - i, 0), place: 'underground' }, [{ pos: at(i, 64 - i, 0), name: 'stone', ts: i }], i * 1000);
  m.addLandmark('discovery', '我的床', dim, at(23, 41, 1), 2);
  const perception = new Perception(adapter, m, new EventBus(), new Vision(adapter));
  const ctx = (pos: { x: number; y: number; z: number }, what: string) => {
    adapter.pos = pos;
    const self = new SelfModel(null);
    return { reason: '测试', percept: perception.update(), state: adapter.state(), self, memory: m, activity: { what, why: '' } as any, suspended: [], lastRecord: null,
      noticed: [], changes: [], userSuggestion: null, audience: null, notes: [], mySkills: [], persona: 'P', tier: 'glance' as const } as any;
  };
  const away = situationalReminders(ctx(at(20, 64, 30), '挖阶梯下到 y20 找铁'));
  assert.ok(away.some((r) => /记得自己挖过的通道：入口 \(1,63,0\)（水平 36 格外），曾到达最低 y40.*历史路线附近记得有床.*洞口可能被堵或地形变了，走到附近再确认/.test(r)), away.join('\n'));
  assert.ok(!away.some((r) => /goto 入口会顺着记下的路线走下去/.test(r)), away.join('\n'));
  const inside = situationalReminders(ctx(at(22, 42, 0), '顺着矿道往前找铁'));
  assert.ok(inside.some((r) => /你正沿着这条旧矿道.*沿旧矿道回入口的下一个路点 \(\d+,\d+,\d+\)/.test(r)), inside.join('\n'));
  const up = situationalReminders(ctx(at(22, 42, 0), '挖台阶一路挖到见天回地面'));
  assert.ok(up.some((r) => /你正沿着自己挖过的旧矿道；沿它回入口的下一步 \(\d+,\d+,\d+\)/.test(r)), up.join('\n'));
  assert.ok(up.some((r) => /follow_passage \{"to":"entrance"\}/.test(r)), up.join('\n'));
  const tripCtx = ctx(at(22, 42, 0), '回地面');
  tripCtx.percept.self.sky_visible = false;
  tripCtx.trip = { minutes: 2, gained: {}, nearEnd: true };
  const trip = situationalReminders(tripCtx).find((r) => r.startsWith('下矿的账'))!;
  assert.match(trip, /你正沿着自己挖过的旧矿道；沿它回入口的下一步 \(\d+,\d+,\d+\)/);
  assert.doesNotMatch(trip, /沿通道走回|挖台阶回地面|再下来一趟/);
  const busy = situationalReminders(ctx(at(20, 64, 30), '砍 16 根原木'));
  assert.ok(!busy.some((r) => /挖过的通道/.test(r)));
  m.close();
});

test('通道：从下往上挖也记——竖井、台阶里身体常判断成“坑里”，手上在挖就照样记点；冒出地表的地方记成入口', () => {
  const m = new WorldMemory(null); m.setWorld(W);
  const tr = new PassageTracker(m, () => 'up');
  // 重生在地下（没有刚才的地表记录），一路挖台阶往上：一半的时候身体说“在坑里”
  let t = 0;
  for (let i = 0; i <= 20; i++) {
    t += 1000;
    const pos = at(100 + i, 40 + i, 5);
    tr.observe({ worldId: W, dim: D, pos, place: i % 2 ? 'other' : 'underground' }, [{ pos: at(100 + i, 41 + i, 5), name: 'stone', ts: t }, { pos: at(101 + i, 42 + i, 5), name: 'stone', ts: t }], t);
  }
  tr.observe({ worldId: W, dim: D, pos: at(121, 62, 5), place: 'surface' }, [], t + 1000);
  const [p] = m.passages(D);
  assert.equal(p?.id, 'up');
  assert.ok(p.path.length >= 6, `记了 ${p.path.length} 个点`);
  assert.equal(p.deepestY, 40);
  assert.deepEqual(p.entrances, [at(121, 62, 5)]);
  m.close();
});

test('通道：只在“坑里”的竖直垫高往上爬（全程没判断成地下），也记下来', () => {
  const m = new WorldMemory(null); m.setWorld(W);
  const tr = new PassageTracker(m, () => 'shaft');
  tr.observe({ worldId: W, dim: D, pos: at(0, 70, 0), place: 'surface' }, [], 0);
  let t = 200_000; // 很久以后，在别处的地下：先瞬移过去
  tr.observe({ worldId: W, dim: D, pos: at(50, 30, 50), place: 'other' }, [], t);
  for (let y = 31; y <= 60; y++) { t += 1500; tr.observe({ worldId: W, dim: D, pos: at(50, y, 50), place: 'other' }, [{ pos: at(50, y + 1, 50), name: 'stone', ts: t }], t); }
  tr.observe({ worldId: W, dim: D, pos: at(50, 62, 50), place: 'surface' }, [], t + 1000);
  const [p] = m.passages(D);
  assert.equal(p?.id, 'shaft');
  assert.ok(p.path.some((q) => q.y <= 33) && p.path.some((q) => q.y >= 58));
  assert.deepEqual(p.entrances, [at(50, 61, 50)]);
  m.close();
});

test('通道：在地表平整地基、挖个浅坑不算通道', () => {
  const m = new WorldMemory(null); m.setWorld(W);
  const tr = new PassageTracker(m);
  let t = 0;
  tr.observe({ worldId: W, dim: D, pos: at(0, 64, 0), place: 'surface' }, [], t);
  for (let i = 0; i < 10; i++) { t += 1000; tr.observe({ worldId: W, dim: D, pos: at(i, 63, 0), place: 'other' }, [{ pos: at(i, 63, 1), name: 'dirt', ts: t }, { pos: at(i, 64, 1), name: 'dirt', ts: t }], t); }
  tr.observe({ worldId: W, dim: D, pos: at(10, 64, 0), place: 'surface' }, [], t + 1000);
  assert.equal(m.passages(D).length, 0);
  m.close();
});

test('通道：亲自一步步走过的相邻格记成 link，反复走不重复；跳跃跨格不连', () => {
  const m = new WorldMemory(null); m.setWorld(W);
  const tr = new PassageTracker(m, () => 'p1');
  let t = 0;
  tr.observe({ worldId: W, dim: D, pos: at(0, 64, 0), place: 'surface' }, [], t);
  // 一级级对角往下：每步相邻，连成 4 条 link
  for (let i = 1; i <= 5; i++) {
    t += 1000;
    tr.observe({ worldId: W, dim: D, pos: at(i, 64 - i, 0), place: 'underground' }, [{ pos: at(i, 64 - i, 0), name: 'stone', ts: t }], t);
  }
  const [p] = m.passages(D);
  assert.equal(p.links?.length, 4, `记了 ${p.links?.length ?? 0} 条 link（应 4）`);
  const has = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => p.links!.some((l) =>
    (l.a.x === a.x && l.a.y === a.y && l.a.z === a.z && l.b.x === b.x && l.b.y === b.y && l.b.z === b.z)
    || (l.a.x === b.x && l.a.y === b.y && l.a.z === b.z && l.b.x === a.x && l.b.y === a.y && l.b.z === a.z));
  assert.ok(has(at(1, 63, 0), at(2, 62, 0)), '有 (1,63,0)-(2,62,0) 这条边');
  // 从 (5,59,0) 直接跳到 (1,63,0)：跨 4 格，不连（不是相邻单步）
  tr.observe({ worldId: W, dim: D, pos: at(1, 63, 0), place: 'underground' }, [], t + 100000);
  assert.equal(m.passages(D)[0].links?.length, 4, '跨格跳跃不新增 link');
  // 再从 (1,63,0) 走回 (2,62,0)：这条边已经记过，去重不新增
  tr.observe({ worldId: W, dim: D, pos: at(2, 62, 0), place: 'underground' }, [], t + 101000);
  assert.equal(m.passages(D)[0].links?.length, 4, '反复走同一条边不重复');
  m.close();
});

test('重进大矿道：只挨着 links 端点、离 path 脚点远，也接着旧道记（不是新碎片）', () => {
  const m = new WorldMemory(null); m.setWorld(W);
  // 大矿道：path 稀疏（只有 x=0 一个点），links 密集（x=0..20 每格一条边）
  m.savePassage({ id: 'big', worldId: W, dim: D, kind: 'dug', entrances: [], deepestY: 40, dug: 30, ores: {}, createdAt: 0, lastUsedAt: 0, uses: 1,
    path: [{ x: 0, y: 40, z: 0 }],
    links: Array.from({ length: 20 }, (_, i) => ({ a: { x: i, y: 40, z: 0 }, b: { x: i + 1, y: 40, z: 0 } })) });
  const tr = new PassageTracker(m, () => 'new');
  tr.observe({ worldId: W, dim: D, pos: at(15, 64, 0), place: 'surface' }, [], 0);
  // 挖了几格（dug>=4），站在 x=15：挨 links 端点 x=14/16，但离 path 点 x=0 有 15 格
  tr.observe({ worldId: W, dim: D, pos: at(15, 40, 0), place: 'underground' }, [
    { pos: at(15, 40, 0), name: 'stone', ts: 1000 }, { pos: at(15, 41, 0), name: 'stone', ts: 1000 },
    { pos: at(15, 42, 0), name: 'stone', ts: 1000 }, { pos: at(15, 43, 0), name: 'stone', ts: 1000 },
  ], 1000);
  assert.equal(m.passages(D).length, 1, '挨着 links 端点就该接着旧道，不再另起碎片');
  assert.equal(m.passages(D)[0].id, 'big');
  m.close();
});

test('重进旧道脚下挨着旧脚点时补一条连接边，links 连成一体、passageRoute 能走通', () => {
  const m = new WorldMemory(null); m.setWorld(W);
  // 旧道 links 只到 x=5；重进站在 x=6（挨着 x=5），再往前走一步到 x=7
  m.savePassage({ id: 'big', worldId: W, dim: D, kind: 'dug', entrances: [], deepestY: 40, dug: 30, ores: {}, createdAt: 0, lastUsedAt: 0, uses: 1,
    path: [{ x: 0, y: 40, z: 0 }],
    links: Array.from({ length: 5 }, (_, i) => ({ a: { x: i, y: 40, z: 0 }, b: { x: i + 1, y: 40, z: 0 } })) });
  const tr = new PassageTracker(m, () => 'new');
  tr.observe({ worldId: W, dim: D, pos: at(6, 64, 0), place: 'surface' }, [], 0);
  tr.observe({ worldId: W, dim: D, pos: at(6, 40, 0), place: 'underground' }, [{ pos: at(6, 40, 0), name: 'stone', ts: 1000 }], 1000);
  tr.observe({ worldId: W, dim: D, pos: at(7, 40, 0), place: 'underground' }, [], 2000);
  const p = m.passages(D)[0];
  const route = passageRoute([p], { x: 0, y: 40, z: 0 }, { x: 7, y: 40, z: 0 });
  assert.ok(route, '重进补桥后 links 连通，能从 x=0 路由到 x=7');
  m.close();
});

test('通道：洞口正下方的下降脚点——验证被炸后地板还在不在时用', () => {
  const m = new WorldMemory(null); m.setWorld(W);
  const tr = new PassageTracker(m, () => 'p1');
  digDown(tr);
  const [p] = m.passages(D);
  const e = p.entrances[0];
  assert.deepEqual(e, at(1, 64, 0), '下去的口是亲手挖开的那一格');
  // 洞口正下方、离它最近的脚点是下一级台阶
  assert.deepEqual(passageEntranceDescent(p, e), at(1, 63, 0));
  // 洞口本身恰好也是一个脚点时，不算下降脚点
  assert.deepEqual(passageEntranceDescent({ ...p, path: [e, ...p.path] }, e), at(1, 63, 0));
  // 同高取水平最近的
  assert.deepEqual(passageEntranceDescent({ path: [at(3, 63, 0), at(1, 63, 0)] }, e), at(1, 63, 0));
  // 没有下降脚点：返回 null
  assert.equal(passageEntranceDescent({ path: [] }, e), null);
  m.close();
});
