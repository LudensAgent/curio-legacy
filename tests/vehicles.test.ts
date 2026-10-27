import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Vision } from '../src/perception/vision.ts';
import { SKILLS, skillCatalog } from '../src/skills/index.ts';
import { chooseBoat } from '../src/skills/vehicles.ts';
import { sleep } from '../src/util.ts';
import { FakeAdapter } from './fake-adapter.ts';

/** 东边 x=4..toX 是一片水（水面 y=63），再往东是陆地 */
const lake = (a: FakeAdapter, toX = 40) => {
  for (let x = 4; x <= toX; x++) for (let z = -3; z <= 3; z++) a.blocks.push({ name: 'water', pos: { x, y: 63, z } });
};
const setup = (a: FakeAdapter) => {
  const arbiter = new Arbiter(a, new WorldMemory(null), new EventBus(), new Vision(a));
  const run = async (skill: string, args: unknown) => {
    const done = new Promise<TaskOutcome>((r) => arbiter.once('done', r));
    const started = arbiter.start({ skill, args }, 'llm');
    assert.ok(!('error' in started), 'error' in started ? started.error : '');
    return (await done).result;
  };
  return { arbiter, run };
};

test('boat：已有船 → 放船、坐上、划到对岸、上岸并把船收回背包', async () => {
  const a = new FakeAdapter();
  lake(a);
  a.inv.set('spruce_boat', 1);
  const { run } = setup(a);
  const r = await run('boat', { direction: 'E', distance: 80 });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.ok(!a.actions.some((x) => x.startsWith('craft:')), '有船就不用再做');
  assert.ok(a.actions.includes('use:spruce_boat:water'));
  assert.ok(a.actions.includes('interact:boat'));
  assert.equal(a.state().riding, null, '靠岸后下船');
  assert.ok(a.pos.x > 40, `应该上到东岸，x=${a.pos.x}`);
  assert.equal(r.data?.kept, true, r.summary);
  assert.equal(a.inv.get('spruce_boat'), 1, '船收回了背包');
  assert.ok((r.data?.moved as number) > 30);
  assert.match(r.summary, /船已收回背包/);
});

test('boat：没有船时先用同种木板做一条；木料不够给出 MISSING_MATERIALS', async () => {
  const a = new FakeAdapter();
  lake(a);
  const { run } = setup(a);
  a.inv.set('oak_planks', 3);
  a.inv.set('birch_planks', 3);
  let r = await run('boat', { direction: 'E' });
  assert.equal(r.failureCode, 'MISSING_MATERIALS', r.summary);
  assert.match(r.summary, /5 块同种木板/);

  a.inv.set('birch_log', 2);
  r = await run('boat', { direction: 'E', keep: false });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.ok(a.actions.includes('craft:birch_boat'), a.actions.join(' '));
  assert.match(r.summary, /先做了一条 birch_boat/);
  assert.equal(r.data?.kept, false);
  assert.ok(!a.actions.some((x) => x.startsWith('attack:')), 'keep:false 不打船');
});

test('chooseBoat 只认同一种木头凑够 5 块', () => {
  assert.equal(chooseBoat([{ name: 'oak_planks', count: 4 }, { name: 'spruce_planks', count: 4 }]), null);
  assert.equal(chooseBoat([{ name: 'oak_planks', count: 4 }, { name: 'spruce_log', count: 2 }])?.item, 'spruce_boat');
  assert.equal(chooseBoat([{ name: 'cherry_planks', count: 5 }])?.item, 'cherry_boat');
  assert.equal(chooseBoat([{ name: 'bamboo_planks', count: 6 }])?.item, 'bamboo_raft');
});

test('boat：看不见水面 → NOT_FOUND（船留在背包里）', async () => {
  const a = new FakeAdapter();
  a.inv.set('oak_boat', 1);
  const { run } = setup(a);
  const r = await run('boat', { direction: 'N' });
  assert.equal(r.failureCode, 'NOT_FOUND', r.summary);
  assert.equal(a.inv.get('oak_boat'), 1);
});

test('boat：坐在船上时被取消会先下船', async () => {
  const a = new FakeAdapter();
  lake(a, 400);
  a.inv.set('oak_boat', 1);
  const { arbiter } = setup(a);
  const done = new Promise<TaskOutcome>((r) => arbiter.once('done', r));
  arbiter.start({ skill: 'boat', args: { direction: 'E', distance: 240 } }, 'llm');
  for (let i = 0; i < 200 && !a.riding; i++) await sleep(10);
  assert.equal(a.riding, 'boat', '应该已经坐上船');
  await sleep(30);
  arbiter.cancel('测试取消');
  const out = await done;
  assert.equal(out.result.status, 'cancelled');
  await sleep(50);
  assert.equal(a.riding, null, '取消后不能还坐在船上');
});

test('新技能都注册了，说明简短', () => {
  for (const n of ['boat', 'fish', 'wait']) {
    assert.ok(SKILLS[n], n);
    assert.ok(SKILLS[n].description.length <= 90, `${n} 描述太长：${SKILLS[n].description.length}`);
  }
  assert.match(skillCatalog(), /- boat /);
});

