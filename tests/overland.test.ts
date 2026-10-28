import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Vision } from '../src/perception/vision.ts';
import { planTravel, surveyColumn, travel } from '../src/skills/overland.ts';
import { validateSkill } from '../src/skills/types.ts';
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

test('travel：未乘船时只走和游，不消耗背包船或木料', async () => {
  const a = new FakeAdapter();
  river(a);
  a.inv.set('oak_boat', 1);
  a.inv.set('oak_log', 8);
  const r = await run(a, 'travel', { to: '30,0' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.ok(a.pos.x > 27, JSON.stringify(a.pos));
  assert.match(r.summary, /游了/);
  assert.equal(a.inv.get('oak_boat'), 1);
  assert.equal(a.inv.get('oak_log'), 8);
  assert.equal(a.riding, null);
  assert.ok(!a.actions.some((action) => /^(craft|use|interact|attack):/.test(action)));
});

test('travel：规划时的参数经仲裁器再次校验后仍能执行', async () => {
  const a = new FakeAdapter();
  const first = validateSkill(travel, { to: ' 5,64,0 ', noBoat: true }, a);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const again = validateSkill(travel, first.args, a);
  assert.deepEqual(again, first);
  const r = await run(a, 'travel', first.args);
  assert.equal(r.status, 'succeeded', r.summary);
  assert.ok(a.pos.x > 2.5, JSON.stringify(a.pos));
});

test('travel：地标和目标别名经二次校验保留目的地与选项', () => {
  const a = new FakeAdapter();
  for (const raw of [{ to: 'base' }, { target: 'death', noBoat: true }]) {
    const first = validateSkill(travel, raw, a);
    assert.equal(first.ok, true);
    if (first.ok) assert.deepEqual(validateSkill(travel, first.args, a), first);
  }
});

test('travel：已乘船时继续水面导航，不在重规划中下船', async () => {
  const a = new FakeAdapter();
  river(a);
  a.pos = { x: 12.5, y: 64, z: 0.5 };
  a.entities.push({ id: 7, name: 'boat', kind: 'other', pos: { ...a.pos }, dist: 0, height: 0.6 });
  await a.interactEntity(7, null, new AbortController().signal);
  const result = await run(a, 'travel', { to: '30,0' });
  assert.equal(result.failureCode, 'PATH_NOT_FOUND', '岸外陆路尚未完成');
  assert.equal(result.data?.docked, true);
  assert.equal(a.riding, 'boat');
  assert.equal(a.dismountToward, null);
  assert.ok(a.pos.x > 18);
});

test('planTravel：站在自己垫的高柱子上下不去时，说清楚是落差的问题', () => {
  const a = new FakeAdapter();
  for (let y = 64; y <= 69; y++) a.blocks.push({ name: 'dirt', pos: { x: 0, y, z: 0 } });
  const plan = planTravel((p) => a.blockAt(p), { x: 0.5, y: 70, z: 0.5 }, { x: 20, z: 0 }, { canBoat: false })!;
  assert.equal(plan.reached, false);
  assert.match(plan.why ?? '', /站在高处/);
});
