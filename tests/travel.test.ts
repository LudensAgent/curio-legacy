import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Vision } from '../src/perception/vision.ts';
import { equipmentSkills } from '../src/skills/equipment.ts';
import { SKILLS } from '../src/skills/index.ts';
import { buildPortal, travelSkills, useEndGateway } from '../src/skills/travel.ts';
import type { SkillCtx } from '../src/skills/types.ts';
import { travel } from '../src/skills/overland.ts';
import { travelStore } from '../src/travel/store.ts';
import { AbortedError, sleep } from '../src/util.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx, TestWorld } from './survival-helpers.ts';

Object.assign(SKILLS, travelSkills, equipmentSkills);
const setup = () => {
  const adapter = new FakeAdapter();
  adapter.speed = 1000;
  const memory = new WorldMemory(null);
  memory.setWorld(adapter.state().worldId);
  const bus = new EventBus();
  const vision = new Vision(adapter);
  const arbiter = new Arbiter(adapter, memory, bus, vision);
  const run = (skill: string, args: unknown = {}) => {
    const done = new Promise<TaskOutcome>((resolve) => arbiter.once('done', resolve));
    const started = arbiter.start({ skill, args }, 'llm');
    if ('error' in started) throw new Error(started.error);
    return done;
  };
  return { adapter, memory, bus, vision, arbiter, run };
};

test('build_portal places exactly ten obsidian and records only the activated portal observation', async () => {
  const { adapter, memory, run } = setup();
  adapter.inv.set('obsidian', 10);
  adapter.inv.set('flint_and_steel', 1);
  const outcome = await run('build_portal', { origin: { x: 3, y: 63, z: 0 }, axis: 'x' });
  assert.equal(outcome.result.status, 'succeeded', outcome.result.summary);
  assert.equal(adapter.blocks.filter((b) => b.name === 'obsidian').length, 10);
  assert.equal(adapter.inv.get('obsidian'), 0);
  const snapshot = travelStore(memory).snapshot(adapter.worldId);
  assert.equal(snapshot.endpoints.length, 1);
  assert.equal(snapshot.endpoints[0].portalObserved, true);
  assert.equal(adapter.blockAt(snapshot.endpoints[0].pos), 'nether_portal');
  assert.deepEqual(snapshot.routes, []);
});

test('build_portal allowTower 用显式 pillarUp 站高，不把垫脚交给寻路的隐式地形操作', async (t) => {
  const { adapter, run } = setup();
  adapter.inv.set('obsidian', 10);
  adapter.inv.set('flint_and_steel', 1);
  adapter.inv.set('cobblestone', 4);
  const calls: { pos: { x: number; y: number; z: number }; opts: Parameters<FakeAdapter['moveTo']>[1] }[] = [];
  const towerStances: { pos: { x: number; y: number; z: number }; names: string[] }[] = [];
  const moveTo = adapter.moveTo.bind(adapter), pillarUp = adapter.pillarUp.bind(adapter);
  // 模拟“够不到上方门框”：只有原地垫高之后，同一放置目标才变得可达。
  t.mock.method(adapter, 'moveTo', async (target: Parameters<FakeAdapter['moveTo']>[0], opts: Parameters<FakeAdapter['moveTo']>[1]) => {
    if (target.kind === 'reach_block' || target.kind === 'near') return;
    if (target.kind === 'place_block') {
      calls.push({ pos: target.pos, opts });
      if (target.pos.y > Math.floor(adapter.pos.y) + 1) throw new Error('PLACEMENT_NOT_REACHABLE');
      return;
    }
    return moveTo(target, opts);
  });
  t.mock.method(adapter, 'pillarUp', async (names: string[], signal: AbortSignal) => {
    towerStances.push({ pos: { ...adapter.pos }, names: [...names] });
    return pillarUp(names, signal);
  });
  const outcome = await run('build_portal', { origin: { x: 3, y: 63, z: 0 }, axis: 'x', allowTower: true });
  assert.equal(outcome.result.status, 'succeeded', outcome.result.summary);
  assert.equal(adapter.blocks.filter((b) => b.name === 'obsidian').length, 10);
  assert.equal(adapter.inv.get('obsidian'), 0);
  assert.ok(calls.length > 0 && calls.every((c) => !Object.hasOwn(c.opts, 'allowPlace') && !Object.hasOwn(c.opts, 'allowTower') && !Object.hasOwn(c.opts, 'noPlaceAt')), '放置站位不再委托寻路改造地形');
  assert.ok(towerStances.length >= 1, '够不到时执行显式垫高');
  const banned = new Set(['3,63,0', '4,63,0', '5,63,0', '6,63,0', '3,64,0', '4,64,0', '5,64,0', '6,64,0', '3,65,0', '4,65,0', '5,65,0', '6,65,0', '3,66,0', '4,66,0', '5,66,0', '6,66,0', '3,67,0', '4,67,0', '5,67,0', '6,67,0']);
  for (const stance of towerStances) {
    assert.ok(!banned.has(`${Math.floor(stance.pos.x)},${Math.floor(stance.pos.y)},${Math.floor(stance.pos.z)}`), `垫高站位 ${JSON.stringify(stance.pos)} 不能落在门框/门内`);
    assert.ok(stance.names.every((name) => ['dirt', 'cobblestone', 'netherrack', 'cobbled_deepslate'].includes(name)), `只使用原有施工材料：${stance.names.join(',')}`);
  }
  assert.ok(adapter.pos.y > 63, '垫高确实把身体升到需要的站立高度');
});

