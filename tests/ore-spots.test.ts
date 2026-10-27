import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventBus } from '../src/events.ts';
import { oreAlias, oreSpotsByKind, oreSpotsNear } from '../src/memory/ore-spots.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { buildMindMessages } from '../src/mind/prompt.ts';
import { recallLocal } from '../src/mind/recall.ts';
import { SelfModel } from '../src/mind/self.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { gather } from '../src/skills/work.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx, TestWorld } from './survival-helpers.ts';

function memoryWithOres(worldId: string) {
  const m = new WorldMemory(null);
  m.setWorld(worldId);
  m.addLandmark('resource', 'iron_ore', 'overworld', { x: 20, y: 56, z: 0 });
  m.addLandmark('resource', 'deepslate_iron_ore', 'overworld', { x: 0, y: 10, z: -60 });
  m.addLandmark('resource', 'coal_ore', 'overworld', { x: -5, y: 64, z: 5 });
  m.addLandmark('death', '死亡地点', 'overworld', { x: 1, y: 64, z: 1 });
  return m;
}

test('记得的矿点按矿种归拢，带方向和高低', () => {
  const m = memoryWithOres('w');
  const spots = oreSpotsNear(m.landmarks(), { worldId: 'w', dim: 'overworld', pos: { x: 0, y: 64, z: 0 } });
  assert.deepEqual(spots.map((s) => s.kind), ['coal', 'iron', 'iron']);
  assert.equal(spots[1].text, '(20,56,0) 东20格，低 8 格');
  assert.deepEqual(oreSpotsByKind(spots, 1), { coal_ore: '(-5,64,5) 西南7格', iron_ore: '(20,56,0) 东20格，低 8 格' });
  assert.match(oreAlias('deepslate_iron_ore'), /挖铁/);
  m.close();
});

test('采集看不见目标时，说出长期记得的矿点，不再说"记忆里都没有"', async () => {
  const w = new TestWorld();
  const memory = memoryWithOres(w.state().worldId);
  const ctx = makeCtx(w, { memory });
  try {
    const r = await gather.run(ctx, { block: 'iron_ore', count: 2 } as any);
    assert.equal(r.status, 'failed');
    assert.doesNotMatch(r.summary, /视野和记忆里都没有/);
    assert.match(r.summary, /记得别处有 iron_ore：\(20,56,0\) 东\d+格，低 \d+ 格/);
    assert.match(r.summary, /goto \{"target":"20,56,0","dig":true\}/);
  } finally { memory.close(); }
});

test('回想：中文说"挖铁"也能想起记下的铁矿点', () => {
  const memory = memoryWithOres('default');
  const r = recallLocal('下矿挖铁，凑够粗铁', { self: new SelfModel(null), memory });
  assert.ok(r.some((x) => x.kind === 'place' && /iron_ore/.test(x.text)), JSON.stringify(r));
  memory.close();
});

test('心智每次思考（瞥一眼也算）都看得到记得的矿点；矿点不挤占地点列表', () => {
  const adapter = new FakeAdapter(), bus = new EventBus();
  const memory = memoryWithOres(adapter.state().worldId);
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const base = { reason: '测试', percept: perception.update(), state: adapter.state(), self: new SelfModel(null), memory, activity: null, suspended: [], lastRecord: null,
    noticed: [], changes: [], userSuggestion: null, audience: null, notes: [], mySkills: [], persona: 'P', skills: [] };
  for (const tier of ['glance', 'deliberate'] as const) {
    const user = buildMindMessages({ ...base, tier } as any)[1].content;
    const known = JSON.parse(user.match(/【记得的地方】(.*)/)![1]);
    assert.match(known.ore_spots.iron_ore, /\(20,56,0\)/, tier);
    if (tier === 'deliberate') assert.ok(!known.places.some((p: string) => /_ore/.test(p)));
  }
  memory.close();
});

test('挖掉记下的那块矿，矿点就忘掉；看见那一格已经不是矿也忘掉', () => {
  const adapter = new FakeAdapter(), bus = new EventBus();
  const memory = memoryWithOres(adapter.state().worldId);
  const vision = new Vision(adapter);
  const perception = new Perception(adapter, memory, bus, vision);
  (perception as any).forgetMinedOre({ dim: 'overworld' }, [{ pos: { x: 20, y: 57, z: 1 }, name: 'iron_ore', ts: 1 }]);
  assert.ok(!memory.landmarks().some((l) => l.label === 'iron_ore'), '挖掉了');
  assert.ok(memory.landmarks().some((l) => l.label === 'coal_ore'), '别的矿不受影响');
  (vision as any).visibleSurfaces.set('-5,64,5', { name: 'stone', pos: { x: -5, y: 64, z: 5 }, at: Date.now() });
  (perception as any).forgetVanishedOre({ dim: 'overworld', pos: { x: 0, y: 64, z: 0 } });
  assert.ok(!memory.landmarks().some((l) => l.label === 'coal_ore'), '亲眼看见那格是石头了');
  memory.close();
});

test('黑曜石、岩浆这类做不出来的天然资源也记成资源点，回想“黑曜石”“岩浆”想得起来', async () => {
  const m = new WorldMemory(null);
  m.setWorld('w');
  m.addLandmark('resource', 'obsidian', 'overworld', { x: 273, y: 63, z: -11 });
  m.addLandmark('resource', 'lava', 'overworld', { x: -30, y: 12, z: 0 });
  const spots = oreSpotsNear(m.landmarks(), { worldId: 'w', dim: 'overworld', pos: { x: 0, y: 64, z: 0 } }, { radius: 2000 });
  const byKind = oreSpotsByKind(spots, 1);
  assert.ok(byKind.obsidian && byKind.lava, JSON.stringify(byKind));
  assert.match(oreAlias('obsidian'), /黑曜石/);
  const r = recallLocal('附魔台还差黑曜石，去找岩浆', { self: new SelfModel(null), memory: m });
  assert.ok(r.some((x) => x.kind === 'place' && /obsidian|lava/.test(x.text)), JSON.stringify(r));
  m.close();
});

test('看见黑曜石时记下位置；看见岩浆既记成危险也记成资源', () => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null);
  adapter.blocks.push({ name: 'obsidian', pos: { x: 3, y: 64, z: 0 } }, { name: 'lava', pos: { x: 3, y: 64, z: 2 } });
  const perception = new Perception(adapter, memory, new EventBus(), new Vision(adapter));
  perception.update();
  const ls = memory.landmarks();
  assert.ok(ls.some((l) => l.kind === 'resource' && l.label === 'obsidian'), JSON.stringify(ls));
  assert.ok(ls.some((l) => l.kind === 'resource' && l.label === 'lava'));
  assert.ok(ls.some((l) => l.kind === 'danger' && l.label === 'lava'));
  memory.close();
});
