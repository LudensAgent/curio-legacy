import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PassageTracker, passageLevels } from '../src/memory/passages.ts';
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
  // 下去的口和挖上来冒出地表的口都是入口
  assert.deepEqual(p.entrances, [at(0, 64, 0), at(36, 50, 0)]);
  assert.equal(p.deepestY, 40);
  assert.equal(p.ores.iron_ore, 1);
  assert.ok(p.dug >= 30);
  assert.deepEqual(passageLevels(p), [40]);
  m.close();
});

test('通道：走进天然洞穴、没怎么挖，不记；死了被传送，前后不连成一条', () => {
  const m = new WorldMemory(null); m.setWorld(W);
  const tr = new PassageTracker(m);
  tr.observe({ worldId: W, dim: D, pos: at(0, 64, 0), place: 'surface' }, [], 0);
  for (let i = 1; i <= 10; i++) tr.observe({ worldId: W, dim: D, pos: at(i * 2, 50, 0), place: 'underground' }, [], i * 1000);
  tr.observe({ worldId: W, dim: D, pos: at(20, 64, 0), place: 'surface' }, [], 20_000);
  assert.equal(m.passages(D).length, 0, '天然洞穴');
  digDown(tr, 30_000);
  // 死了，重生在 300 格外的地下：不能接到刚才那条上
  tr.observe({ worldId: W, dim: D, pos: at(300, 30, 0), place: 'underground' }, [], 90_000);
  const [p] = m.passages(D);
  assert.ok(!p.path.some((q) => q.x === 300));
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

test('我的设施：通道说得出入口多远、多深、横巷、矿和里面的床；箱子按数量说最多的几样；房子不混进来', () => {
  const m = new WorldMemory(null); m.setWorld(W);
  digDown(new PassageTracker(m, () => 'p1'));
  m.addLandmark('discovery', '我的床', D, at(36, 40, 1), 2);
  m.addLandmark('discovery', '我的白桦小舍', D, at(5, 64, 5), 4);
  m.addLandmark('resource', 'coal_ore', D, at(20, 44, 30));
  m.setChest(D, at(2, 64, 2), [{ name: 'oak_sapling', count: 4 }, { name: 'string', count: 2 }, { name: 'spider_eye', count: 1 }, { name: 'dirt', count: 3 }, { name: 'sand', count: 5 }, { name: 'sandstone', count: 1 }, { name: 'iron_ingot', count: 1 }, { name: 'cobblestone', count: 344 }]);
  const list = myFacilities(m, { worldId: W, dim: D, pos: at(10, 64, 0) });
  const tunnel = list.find((f) => f.kind === 'passage')!;
  assert.match(tunnel.text, /入口 \(0,64,0\)（10 格外），能走到 y40，横巷在 y40，挖到过 iron_ore×1/);
  assert.match(tunnel.text, /里面有床/);
  assert.doesNotMatch(tunnel.text, /coal_ore/, '离通道太远的矿不算沿途');
  const chest = list.find((f) => f.kind === 'chest')!;
  assert.match(chest.text, /cobblestone×344/);
  assert.match(chest.text, /等 8 样/);
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

test('按需提醒：想下矿时说出现成的通道；人在通道里就说顺着走；没想下矿不提', async () => {
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
  assert.ok(away.some((r) => /你挖过的通道：入口 \(0,64,0\)（36 格外），能走到 y40.*里面有床.*goto 入口顺着走下去比从这里重新挖省事/.test(r)), away.join('\n'));
  const inside = situationalReminders(ctx(at(22, 42, 0), '顺着矿道往前找铁'));
  assert.ok(inside.some((r) => /你现在就在自己挖过的通道里：.*顺着走比重新挖省事/.test(r)), inside.join('\n'));
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
  assert.deepEqual(p.entrances, [at(50, 62, 50)]);
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