test('build_portal allowTower 缺脚手架时停下，保留已放置数量与目标事实', async (t) => {
  const { adapter, run } = setup();
  adapter.inv.set('obsidian', 10);
  adapter.inv.set('flint_and_steel', 1); // 没有脚手架：门框上段够不到时如实停下
  adapter.blocks.push({ name: 'obsidian', pos: { x: 4, y: 63, z: 0 } }, { name: 'obsidian', pos: { x: 5, y: 63, z: 0 } });
  const moveTo = adapter.moveTo.bind(adapter);
  t.mock.method(adapter, 'moveTo', async (target: Parameters<FakeAdapter['moveTo']>[0], opts: Parameters<FakeAdapter['moveTo']>[1]) => {
    if (target.kind === 'reach_block') return;
    if (target.kind === 'place_block') {
      if (target.pos.y > Math.floor(adapter.pos.y) + 1) throw new Error('PLACEMENT_NOT_REACHABLE');
      return;
    }
    return moveTo(target, opts);
  });
  const outcome = await run('build_portal', { origin: { x: 3, y: 63, z: 0 }, axis: 'x', allowTower: true });
  assert.equal(outcome.result.status, 'failed');
  assert.match(outcome.result.summary, /缺脚手架方块/);
  assert.ok((outcome.result.data?.placed as number) > 0, '保留已经实际放下的方块数');
  assert.ok(outcome.result.data?.target, '回报够不到的目标格');
});

test('build_portal allowTower 垫高被挡时停下并带回净空事实，不自行挖开', async (t) => {
  const { adapter, run } = setup();
  adapter.inv.set('obsidian', 10);
  adapter.inv.set('flint_and_steel', 1);
  adapter.inv.set('cobblestone', 4);
  const moveTo = adapter.moveTo.bind(adapter);
  t.mock.method(adapter, 'moveTo', async (target: Parameters<FakeAdapter['moveTo']>[0], opts: Parameters<FakeAdapter['moveTo']>[1]) => {
    if (target.kind === 'reach_block') return;
    if (target.kind === 'place_block') {
      if (target.pos.y > Math.floor(adapter.pos.y) + 1) throw new Error('PLACEMENT_NOT_REACHABLE');
      return;
    }
    return moveTo(target, opts);
  });
  t.mock.method(adapter, 'pillarUp', async () => ({
    ok: false, reason: 'NOT_PLACED:头顶跳跃空间受阻',
    clearanceDetail: '头顶跳跃空间受阻；要跳起来得先把这几格都挖空（方块名未确认）：(0,66,0)',
    clearance: { at: [0, 2, 0] as [number, number, number], facing: 'N' },
  }));
  const outcome = await run('build_portal', { origin: { x: 3, y: 63, z: 0 }, axis: 'x', allowTower: true });
  assert.equal(outcome.result.status, 'failed');
  assert.match(outcome.result.summary, /头顶跳跃空间受阻/);
  assert.match(outcome.result.summary, /\(0,66,0\)/, 'net clearance detail reaches the caller');
  assert.equal(outcome.result.data?.pillarFailure, 'NOT_PLACED:头顶跳跃空间受阻');
  assert.match(String(outcome.result.data?.clearanceDetail), /\(0,66,0\)/);
  assert.ok((outcome.result.data?.placed as number) > 0);
  assert.ok(!adapter.actions.some((a) => a.startsWith('dig:') && a.includes('stone')), '垫高受阻不额外挖方块');
});

test('build_portal allowTower 不会因为目标高就垫高：水平超出交互距离时直接回报缺口', async (t) => {
  const { adapter, run } = setup();
  adapter.pos = { x: 20.5, y: 64, z: 0.5 };
  adapter.inv.set('obsidian', 10);
  adapter.inv.set('flint_and_steel', 1);
  adapter.inv.set('cobblestone', 5);
  const moveTo = adapter.moveTo.bind(adapter);
  let pillars = 0;
  t.mock.method(adapter, 'moveTo', async (target: Parameters<FakeAdapter['moveTo']>[0], opts: Parameters<FakeAdapter['moveTo']>[1]) => {
    if (target.kind === 'reach_block') return;
    if (target.kind === 'place_block') {
      if (target.pos.y > Math.floor(adapter.pos.y) + 1) throw new Error('PLACEMENT_NOT_REACHABLE');
      return;
    }
    return moveTo(target, opts);
  });
  t.mock.method(adapter, 'pillarUp', async () => { pillars++; return { ok: true }; });
  const outcome = await run('build_portal', { origin: { x: 3, y: 63, z: 0 }, axis: 'x', allowTower: true });
  assert.equal(outcome.result.status, 'failed');
  assert.equal(pillars, 0, '水平距离超出交互范围时不能仅因目标高就垫高');
  assert.equal(adapter.inv.get('cobblestone'), 5, '没有消耗脚手架');
  assert.equal(outcome.result.data?.reason, 'OUT_OF_REACH');
  assert.ok((outcome.result.data?.horizontalDistance as number) > 4.5);
});

