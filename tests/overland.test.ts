import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Vision } from '../src/perception/vision.ts';
import { planTravel, surveyColumn } from '../src/skills/overland.ts';
import { FakeAdapter } from './fake-adapter.ts';

/** 地面 y=63 草地（站 y=64）；x=10..20 是一条横穿的河（水面 y=63） */
const river = (a: FakeAdapter) => { for (let x = 10; x <= 20; x++) for (let z = -40; z <= 40; z++) a.blocks.push({ name: 'water', pos: { x, y: 63, z } }); };
const run = async (a: FakeAdapter, skill: string, args: unknown) => {
  const arbiter = new Arbiter(a, new WorldMemory(null), new EventBus(), new Vision(a));
  const done = new Promise<TaskOutcome>((r) => arbiter.once('done', r));
  const started = arbiter.start({ skill, args }, 'llm');
  assert.ok(!('error' in started), 'error' in started ? started.error : '');
  return (await done).result;
};

test('surveyColumn：分得清地面、水面、树干和没加载的地方', () => {
  const a = new FakeAdapter();
  river(a);
  a.blocks.push({ name: 'oak_log', pos: { x: 3, y: 64, z: 0 } }, { name: 'oak_leaves', pos: { x: 4, y: 66, z: 0 } });
  const at = (p: any) => a.blockAt(p);
  assert.deepEqual(surveyColumn(at, 0, 0, 64), { kind: 'land', y: 64 });
  assert.deepEqual(surveyColumn(at, 12, 0, 64), { kind: 'water', y: 63 });
  assert.equal(surveyColumn(at, 3, 0, 64).kind, 'blocked', '树干挡路');
  assert.deepEqual(surveyColumn(at, 4, 0, 64), { kind: 'land', y: 64 }, '树冠底下照样能走');
  assert.equal(surveyColumn(() => null, 0, 0, 64).kind, 'blocked');
});

test('planTravel：隔着河——有船就坐船过去，没船就游过去', () => {
  const a = new FakeAdapter();
  river(a);
  const at = (p: any) => a.blockAt(p);
  const withBoat = planTravel(at, { x: 0.5, y: 64, z: 0.5 }, { x: 30, z: 0 }, { canBoat: true })!;
  assert.ok(withBoat.reached);
  assert.deepEqual(withBoat.legs.map((l) => l.mode), ['walk', 'water', 'walk']);
  const swim = planTravel(at, { x: 0.5, y: 64, z: 0.5 }, { x: 30, z: 0 }, { canBoat: false })!;
  assert.ok(swim.reached);
  assert.ok(swim.legs.some((l) => l.mode === 'water'));
});

test('travel：走到河边、坐船过河、上岸走到对面', async () => {
  const a = new FakeAdapter();
  river(a);
  a.inv.set('oak_boat', 1);
  const r = await run(a, 'travel', { to: '30,0' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.ok(a.pos.x > 27, JSON.stringify(a.pos));
  assert.match(r.summary, /坐船|游了/);
});
