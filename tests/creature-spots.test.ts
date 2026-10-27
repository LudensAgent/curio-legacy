import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventBus } from '../src/events.ts';
import { creatureSpotsByKind, creatureSpotsNear, HERD_MAX_AGE_MS } from '../src/memory/creature-spots.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { buildMindMessages } from '../src/mind/prompt.ts';
import { recallLocal } from '../src/mind/recall.ts';
import { SelfModel } from '../src/mind/self.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { hunt } from '../src/skills/survival.ts';
import { hudLandmarks } from '../src/observer/landmarks-hud.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx, TestWorld } from './survival-helpers.ts';

test('出没点：同一种 32 格内只记一处，再看见就挪过去、刷新只数；太旧的不再提', () => {
  const m = new WorldMemory(null);
  m.setWorld('w');
  m.noteHerd('sheep', 'overworld', { x: 40, y: 64, z: 0 }, 2, '白色×2');
  m.noteHerd('sheep', 'overworld', { x: 50, y: 64, z: 0 }, 3, '白色×2、黑色×1');
  m.noteHerd('cow', 'overworld', { x: -30, y: 64, z: 0 }, 1);
  const herds = m.landmarks().filter((l) => l.kind === 'herd');
  assert.equal(herds.length, 2);
  const spots = creatureSpotsNear(m.landmarks(), { worldId: 'w', dim: 'overworld', pos: { x: 0, y: 64, z: 0 } });
  assert.deepEqual(spots.map((s) => s.label), ['cow', 'sheep']);
  assert.match(spots[1].text, /^\(50,64,0\) 东50格，3 只（白色×2、黑色×1），刚才看见$/);
  assert.deepEqual(Object.keys(creatureSpotsByKind(spots, 1)), ['cow', 'sheep']);
  assert.equal(creatureSpotsNear(m.landmarks(), { worldId: 'w', dim: 'overworld', pos: { x: 0, y: 64, z: 0 } }, { now: Date.now() + HERD_MAX_AGE_MS + 1 }).length, 0);
  assert.equal(hudLandmarks(m.landmarks(), { pos: { x: 0, y: 64, z: 0 }, dim: 'overworld' }).length, 0, '直播叠层不列出没点');
  m.close();
});

test('看见羊群就记下（中心、只数、颜色）；走到跟前好几秒都没看见就忘掉', async () => {
  const adapter = new FakeAdapter(), bus = new EventBus(), memory = new WorldMemory(null);
  memory.setWorld(adapter.state().worldId);
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const seen = [{ name: 'sheep', kind: 'passive', pos: { x: 10, y: 64, z: 0 }, traits: '白色' }, { name: 'sheep', kind: 'passive', pos: { x: 12, y: 64, z: 2 }, traits: '白色、幼崽' },
    { name: 'zombie', kind: 'hostile', pos: { x: 5, y: 64, z: 0 } }, { name: 'bat', kind: 'passive', pos: { x: 3, y: 66, z: 0 } }];
  (perception as any).noteHerds({ dim: 'overworld', pos: { x: 0, y: 64, z: 0 } }, seen);
  const h = memory.landmarks().filter((l) => l.kind === 'herd');
  assert.deepEqual(h.map((l) => [l.label, l.pos, l.count, l.detail]), [['sheep', { x: 11, y: 64, z: 1 }, 2, '白色×2、幼崽×1']]);
  // 走到出没点跟前，一只都没看见：过 8 秒忘掉
  const p = perception as any;
  p.herdAt = 0; p.noteHerds({ dim: 'overworld', pos: { x: 11, y: 64, z: 1 } }, []);
  assert.equal(memory.landmarks().filter((l) => l.kind === 'herd').length, 1, '刚到还不忘');
  p.herdMiss.set(h[0].id, Date.now() - 9000); p.herdAt = 0;
  p.noteHerds({ dim: 'overworld', pos: { x: 11, y: 64, z: 1 } }, []);
  assert.equal(memory.landmarks().filter((l) => l.kind === 'herd').length, 0);
  memory.close();
});

test('hunt 看不见动物：说出记得在哪见过', async () => {
  const w = new TestWorld();
  const ctx = makeCtx(w);
  ctx.memory.setWorld(w.state().worldId);
  ctx.memory.noteHerd('sheep', w.state().dim, { x: 60, y: 64, z: -20 }, 3, '白色×3');
  try {
    const r = await hunt.run(ctx, { animal: 'sheep', count: 1 });
    assert.equal(r.status, 'failed');
    assert.match(r.summary, /记得别处见过：sheep \(60,64,-20\) 东北?\d+格，3 只（白色×3），刚才看见——要去就 goto \{"target":"60,64,-20"\} 再 hunt/);
  } finally { ctx.memory.close(); }
});

test('思考时看得到出没点；中文说"找羊做床"能想起羊', () => {
  const adapter = new FakeAdapter(), bus = new EventBus(), memory = new WorldMemory(null);
  memory.setWorld(adapter.state().worldId);
  memory.noteHerd('sheep', 'overworld', { x: 40, y: 64, z: 0 }, 2, '白色×2');
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const base = { reason: '测试', percept: perception.update(), state: adapter.state(), self: new SelfModel(null), memory, activity: null, suspended: [], lastRecord: null,
    noticed: [], changes: [], userSuggestion: null, audience: null, notes: [], mySkills: [], persona: 'P', skills: [] };
  for (const tier of ['glance', 'deliberate'] as const) {
    const known = JSON.parse(buildMindMessages({ ...base, tier } as any)[1].content.match(/【记得的地方】(.*)/)![1]);
    assert.match(known.animal_spots.sheep, /\(40,64,0\).*2 只（白色×2）/, tier);
    if (tier === 'deliberate') assert.ok(!(known.places ?? []).some((p: string) => /sheep/.test(p)));
  }
  const r = recallLocal('天黑前找羊，凑羊毛做床', { self: new SelfModel(null), memory });
  assert.ok(r.some((x) => x.kind === 'place' && /sheep .*见过 2 只/.test(x.text)), JSON.stringify(r));
  memory.close();
});