test('build_portal 不把悬空时的瞬时高度算成垫高', async (t) => {
  const { adapter, run } = setup();
  adapter.inv.set('obsidian', 10);
  adapter.inv.set('flint_and_steel', 1);
  adapter.inv.set('cobblestone', 5);
  const moveTo = adapter.moveTo.bind(adapter);
  let pillars = 0;
  t.mock.method(adapter, 'moveTo', async (target: Parameters<FakeAdapter['moveTo']>[0], opts: Parameters<FakeAdapter['moveTo']>[1]) => {
    if (target.kind === 'reach_block') return;
    if (target.kind === 'place_block') {
      if (target.pos.y > Math.floor(adapter.pos.y) + 1) throw new Error('PLACEMENT_NOT_REACHABLE');
      return;
    }
    return moveTo(target, opts);
  });
  t.mock.method(adapter, 'pillarUp', async (names: string[]) => {
    pillars++;
    const item = names.find((name) => (adapter.inv.get(name) ?? 0) > 0);
    if (item) adapter.inv.set(item, (adapter.inv.get(item) ?? 1) - 1);
    adapter.pos = { ...adapter.pos, y: adapter.pos.y + 1 };
    adapter.onGround = false; // 只有空中瞬时高度，没有站稳支撑
    return { ok: true, y: adapter.pos.y };
  });
  const outcome = await run('build_portal', { origin: { x: 3, y: 63, z: 0 }, axis: 'x', allowTower: true });
  assert.equal(outcome.result.status, 'failed');
  assert.equal(pillars, 1, '只尝试一次垫高');
  assert.equal(outcome.result.data?.confirmedRises, 0, '悬空高度不计入确认垫高');
  assert.match(outcome.result.summary, /仍悬空|没有站在实地/);
  assert.ok((outcome.result.data?.placed as number) > 0, '已放置方块数保留');
});

test('build_portal 在确认垫高后取消时保留部分实际事实', async (t) => {
  const adapter = new FakeAdapter();
  adapter.speed = 1000;
  adapter.inv.set('obsidian', 10);
  adapter.inv.set('flint_and_steel', 1);
  adapter.inv.set('cobblestone', 5);
  const memory = new WorldMemory(null);
  memory.setWorld(adapter.state().worldId);
  const controller = new AbortController();
  const moveTo = adapter.moveTo.bind(adapter);
  let pillars = 0;
  t.mock.method(adapter, 'moveTo', async (target: Parameters<FakeAdapter['moveTo']>[0], opts: Parameters<FakeAdapter['moveTo']>[1]) => {
    if (target.kind === 'reach_block') return;
    if (target.kind === 'place_block') {
      if (target.pos.y > Math.floor(adapter.pos.y) + 1) throw new Error('PLACEMENT_NOT_REACHABLE');
      return;
    }
    return moveTo(target, opts);
  });
  t.mock.method(adapter, 'pillarUp', async (names: string[]) => {
    pillars++;
    const item = names.find((name) => (adapter.inv.get(name) ?? 0) > 0);
    if (item) adapter.inv.set(item, (adapter.inv.get(item) ?? 1) - 1);
    adapter.pos = { ...adapter.pos, y: adapter.pos.y + 1 };
    adapter.onGround = true;
    controller.abort('task cancelled');
    return { ok: true, y: adapter.pos.y };
  });
  const ctx = {
    adapter, memory, signal: controller.signal, deadline: Date.now() + 60000, taskId: 'portal-abort', progress() {}, senses: {},
  } as unknown as SkillCtx;
  let caught: (Error & { partial?: Record<string, unknown> }) | undefined;
  try {
    await buildPortal.run(ctx, { origin: { x: 3, y: 63, z: 0 }, axis: 'x', allowTower: true });
  } catch (error) {
    caught = error as typeof caught;
  } finally {
    memory.close();
  }
  assert.ok(caught, '取消仍抛 AbortedError');
  assert.equal(caught.name, 'AbortedError');
  assert.equal(pillars, 1);
  assert.ok((caught.partial?.placed as number) > 0, '保留取消前已确认放置数');
  assert.equal(caught.partial?.confirmedRises, 1);
  assert.ok(((caught.partial?.position as { y: number }).y) > 64);
  assert.ok(caught.partial?.target, '保留最后放置目标');
  assert.deepEqual(caught.partial?.portal, { origin: { x: 3, y: 63, z: 0 }, axis: 'x' });
});

test('build_portal 未授权垫脚时不替 Agent 搭柱，够不到就报出那一格离脚多高', async (t) => {
  const { adapter, run } = setup();
  adapter.inv.set('obsidian', 10);
  adapter.inv.set('flint_and_steel', 1);
  adapter.inv.set('cobblestone', 4);
  const moveTo = adapter.moveTo.bind(adapter), pillarUp = adapter.pillarUp.bind(adapter);
  const pillars: string[][] = [];
  t.mock.method(adapter, 'pillarUp', async (names: string[], signal: AbortSignal) => {
    pillars.push([...names]);
    return pillarUp(names, signal);
  });
  t.mock.method(adapter, 'moveTo', async (target: Parameters<FakeAdapter['moveTo']>[0], opts: Parameters<FakeAdapter['moveTo']>[1]) => {
    assert.ok(!Object.hasOwn(opts, 'allowTower'), '未授权时不下发 allowTower');
    if (target.kind === 'place_block' && target.pos.y >= 66) throw new Error('PLACEMENT_NOT_REACHABLE');
    return moveTo(target, opts);
  });
  const outcome = await run('build_portal', { origin: { x: 3, y: 63, z: 0 }, axis: 'x' });
  assert.equal(outcome.result.status, 'failed');
  assert.match(outcome.result.summary, /PLACEMENT_NOT_REACHABLE.*比脚高 \d+ 格.*allowTower/);
  assert.equal(pillars.length, 0, '未授权时不执行显式垫高');
});