test('wait：原地等待且可被取消', async () => {
  const a = new FakeAdapter();
  const { run, arbiter } = setup(a);
  const t0 = Date.now();
  const r = await run('wait', { seconds: 2 });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.ok(Date.now() - t0 >= 1900);
  assert.ok(!a.actions.some((x) => x.startsWith('moveTo')));
  const done = new Promise<TaskOutcome>((res) => arbiter.once('done', res));
  arbiter.start({ skill: 'wait', args: { seconds: 60 } }, 'llm');
  await sleep(50);
  arbiter.cancel('够了');
  assert.equal((await done).result.status, 'cancelled');
});

test('boat：收船只打自己那条，旁边的运输船（chest_boat）不碰', async () => {
  const a = new FakeAdapter();
  lake(a);
  a.inv.set('oak_boat', 1);
  a.entities.push({ id: 77, name: 'chest_boat', kind: 'other', pos: { x: 40.5, y: 64, z: 1.5 }, dist: 0, height: 0.6 });
  const { run } = setup(a);
  const r = await run('boat', { direction: 'E', distance: 80 });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.ok(!a.actions.includes('attack:77'), '不能打运输船');
  assert.ok(a.entities.some((e) => e.id === 77));
  assert.equal(r.data?.kept, true, r.summary);
});

test('boat：本来就坐在船上、划船时出错也会下船；认不出自己的船时不乱打别的船', async () => {
  const a = new FakeAdapter();
  lake(a);
  a.entities.push({ id: 5, name: 'boat', kind: 'other', pos: { x: 6.5, y: 64, z: 0.5 }, dist: 0, height: 0.6 });
  await a.interactEntity(5, null, new AbortController().signal);
  assert.equal(a.riding, 'boat');
  const { run } = setup(a);
  const orig = a.ride.bind(a);
  a.ride = async () => { throw new Error('划不动了'); };
  let r = await run('boat', { direction: 'E' });
  assert.equal(r.status, 'failed', r.summary);
  assert.equal(a.riding, null, '出错后要下船');
  // 再坐上去正常划：没有已知 id 时只认下船处 3 格内的普通船；远处别人的船不碰
  a.ride = orig;
  a.entities.push({ id: 6, name: 'boat', kind: 'other', pos: { x: 30.5, y: 64, z: 3.5 }, dist: 0, height: 0.6 });
  await a.interactEntity(5, null, new AbortController().signal);
  r = await run('boat', { direction: 'E', distance: 80 });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.ok(!a.actions.includes('attack:6'), '别人的船不能打');
  assert.ok(a.actions.includes('attack:5'), r.summary);
});

test('boat：水路拐弯也能划过去（沿水面寻路，不是直线撞岸就停）', async () => {
  const a = new FakeAdapter();
  // 先往东一段（x=4..22, z=-2..2），再折向北（x=18..22, z=-30..-2）；直线去目标会撞上中间的陆地
  for (let x = 4; x <= 22; x++) for (let z = -2; z <= 2; z++) a.blocks.push({ name: 'water', pos: { x, y: 63, z } });
  for (let x = 18; x <= 22; x++) for (let z = -30; z < -2; z++) a.blocks.push({ name: 'water', pos: { x, y: 63, z } });
  a.inv.set('oak_boat', 1);
  const { run } = setup(a);
  const r = await run('boat', { to: '20,-28', keep: false });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.arrived, true, r.summary);
  assert.ok(a.pos.z < -24, `应该划到北边水道尽头，z=${a.pos.z}`);
  assert.ok(a.ridePaths[0].length >= 2, `应该有拐点：${JSON.stringify(a.ridePaths)}`);
  assert.ok((r.data?.moved as number) > 25, r.summary);
});

test('boat：目标在陆上 → 停到人能跨上去的低岸边，不在两格高的土坎下面下船', async () => {
  const a = new FakeAdapter();
  lake(a);
  // 东岸 z<=0 那段是两格高的土坎（落脚处比水面高 3 格，从船上跳不上去）；z>=1 是和水面齐平的低岸
  for (let x = 41; x <= 70; x++) for (let z = -3; z <= 0; z++) for (const y of [64, 65]) a.blocks.push({ name: 'dirt', pos: { x, y, z } });
  a.inv.set('oak_boat', 1);
  const { run } = setup(a);
  const r = await run('boat', { to: '60,-2', keep: false });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.route, 'shore', r.summary);
  assert.ok(a.dismountToward, '下船前要面朝岸边');
  assert.ok(a.dismountToward!.z >= 1, `应该选低岸那段：${JSON.stringify(a.dismountToward)}`);
  assert.match(r.summary, /上岸/);
  assert.ok(a.pos.x >= 41 && Math.floor(a.pos.z) >= 1, `应该站到低岸上：${JSON.stringify(a.pos)}`);
});