test('build_portal 补全上次的残框：角上留下的施工块不算占用，已摆的黑曜石原样复用', async () => {
  const { adapter, run } = setup();
  // 上次做到一半：底座、两根侧柱已摆，角上留着一块施工圆石
  for (const pos of [{ x: 4, y: 63, z: 0 }, { x: 5, y: 63, z: 0 }, ...[64, 65, 66].flatMap((y) => [{ x: 3, y, z: 0 }, { x: 6, y, z: 0 }])]) adapter.blocks.push({ name: 'obsidian', pos });
  adapter.blocks.push({ name: 'cobblestone', pos: { x: 3, y: 67, z: 0 } });
  adapter.inv.set('obsidian', 2);
  adapter.inv.set('flint_and_steel', 1);
  const outcome = await run('build_portal', { origin: { x: 3, y: 63, z: 0 }, axis: 'x' });
  assert.equal(outcome.result.status, 'succeeded', outcome.result.summary);
  assert.equal(adapter.inv.get('obsidian'), 0, '只补缺的 2 块');
});

test('build_portal 门内被挡：列出具体格子与已有黑曜石数，不叫 Agent 换地方或拆门框', async () => {
  const { adapter, run } = setup();
  adapter.blocks.push({ name: 'obsidian', pos: { x: 4, y: 63, z: 0 } });
  adapter.blocks.push({ name: 'netherrack', pos: { x: 5, y: 65, z: 0 } });
  adapter.inv.set('obsidian', 10);
  adapter.inv.set('flint_and_steel', 1);
  const outcome = await run('build_portal', { origin: { x: 3, y: 63, z: 0 }, axis: 'x' });
  assert.equal(outcome.result.status, 'failed');
  assert.match(outcome.result.summary, /已有 1\/10 块黑曜石/);
  assert.match(outcome.result.summary, /门内 \(5,65,0\) 是 netherrack/);
  assert.doesNotMatch(outcome.result.summary, /换一个|挖回来/);
});

test('a refused ignition cannot produce a successful portal record', async () => {
  const { adapter, memory, run } = setup();
  adapter.inv.set('obsidian', 10);
  adapter.inv.set('flint_and_steel', 1);
  adapter.useBlockAt = async () => ({ ok: false, reason: 'NO_FIRE' });
  const outcome = await run('build_portal', { origin: { x: 3, y: 63, z: 0 } });
  assert.equal(outcome.result.status, 'failed');
  assert.deepEqual(travelStore(memory).snapshot(adapter.worldId).endpoints, []);
});

test('build_portal on a suspended base fills the gap with scaffold first', async () => {
  const { adapter, run } = setup();
  adapter.inv.set('obsidian', 10);
  adapter.inv.set('flint_and_steel', 1);
  adapter.inv.set('cobblestone', 20);
  // 底座中间两列下方挖空（斜坡悬空），应先用脚手架垫平再立框
  adapter.removed.add('4,62,0');
  adapter.removed.add('5,62,0');
  const outcome = await run('build_portal', { origin: { x: 3, y: 63, z: 0 }, axis: 'x' });
  assert.equal(outcome.result.status, 'succeeded', outcome.result.summary);
  assert.equal(adapter.blockAt({ x: 4, y: 62, z: 0 }), 'cobblestone', '底座悬空处被脚手架填上');
  assert.equal(adapter.blockAt({ x: 5, y: 62, z: 0 }), 'cobblestone');
});

test('a refused ignition still leaves a resumable partial-frame landmark', async () => {
  const { adapter, memory, run } = setup();
  adapter.inv.set('obsidian', 10);
  adapter.inv.set('flint_and_steel', 1);
  adapter.useBlockAt = async () => ({ ok: false, reason: 'NO_FIRE' });
  const outcome = await run('build_portal', { origin: { x: 3, y: 63, z: 0 } });
  assert.equal(outcome.result.status, 'failed');
  const partial = memory.landmarks().filter((l) => l.label === '未完成的下界门框（axis=x）');
  assert.equal(partial.length, 1, '点火失败仍留下未完成门框地标，可回来补全');
  assert.deepEqual(partial[0].pos, { x: 3, y: 63, z: 0 });
});

test('successful ignition clears the partial-frame landmark', async () => {
  const { adapter, memory, run } = setup();
  adapter.inv.set('obsidian', 10);
  adapter.inv.set('flint_and_steel', 1);
  const outcome = await run('build_portal', { origin: { x: 3, y: 63, z: 0 } });
  assert.equal(outcome.result.status, 'succeeded', outcome.result.summary);
  assert.equal(memory.landmarks().filter((l) => l.label === '未完成的下界门框（axis=x）').length, 0, '点着后清掉未完成地标');
});

test('a partial frame is recorded even when obsidian is insufficient to finish', async () => {
  const { adapter, memory, run } = setup();
  adapter.inv.set('flint_and_steel', 1);
  // 预摆两块黑曜石（部分门框），背包 0 块：缺料也要记下门框位置，便于回来补全
  adapter.blocks.push({ name: 'obsidian', pos: { x: 4, y: 63, z: 0 } });
  adapter.blocks.push({ name: 'obsidian', pos: { x: 5, y: 63, z: 0 } });
  const outcome = await run('build_portal', { origin: { x: 3, y: 63, z: 0 } });
  assert.equal(outcome.result.status, 'failed');
  assert.equal(outcome.result.failureCode, 'MISSING_MATERIALS');
  const partial = memory.landmarks().filter((l) => l.label === '未完成的下界门框（axis=x）');
  assert.equal(partial.length, 1, '缺料也记下部分门框');
  assert.deepEqual(partial[0].pos, { x: 3, y: 63, z: 0 });
});

test('portal travel records observed coordinates in both dimensions and verifies a return only after returning', async () => {
  const { adapter, memory, vision, run } = setup();
  const sourcePos = { x: 3, y: 64, z: 0 };
  const destinationPos = { x: 71, y: 55, z: -33 }; // deliberately unrelated to coordinate scaling
  adapter.blocks.push({ name: 'nether_portal', pos: sourcePos });
  adapter.portalDestinations.set('fake-world:overworld:3,64,0', { dim: 'the_nether', pos: destinationPos });
  adapter.portalDestinations.set('fake-world:the_nether:71,55,-33', { dim: 'overworld', pos: sourcePos });
  const source = travelStore(memory).observe(adapter.state(), sourcePos, 'nether_portal');
  const outbound = await run('travel_portal', { portalId: source.id });
  assert.equal(outbound.result.status, 'succeeded', outbound.result.summary);
  const first = travelStore(memory).snapshot(adapter.worldId);
  assert.equal(first.routes.length, 1);
  assert.equal(first.routes[0].returnVerified, false);
  const destination = first.endpoints.find((e) => e.dim === 'the_nether')!;
  assert.deepEqual(destination.pos, destinationPos);
  assert.equal(destination.portalObserved, false, 'arrival inside a portal is not a fresh sight line to it');
  adapter.groundY = destinationPos.y - 1;
  adapter.pos = { ...destinationPos, x: destinationPos.x - 3 };
  await adapter.look(-Math.PI / 2, -0.3);
  vision.scan();
  assert.equal(vision.observeBlocks([destinationPos])[0]?.name, 'nether_portal');
  assert.equal((await run('observe_portal')).result.status, 'succeeded');
  assert.equal(travelStore(memory).get(destination.id, adapter.worldId)?.portalObserved, true);
  assert.ok(memory.landmarks().some((l) => l.label.includes('下界门') && l.dim === 'the_nether'), '观察到的下界门也记进常规地标');
  const returned = await run('recall_portal', { returnId: destination.id });
  assert.equal(returned.result.status, 'succeeded', returned.result.summary);
  assert.equal(adapter.dim, 'overworld');
  const final = travelStore(memory).snapshot(adapter.worldId);
  assert.equal(final.routes.length, 2);
  assert.ok(final.routes.every((r) => r.returnVerified));
});

test('travel_portal 接受 nearest/auto：只在当前维度已观察的门里按距离选，并回报解析后的 id', async () => {
  const { adapter, memory, run } = setup();
  const near = { x: 3, y: 64, z: 0 };
  const far = { x: 30, y: 64, z: 0 };
  adapter.pos = { x: 4, y: 64, z: 0.5 };
  adapter.blocks.push({ name: 'nether_portal', pos: near }, { name: 'nether_portal', pos: far });
  adapter.portalDestinations.set('fake-world:overworld:3,64,0', { dim: 'the_nether', pos: { x: 71, y: 55, z: -33 } });
  const store = travelStore(memory);
  const a = store.observe(adapter.state(), near, 'nether_portal');
  store.observe(adapter.state(), far, 'nether_portal');
  const outcome = await run('travel_portal', { portalId: 'nearest' });
  assert.equal(outcome.result.status, 'succeeded', outcome.result.summary);
  assert.equal(adapter.dim, 'the_nether');
  assert.match(outcome.result.summary, new RegExp(`按 nearest 选择 ${a.id}`));
  assert.equal((outcome.result.data as any)?.requestedPortalId, 'nearest');
  assert.equal((outcome.result.data as any)?.resolvedPortalId, a.id);
});

test('travel_portal auto 在当前维度没有已观察门时明确失败，不跨维猜门', async () => {
  const { adapter, memory, run } = setup();
  const overworldPortal = { x: 3, y: 64, z: 0 };
  adapter.blocks.push({ name: 'nether_portal', pos: overworldPortal });
  travelStore(memory).observe(adapter.state(), overworldPortal, 'nether_portal');
  adapter.dim = 'the_nether';
  adapter.pos = { x: 0, y: 64, z: 0 };
  const outcome = await run('travel_portal', { portalId: 'auto' });
  assert.equal(outcome.result.status, 'failed');
  assert.equal(outcome.result.failureCode, 'NOT_FOUND');
  assert.match(outcome.result.summary, /当前维度 the_nether 没有已观察的可用传送门/);
});

test('already inside a portal: timeout carries the in-portal timeline', async () => {
  const { adapter, memory, run } = setup();
  const sourcePos = { x: 3, y: 64, z: 0 };
  adapter.blocks.push({ name: 'nether_portal', pos: sourcePos }, { name: 'nether_portal', pos: { x: 3, y: 65, z: 0 } });
  adapter.blocks.push({ name: 'obsidian', pos: { x: 3, y: 63, z: 0 } });
  adapter.portalDestinations.set('fake-world:overworld:3,64,0', { dim: 'the_nether', pos: { x: 8, y: 64, z: 0 } });
  adapter.pos = { x: 3.5, y: 64, z: 0.5 };
  adapter.bodyPortal = 'nether_portal';
  adapter.portalNeedsExit = true;
  adapter.portalInsideMs = 30000;
  const source = travelStore(memory).observe(adapter.state(), sourcePos, 'nether_portal');
  const outcome = await run('travel_portal', { portalId: source.id });
  assert.equal(outcome.result.status, 'failed');
  assert.equal(outcome.result.failureCode, 'ERROR');
  assert.match(outcome.result.summary, /开始时身体已在门方块里/);
  assert.match(outcome.result.summary, /在门方块里连续 30\.0s/);
  assert.match(outcome.result.summary, /维度 overworld/);
  assert.equal(adapter.dim, 'overworld', '没有实际换维度，不能改状态');
});

test('End arrival without a portal does not invent a usable return route', async () => {
  const { adapter, memory, run } = setup();
  const source = { x: 3, y: 64, z: 0 };
  adapter.blocks.push({ name: 'end_portal', pos: source });
  adapter.portalDestinations.set('fake-world:overworld:3,64,0', { dim: 'the_end', pos: { x: 100, y: 49, z: 0 }, arrivalPortal: false });
  const endpoint = travelStore(memory).observe(adapter.state(), source, 'end_portal');
  assert.equal((await run('travel_portal', { portalId: endpoint.id })).result.status, 'succeeded');
  const arrival = travelStore(memory).snapshot(adapter.worldId).endpoints.find((e) => e.dim === 'the_end')!;
  assert.equal(arrival.portalObserved, false);
  const returned = await run('recall_portal', { returnId: arrival.id });
  assert.equal(returned.result.failureCode, 'NOT_FOUND');
});

test('cancelled portal entry never persists a transition and wrong-dimension IDs never move', async () => {
  const { adapter, memory, arbiter, run } = setup();
  const sourcePos = { x: 3, y: 64, z: 0 };
  adapter.blocks.push({ name: 'nether_portal', pos: sourcePos });
  adapter.portalDestinations.set('fake-world:overworld:3,64,0', { dim: 'the_nether', pos: { x: 8, y: 64, z: 0 } });
  const source = travelStore(memory).observe(adapter.state(), sourcePos, 'nether_portal');
  adapter.speed = 1;
  const pending = run('travel_portal', { portalId: source.id });
  await sleep(10);
  arbiter.setPaused(true);
  assert.equal((await pending).result.status, 'cancelled');
  assert.equal(adapter.dim, 'overworld');
  assert.deepEqual(travelStore(memory).snapshot(adapter.worldId).routes, []);
  arbiter.setPaused(false);
  adapter.dim = 'the_nether';
  const actions = adapter.actions.length;
  assert.equal((await run('travel_portal', { portalId: source.id })).result.failureCode, 'WRONG_DIMENSION');
  assert.equal(adapter.actions.length, actions);
});

test('portal store keeps actual two-end evidence and isolates other servers', () => {
  const { adapter, memory } = setup();
  const store = travelStore(memory);
  const from = adapter.state();
  const a = store.observe(from, { x: 1, y: 64, z: 0 }, 'nether_portal');
  adapter.dim = 'the_nether'; adapter.sessionId = 'second-session';
  const to = adapter.state();
  const b = store.observe(to, { x: 70, y: 40, z: -11 }, 'nether_portal');
  store.record(a.id, b.id, from, to);
  const restored = travelStore(memory);
  assert.equal(restored.snapshot('fake-world').routes.length, 1);
  assert.deepEqual(restored.snapshot('unrelated-world'), { endpoints: [], routes: [], gateways: [] });
  assert.throws(() => store.record(a.id, b.id, from, { ...to, observationReady: false }), /Unverified/);
});

test('missing existing End frames fail without crafting or manufacturing frames', async () => {
  const { adapter, run } = setup();
  adapter.inv.set('ender_eye', 12);
  assert.equal((await run('activate_end_portal')).result.failureCode, 'NOT_FOUND');
  assert.deepEqual(adapter.actions, []);
});

test('equip_armor confirms real slots and ranged_defend spends arrows without claiming a kill', async () => {
  const { adapter, vision, run } = setup();
  adapter.inv.set('iron_helmet', 1);
  adapter.inv.set('diamond_chestplate', 1);
  adapter.inv.set('shield', 1);
  const equipment = await run('equip_armor');
  assert.equal(equipment.result.status, 'succeeded');
  assert.equal(adapter.equipped.get('head'), 'iron_helmet');
  assert.equal(adapter.equipped.get('torso'), 'diamond_chestplate');
  assert.equal(adapter.equipped.get('off-hand'), 'shield');
  adapter.inv.set('bow', 1); adapter.inv.set('arrow', 3);
  adapter.entities.push({ id: 12, name: 'skeleton', kind: 'hostile', pos: { x: 12, y: 64, z: 0 }, dist: 12 });
  vision.scan();
  const ranged = await run('ranged_defend', { entityId: 12, shots: 2 });
  assert.equal(ranged.result.status, 'succeeded', ranged.result.summary);
  assert.equal(adapter.inv.get('arrow'), 1);
  assert.equal(ranged.result.data?.defeatVerified, false);
});

test('End gateway records actual same-session displacement and only verifies return after a second teleport', async () => {
  const { adapter, memory, vision, run } = setup();
  adapter.dim = 'the_end'; adapter.inv.set('ender_pearl', 2);
  const sourcePos = { x: 3, y: 64, z: 0 }, outerPos = { x: 1011, y: 74, z: -202 };
  adapter.blocks.push({ name: 'end_gateway', pos: sourcePos }, { name: 'end_gateway', pos: outerPos });
  for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) adapter.blocks.push({ name: 'end_stone', pos: { x: outerPos.x + dx, y: outerPos.y - 1, z: outerPos.z + dz } });
  const source = travelStore(memory).observe(adapter.state(), sourcePos, 'end_gateway');
  adapter.useItem = async (item) => {
    adapter.actions.push(`use:${item}`);
    adapter.inv.set(item, (adapter.inv.get(item) ?? 0) - 1);
    adapter.pos = adapter.pos.x < 100 ? { ...outerPos } : { ...sourcePos };
    return { ok: true };
  };
  const outbound = await run('use_end_gateway', { portalId: source.id });
  assert.equal(outbound.result.status, 'succeeded', outbound.result.summary);
  const first = travelStore(memory).snapshot(adapter.worldId);
  assert.equal(first.gateways.length, 1);
  assert.equal(first.gateways[0].returnVerified, false);
  const destination = first.endpoints.find((e) => e.pos.x > 100)!;
  assert.deepEqual(destination.pos, outerPos);
  adapter.pos = { ...outerPos, x: outerPos.x - 3 };
  await adapter.look(-Math.PI / 2, -0.3);
  vision.scan();
  assert.equal(vision.observeBlocks([outerPos])[0]?.name, 'end_gateway');
  assert.equal((await run('observe_portal')).result.status, 'succeeded');
  assert.equal((await run('use_end_gateway', { portalId: destination.id })).result.status, 'succeeded');
  assert.ok(travelStore(memory).snapshot(adapter.worldId).gateways.every((r) => r.returnVerified));
  assert.equal(adapter.inv.get('ender_pearl'), 0);
});

test('travel cancellation keeps the measured partial position, request, resolved target and backend', async (t) => {
  const a = new TestWorld();
  a.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = makeCtx(a);
  t.after(() => ctx.memory.close());
  t.mock.method(a, 'moveTo', async () => {
    a.pos = { x: 2.5, y: 64, z: 0.5 };
    throw new AbortedError('task cancelled');
  });
  let caught: (Error & { partial?: { nav: Record<string, unknown>; originalRequest: unknown; backend: string } }) | undefined;
  try { await travel.run(ctx, { to: '10,64,0' }); } catch (e) { caught = e as typeof caught; }
  assert.ok(caught, '取消仍保留 AbortedError 语义');
  const partial = caught.partial!;
  assert.equal(partial.nav.outcome, 'CANCELLED');
  assert.equal(partial.nav.confirmed, false);
  assert.deepEqual(partial.nav.lastPosition, { x: 2.5, y: 64, z: 0.5 });
  assert.deepEqual(partial.nav.resolvedTarget, { x: 10, y: 64, z: 0 });
  assert.deepEqual(partial.originalRequest, { to: '10,64,0' });
  assert.equal(partial.nav.backend, 'land_water_plan');
  assert.ok((partial.nav.trace as unknown[]).length >= 2);
});

test('travel does not substitute same-XZ/different-Y for a three-dimensional target', async (t) => {
  const a = new TestWorld();
  a.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = makeCtx(a);
  t.after(() => ctx.memory.close());
  const result = await travel.run(ctx, { to: '0,60,0' });
  assert.equal(result.status, 'failed', result.summary);
  assert.match(result.summary, /目标高度 60/);
  assert.equal(result.data?.arrived, false);
  assert.equal((result.data?.arrival as { satisfied: boolean }).satisfied, false);
  assert.equal((result.data?.nav as { outcome: string }).outcome, 'NO_PATH');
  assert.deepEqual(result.data?.resolvedTarget, { x: 0, y: 60, z: 0 }, '原三维目标不被水平接近替换');
});

test('a pearl use without observed teleport cannot become an outer-island success', async () => {
  const { adapter, memory, bus, vision } = setup();
  adapter.dim = 'the_end'; adapter.inv.set('ender_pearl', 1);
  const pos = { x: 3, y: 64, z: 0 };
  adapter.blocks.push({ name: 'end_gateway', pos });
  const endpoint = travelStore(memory).observe(adapter.state(), pos, 'end_gateway');
  const result = await useEndGateway.run({ adapter, memory, bus, senses: vision, signal: new AbortController().signal, deadline: Date.now() + 350, taskId: 'gateway-timeout', progress() {} }, { portalId: endpoint.id });
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'TIMEOUT');
  assert.deepEqual(travelStore(memory).snapshot(adapter.worldId).gateways, []);
});

test('observe_portal can record a portal directly above the body, not only within ±1', async (t) => {
  const w = new TestWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  const portal = { x: 0, y: 66, z: 0 };
  w.setBlock(portal, 'nether_portal');
  const ctx = makeCtx(w, { senses: { observeBlocks: (positions) => positions
    .filter((p) => p.x === portal.x && p.y === portal.y && p.z === portal.z)
    .map((pos) => ({ name: 'nether_portal', pos, properties: {}, worldId: w.worldId, sessionId: w.sessionId,
      dimension: w.dim, observationId: 1, observedAt: Date.now(), source: 'vision' as const })) } });
  ctx.memory.setWorld(w.worldId);
  t.after(() => ctx.memory.close());
  const r = await travelSkills.observe_portal.run(ctx, {});
  assert.equal(r.status, 'succeeded', r.summary);
  assert.deepEqual(travelStore(ctx.memory).get(r.data?.portalId as string, w.worldId)?.pos, portal);
});

test('travel_portal timeout while confirmed inside names cooldown/latency instead of only a timeout code', async (t) => {
  const w = new TestWorld();
  w.dim = 'the_nether';
  w.pos = { x: 3.5, y: 64, z: 0.5 };
  const portal = { x: 3, y: 64, z: 0 };
  w.setBlock(portal, 'nether_portal');
  const ctx = makeCtx(w);
  ctx.memory.setWorld(w.worldId);
  t.after(() => ctx.memory.close());
  const endpoint = travelStore(ctx.memory).observe(w.state(), portal, 'nether_portal');
  w.enterPortalAt = (async () => ({
    ok: false, reason: 'PORTAL_TRANSITION_TIMEOUT', from: w.state(), to: null,
    transition: { startedInPortal: true, entered: true, exitMs: 500, outsideMs: 400, insideMs: 30196, endDim: 'the_nether' },
  })) as any;
  const r = await travelSkills.travel_portal.run(ctx, { portalId: endpoint.id });
  assert.equal(r.status, 'failed');
  assert.match(r.summary, /传送冷却|服务器延迟|对端未就绪/);
  assert.match(r.summary, /不要连续重进/);
});

test('快速往返：反向穿越在十分钟内时如实写进传送回执', async (t) => {
  const w = new TestWorld();
  w.dim = 'the_nether';
  w.sessionId = 'nether-session';
  w.pos = { x: 3.5, y: 64, z: 0.5 };
  const portal = { x: 3, y: 64, z: 0 };
  w.setBlock(portal, 'nether_portal');
  const ctx = makeCtx(w);
  ctx.memory.setWorld(w.worldId);
  t.after(() => ctx.memory.close());
  const store = travelStore(ctx.memory);
  const nether = w.state();
  const over = { ...nether, dim: 'overworld', sessionId: 'overworld-session', pos: { x: 0.5, y: 64, z: 0.5 }, observationId: nether.observationId + 1 };
  const a = store.observe(over, { x: 0, y: 64, z: 0 }, 'nether_portal');
  const b = store.observe(nether, portal, 'nether_portal');
  store.record(a.id, b.id, over, nether);
  const back = { ...over, sessionId: 'overworld-session-2', observationId: over.observationId + 1 };
  w.enterPortalAt = (async () => ({
    ok: true, from: nether, to: back, stand: back, leftPortal: true,
    transition: { startedInPortal: false, entered: true, exitMs: null, outsideMs: null, insideMs: 1500, endDim: 'overworld' },
  })) as any;
  const r = await travelSkills.travel_portal.run(ctx, { portalId: b.id });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.match(r.summary, /快速往返/);
  assert.ok(r.data?.quickReturn);
});

test('stale portal endpoint reports the actual block and record age, not a frame guess', async () => {
  const { adapter, memory, run } = setup();
  const endpoint = travelStore(memory).observe(adapter.state(), { x: 3, y: 64, z: 0 }, 'nether_portal');
  const outcome = await run('travel_portal', { portalId: endpoint.id });
  assert.equal(outcome.result.status, 'failed');
  assert.equal(outcome.result.failureCode, 'NOT_FOUND');
  assert.match(outcome.result.summary, /门方块现在的实际方块是 air/);
  assert.match(outcome.result.summary, /记录于/);
  assert.doesNotMatch(outcome.result.summary, /黑曜石框/);
  assert.equal(outcome.result.data?.actual, 'air');

  const missing = await run('travel_portal', { portalId: 'portal_missing' });
  assert.match(missing.result.summary, /门方块曾实际观察到/);
  assert.match(missing.result.summary, /记录于/);
});

test('observe_portal 记得附近有门但不在视野里：朝它转头再用本次视野核对；看不到就如实报', async (t) => {
  const w = new TestWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  const portal = { x: 0, y: 64, z: -3 };
  w.setBlock(portal, 'nether_portal');
  // 只有转头面向北（门的方向）之后，视觉才看得见门方块。
  const facingPortal = () => Math.abs(w.yaw) < 0.6;
  const ctx = makeCtx(w, { senses: {
    knownBlocks: (names) => names.includes('nether_portal') ? [{ name: 'nether_portal', pos: portal, dist: 3 }] : [],
    observeBlocks: (positions) => facingPortal() ? positions
      .filter((p) => p.x === portal.x && p.y === portal.y && p.z === portal.z)
      .map((pos) => ({ name: 'nether_portal', pos, properties: {}, worldId: w.worldId, sessionId: w.sessionId,
        dimension: w.dim, observationId: 1, observedAt: Date.now(), source: 'vision' as const })) : [] } });
  ctx.memory.setWorld(w.worldId);
  t.after(() => ctx.memory.close());
  w.yaw = Math.PI; // 背对门
  const r = await travelSkills.observe_portal.run(ctx, {});
  assert.equal(r.status, 'succeeded', r.summary);
  assert.deepEqual(travelStore(ctx.memory).get(r.data?.portalId as string, w.worldId)?.pos, portal);

  const blind = makeCtx(w, { senses: { knownBlocks: () => [{ name: 'nether_portal', pos: portal, dist: 3 }], observeBlocks: () => [] } });
  blind.memory.setWorld(w.worldId);
  t.after(() => blind.memory.close());
  const miss = await travelSkills.observe_portal.run(blind, {});
  assert.equal(miss.failureCode, 'NOT_FOUND');
  assert.equal(miss.data?.turned, 1);
  assert.match(miss.summary, /转头看了 1 处/);
});
