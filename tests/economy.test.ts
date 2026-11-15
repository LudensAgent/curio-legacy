import { expedition, storeItems } from '../src/skills/economy.ts';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { VoxelMap } from 'curio-minecraft-3d-memory';
import type { Vec3Like } from '../src/adapter/types.ts';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { habitName, learnCandidates, signatureOf } from '../src/brain/habits.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import type { Percept } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { ruleProposal } from '../src/planner/plan.ts';
import { clearMovementSessions } from '../src/skills/movement/session.ts';
import { pickVariant, resolveItemAlias } from '../src/skills/work.ts';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const runSkill = async (adapter: FakeAdapter, skill: string, args: unknown, memory = new WorldMemory(null)) => {
  const vision = new Vision(adapter);
  const arbiter = new Arbiter(adapter, memory, new EventBus(), vision);
  const done = new Promise<TaskOutcome>((r) => arbiter.once('done', r));
  arbiter.start({ skill, args }, 'llm');
  return { o: await done, memory, vision };
};

const P = (over: Partial<Percept> = {}): Percept => ({
  ts: 0, connected: true, time: { timeOfDay: 1000, phase: 'day' },
  self: { pos: [0, 64, 0], dim: 'overworld', hp: 20, food: 20, biome: 'plains', inWater: false, inLava: false, held: null },
  inventory: [{ name: 'stone_pickaxe', count: 1 }], emptySlots: 30,
  nearby: { hostile: [], passive: [], players: [], resources: [] },
  vision: { facing: 'N', fov: 100, range: 160, view: 'grass 60%', openness: { left: 64, center: 64, right: 64 }, visible_resources: [], remembered_resources: [], seen_entities: [], heard: [], nearest_land: null, last_look_around_s: 10 },
  death_recovery: null, curiosities: [], objective: null, drives: [], stock: null, efficiency: [], light: null, storage: null, farms: [], learn_candidates: [], reflection_due: false,
  exploration: { visitedChunks: 3, noveltyByDir: { N: 0.5, NE: 0.5, E: 1, SE: 0.5, S: 0.5, SW: 0.5, W: 0.5, NW: 0.5 }, base: null },
  ...over,
});

const WORLD = 'fake-world', DIM = 'overworld', SESSION = 'fake-session';
let sequence = 0;

function fillMap(map: VoxelMap, name: string, cells: Vec3Like[]) {
  for (const pos of cells) {
    sequence += 1;
    map.observe({
      worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: Date.now(), sequence,
      source: 'vision', evidence: 'seen', stateComplete: true,
      state: { name, properties: {} }, pos,
    });
  }
}

/** 一条沿 +X 的已观测走廊：z∈[-1,1]，y=63 地面、y=64..66 空气。 */
function expeditionCorridor(maxX: number) {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  const air: Vec3Like[] = [], ground: Vec3Like[] = [];
  for (let x = -1; x <= maxX; x++) for (let z = -1; z <= 1; z++) {
    for (let y = 64; y <= 66; y++) air.push({ x, y, z });
    ground.push({ x, y: 63, z });
  }
  fillMap(map, 'minecraft:air', air);
  fillMap(map, 'minecraft:grass_block', ground);
  return map;
}

function fakeSpatial(map: VoxelMap) {
  return {
    worldId: WORLD,
    session: { voxel: map, history: { worldId: WORLD, getFragment: () => null, fragments: () => ({ items: [], total: 0 }) } },
    closing: false, paused: false, observationAdmitted: true,
    capabilities: () => ({
      owner: 'host_composed', contract: 'memory-host-contract/2',
      library: {}, host: { execute: { walk: true, groundedArrival: true, invalidation: true, cancellation: true } },
      effective: { execute: { walk: true, groundedArrival: true, invalidation: true, cancellation: true } },
      overclaims: [],
    }),
  } as unknown as SharedSpatialSession;
}


test('近处矿点看不到不等于消失：gather 失败，保留尚未重新确认的历史线索', async (t) => {
  const a = new FakeAdapter();
  const memory = new WorldMemory(null);
  t.after(() => memory.close()); memory.setWorld(a.state().worldId);
  const landmark = memory.addLandmark('resource', 'iron_ore', 'overworld', { x: 2, y: 63, z: 2 });
  assert.ok(landmark);
  const { o } = await runSkill(a, 'gather', { block: 'iron_ore', count: 2 }, memory);
  assert.equal(o.result.failureCode, 'NOT_FOUND');
  assert.match(o.result.summary, /历史 iron_ore 地点尚未重新确认，保留线索/);
  assert.deepEqual(memory.landmarks().filter((l) => l.kind === 'resource').map((l) => l.id), [landmark.id]);
  assert.doesNotMatch(o.result.summary, /删掉|已经消失|资源已经没了/);
});

test('远一点、埋在石头里的矿点看不见不删：留着，并在失败结果里说出在哪', async () => {
  const a = new FakeAdapter();
  const memory = new WorldMemory(null);
  memory.setWorld(a.state().worldId);
  memory.addLandmark('resource', 'iron_ore', 'overworld', { x: 3, y: 56, z: 2 });
  const { o } = await runSkill(a, 'gather', { block: 'iron_ore', count: 2 }, memory);
  assert.equal(o.result.failureCode, 'NOT_FOUND');
  assert.match(o.result.summary, /记得别处有 iron_ore：\(3,56,2\)/);
  assert.equal(memory.landmarks().filter((l) => l.kind === 'resource').length, 1);
});

test('物品泛称：bed → white_bed、planks → oak_planks；按背包材料挑颜色/木种', () => {
  const known = new Set(['white_bed', 'red_bed', 'oak_planks', 'spruce_planks', 'torch']);
  const ad = { isKnownItem: (n: string) => known.has(n) };
  assert.equal(resolveItemAlias('bed', ad), 'white_bed');
  assert.equal(resolveItemAlias('planks', ad), 'oak_planks');
  assert.equal(resolveItemAlias('torches', ad), 'torch');
  assert.equal(resolveItemAlias('nonsense', ad), null);
  assert.equal(pickVariant('white_bed', [{ name: 'red_wool', count: 3 }]), 'red_bed');
  assert.equal(pickVariant('white_bed', [{ name: 'white_wool', count: 3 }]), 'white_bed');
  assert.equal(pickVariant('oak_planks', [{ name: 'spruce_log', count: 4 }]), 'spruce_planks');
});

test('冶炼：生铁 + 煤 → 铁锭', async () => {
  const a = new FakeAdapter();
  a.inv.set('raw_iron', 3);
  a.inv.set('coal', 2);
  a.inv.set('cobblestone', 8);
  const { o } = await runSkill(a, 'smelt', { item: 'raw_iron' });
  assert.equal(o.result.status, 'succeeded', o.result.summary);
  assert.equal(a.inv.get('iron_ingot'), 3);
});

test('仓储：存进箱子（工具留身上），再取出来', async () => {
  const a = new FakeAdapter();
  a.inv.set('chest', 1);
  a.inv.set('stone_pickaxe', 1);
  a.inv.set('dirt', 40);
  a.inv.set('raw_copper', 9);
  const memory = new WorldMemory(null);
  memory.setWorld(a.state().worldId);
  const target = { x: 2, y: 64, z: 0 };
  a.blocks.push({ name: 'chest', pos: target });
  a.chests.set('2,64,0', new Map());
  let r = await runSkill(a, 'store_items', { items: ['dirt:24', 'raw_copper'], target }, memory);
  assert.equal(r.o.result.status, 'succeeded', JSON.stringify(r.o.result));
  assert.equal(a.inv.get('dirt'), 16, '只存点名的 24 个泥土');
  assert.equal(a.inv.get('raw_copper'), 0);
  assert.equal(a.inv.get('stone_pickaxe'), 1, '未点名的工具留身上');
  assert.equal(a.inv.get('chest'), 1, '没有自动放置背包里的箱子');
  assert.equal(memory.chests().length, 1);
  r = await runSkill(a, 'take_items', { item: 'raw_copper', count: 4, target }, memory);
  assert.equal(r.o.result.status, 'succeeded', r.o.result.summary);
  assert.equal(a.inv.get('raw_copper'), 4);
});

test('take_items 指到熔炉：不当作消失的箱子，明确指向 collect_furnace', async (t) => {
  const a = new FakeAdapter(), memory = new WorldMemory(null);
  t.after(() => memory.close());
  memory.setWorld(a.state().worldId);
  const target = { x: 2, y: 64, z: 0 };
  a.blocks.push({ name: 'furnace', pos: target });
  const { o } = await runSkill(a, 'take_items', { item: 'iron_ingot', count: 1, target }, memory);
  assert.equal(o.result.status, 'failed');
  assert.equal(o.result.failureCode, 'BAD_ARGS');
  assert.match(o.result.summary, /collect_furnace/);
  assert.match(o.result.summary, /不是箱子/);
  assert.doesNotMatch(o.result.summary, /忘掉已失效的容器记忆/);
  assert.equal(a.actions.length, 0, '没有把熔炉当箱子打开或移动到别处');
});

test('目标容器不可见时给出具体 go_near，并说明没有改选目标', async (t) => {
  const a = new FakeAdapter(), memory = new WorldMemory(null);
  t.after(() => memory.close());
  memory.setWorld(a.state().worldId);
  const target = { x: 200, y: 64, z: 0 };
  const { o } = await runSkill(a, 'take_items', { item: 'iron_ingot', count: 1, target }, memory);
  assert.equal(o.result.status, 'failed');
  assert.equal(o.result.failureCode, 'NOT_FOUND');
  assert.match(o.result.summary, /go_near \{"target":\{"x":200,"y":64,"z":0\}\}/);
  assert.match(o.result.summary, /目标坐标没有改变/);
  assert.match(o.result.summary, /再取/);
  assert.match(o.result.summary, /take_items 不会自己走过去/);
  assert.match(o.result.summary, /可能需要分几次/);
  assert.equal(memory.chests().length, 0, '没有改选其他容器');
  assert.equal(a.actions.length, 0, '没有自动移动或换箱');

  const near = new FakeAdapter(), nearMemory = new WorldMemory(null);
  t.after(() => nearMemory.close());
  nearMemory.setWorld(near.state().worldId);
  const hidden = { x: 2, y: 64, z: 0 };
  near.blocks.push({ name: 'chest', pos: hidden }, { name: 'stone', pos: { x: 1, y: 64, z: 0 } }, { name: 'stone', pos: { x: 1, y: 65, z: 0 } });
  const blocked = await runSkill(near, 'store_items', { items: ['dirt:1'], target: hidden }, nearMemory);
  assert.equal(blocked.o.result.status, 'failed');
  assert.equal(blocked.o.result.failureCode, 'NOT_FOUND');
  assert.match(blocked.o.result.summary, /go_near \{"target":\{"x":2,"y":64,"z":0\}\}/);
  assert.match(blocked.o.result.summary, /当前视线\/站位不满足/);
  assert.match(blocked.o.result.summary, /再存/);
});

test('农业：开垦并播种；成熟后收割补种', async () => {
  const a = new FakeAdapter();
  a.inv.set('wooden_hoe', 1);
  a.inv.set('wheat_seeds', 9);
  const memory = new WorldMemory(null);
  let r = await runSkill(a, 'farm', { crop: 'wheat', size: 4 }, memory);
  assert.equal(r.o.result.status, 'succeeded', r.o.result.summary);
  assert.equal(memory.farms().length, 1);
  const n = memory.farms()[0].cells.length;
  assert.ok(n >= 2);
  assert.equal(a.crops.size, n);
  for (const c of a.crops.values()) c.age = 7;
  r = await runSkill(a, 'farm', { crop: 'wheat' }, memory);
  assert.match(r.o.result.summary, new RegExp(`收割 ${n}`));
});

test('规则目标：背包快满 → 存箱子；有生铁和圆石 → 冶炼', () => {
  const m = new WorldMemory(null);
  const full = ruleProposal(P({ emptySlots: 1 }), m) as any;
  assert.notEqual(full?.steps?.[0]?.skill, 'store_items', '存哪些得它自己点名，规则兜底不替它挑');
  const p = P();
  p.inventory.push({ name: 'raw_iron', count: 4 }, { name: 'cobblestone', count: 20 });
  const r = ruleProposal(p, m) as any;
  assert.ok(r.steps.some((s: any) => s.skill === 'smelt' && s.args.item === 'raw_iron'), JSON.stringify(r.steps));
});

test('自学：重复 succeeded 步骤不自动变成习惯；步骤签名仍可明确生成', () => {
  const m = new WorldMemory(null);
  const plan = [{ skill: 'gather', args: { block: 'coal', count: 3 } }, { skill: 'craft', args: { item: 'torch', count: 8 } }];
  for (let i = 0; i < 3; i++) m.recordGoal({ goal: '做火把', goalType: 'craft', source: 'llm', status: 'succeeded', summary: '', steps: signatureOf(plan).split(' → '), plan });
  const c = learnCandidates(m, new Set());
  assert.deepEqual(c, [], '动作返回成功不证明目标达成，也不授权将重复步骤写成习惯');
  assert.equal(signatureOf(plan), 'gather:coal → craft:torch');
  assert.equal(habitName({ signature: signatureOf(plan), times: 3, steps: plan, goal: '做火把' }), 'gather_coal_craft_torch');
  assert.equal(learnCandidates(m, new Set([signatureOf(plan)])).length, 0, '学过的不再提示');
});

test('仓储：存什么和存入哪个箱子由它点名，没点名的一样不动', async () => {
  const a = new FakeAdapter();
  a.inv.set('chest', 1);
  a.inv.set('iron_ingot', 7);
  a.inv.set('cobblestone', 50);
  a.inv.set('andesite', 10);
  a.inv.set('raw_copper', 5);
  const memory = new WorldMemory(null);
  memory.setWorld(a.state().worldId);
  const target = { x: 2, y: 64, z: 0 };
  a.blocks.push({ name: 'chest', pos: target });
  a.chests.set('2,64,0', new Map());
  assert.equal(storeItems.validate({}, undefined as any).ok, false, '不点名就不存');
  assert.equal(storeItems.validate({ items: 'not an array!' }, undefined as any).ok, false);
  assert.deepEqual((storeItems.validate({ items: ['dirt:32', 'minecraft:*_log'] }, undefined as any) as any).args.items, [{ name: 'dirt', count: 32 }, { name: '*_log' }]);
  // 模型实际常写的对象形式（10-27 日志里连着十几次 BAD_ARGS）
  assert.deepEqual((storeItems.validate({ items: [{ name: 'granite', count: 40 }, { name: 'diorite' }, { item: 'minecraft:gravel', count: 0 }] }, undefined as any) as any).args.items,
    [{ name: 'granite', count: 40 }, { name: 'diorite' }, { name: 'gravel' }]);
  assert.deepEqual((storeItems.validate({ items: { dirt: 32, andesite: true } }, undefined as any) as any).args.items, [{ name: 'dirt', count: 32 }, { name: 'andesite' }]);
  assert.equal(storeItems.validate({ items: [{ count: 3 }] }, undefined as any).ok, false, '对象没名字不收');
  const r = await runSkill(a, 'store_items', { items: ['cobblestone', 'and*', 'gravel'], target }, memory);
  assert.equal(r.o.result.status, 'succeeded', r.o.result.summary);
  assert.equal(a.inv.get('cobblestone') ?? 0, 0, '点名的整包存');
  assert.equal(a.inv.get('andesite') ?? 0, 0, '通配');
  assert.equal(a.inv.get('raw_copper'), 5, '没点名的不动');
  assert.equal(a.inv.get('iron_ingot'), 7, '没点名的不动');
  assert.deepEqual([...a.chests.get('2,64,0')!], [['cobblestone', 50], ['andesite', 10]], '只操作指定容器和实际存在的点名物品');
  assert.match(r.o.result.summary, /cobblestone×50/);
  assert.match(r.o.result.summary, /没有 gravel/);
});

test('仓储：箱子满了存入 0 件仍报失败，不假装成功、也不丢背包物品', async () => {
  const a = new FakeAdapter();
  a.inv.set('cobblestone', 64);
  const memory = new WorldMemory(null);
  memory.setWorld(a.state().worldId);
  const target = { x: 2, y: 64, z: 0 };
  a.blocks.push({ name: 'chest', pos: target });
  a.chests.set('2,64,0', new Map([['cobblestone', 64]]));
  a.chestFull = true;
  const r = await runSkill(a, 'store_items', { items: ['cobblestone'], target }, memory);
  assert.equal(r.o.result.status, 'failed', r.o.result.summary);
  assert.match(r.o.result.summary, /没有存入任何物品/);
  assert.equal(a.inv.get('cobblestone'), 64, '满了不能丢背包里的物品');
});

test('仓储未指定 target 只返回线索，make:true 也不制造或放置箱子', async (t) => {
  for (const preparation of ['chest', 'oak_planks']) for (const make of [false, true]) {
    const a = new FakeAdapter(), memory = new WorldMemory(null);
    t.after(() => memory.close());
    a.inv.set(preparation, preparation === 'chest' ? 1 : 8);
    a.inv.set('dirt', 40);
    const before = [...a.inv];
    const { o } = await runSkill(a, 'store_items', { items: ['dirt:24'], make }, memory);
    assert.equal(o.result.status, 'failed');
    assert.equal(o.result.failureCode, 'BAD_ARGS');
    assert.match(o.result.summary, /target/);
    assert.deepEqual(o.result.data?.candidates, []);
    assert.doesNotMatch(o.result.summary, /也做不了/);
    assert.deepEqual([...a.inv], before, '准备材料和待存物品都保留');
    assert.ok(!a.actions.some((action) => /^(craft|place):chest$/.test(action)));
    assert.equal(a.chests.size, 0);
    assert.equal(memory.chests().length, 0);
  }
});

test('expedition 带 find：沿路扫到目标就停，并报告覆盖范围', async (t) => {
  const a = new FakeAdapter();
  a.pos = { x: 0.5, y: 64, z: 0.5 };
  a.inv.set('bread', 5);
  const target = { x: 40, y: 64, z: 0 };
  const ctx = makeCtx(a, { senses: { knownBlocks: (names, maxDist) => {
    const dist = Math.hypot(target.x - a.pos.x, target.y - a.pos.y, target.z - a.pos.z);
    return dist <= maxDist && names.includes('oak_log') ? [{ name: 'oak_log', pos: target, dist }] : [];
  } } });
  t.after(() => ctx.memory.close());
  const validated = expedition.validate({ direction: 'E', distance: 100, find: 'oak_log' }, a);
  assert.ok(validated.ok);
  const r = await expedition.run(ctx, validated.args);
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal((r.data?.found as { name?: string } | null)?.name, 'oak_log');
  assert.equal((r.data?.coverage as { unknownBeyond?: boolean } | undefined)?.unknownBeyond, true);
  assert.match(r.summary, /路线附近发现 oak_log/);
  assert.ok(a.pos.x < 40, '找到目标就停下，不继续走完全程');
});

test('expedition 带 find 走完没看到：只说路线两侧未知，不断言世界没有', async (t) => {
  const a = new FakeAdapter();
  a.pos = { x: 0.5, y: 64, z: 0.5 };
  a.inv.set('bread', 5);
  const ctx = makeCtx(a, { senses: { knownBlocks: () => [] } });
  t.after(() => ctx.memory.close());
  const validated = expedition.validate({ direction: 'E', distance: 100, find: 'oak_log' }, a);
  assert.ok(validated.ok);
  const r = await expedition.run(ctx, validated.args);
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.found, null);
  assert.match(r.summary, /路线两侧约 32 格内没看见 oak_log/);
  assert.match(r.summary, /更远处和遮挡后仍未知/);
  const coverage = r.data?.coverage as { unknownBeyond?: boolean; scans?: number } | undefined;
  assert.equal(coverage?.unknownBeyond, true);
  assert.ok((coverage?.scans ?? 0) > 0);
  assert.ok(a.pos.x > 90, '走完指定距离才下结论');
});

/** 一条 x∈[-1,140] 的已观测走廊，在 x=6 处用两格石墙封死；授权 dig 时必须挖穿。 */
async function sealedWallExpedition(t: TestContext, maxEdits: number, secondWall = false) {
  clearMovementSessions();
  const map = expeditionCorridor(140);
  // 墙的观测要晚于走廊，避免同一毫秒内同格内容矛盾。
  await new Promise((resolve) => setTimeout(resolve, 5));
  const wall = [...[64, 65].map((y) => ({ x: 6, y, z: 0 })), ...(secondWall ? [64, 65].map((y) => ({ x: 60, y, z: 0 })) : [])];
  fillMap(map, 'minecraft:stone', wall);
  // 两侧与头顶封死，绕不过去，只能挖穿墙。
  const xs = Array.from({ length: 142 }, (_, i) => i - 1);
  fillMap(map, 'minecraft:stone', xs.flatMap((x) => [-1, 1].flatMap((z) => [63, 64, 65, 66].map((y) => ({ x, y, z })))));
  fillMap(map, 'minecraft:stone', xs.map((x) => ({ x, y: 66, z: 0 })));
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = { ...makeCtx(adapter), spatial: fakeSpatial(map) };
  t.after(() => ctx.memory.close());
  for (const pos of wall) adapter.blocks.push({ name: 'stone', pos });
  // 真实会话会把挖过的格标成“动作效果待确认”；这里由挖掘钩子直接同步体素，代替视觉刷新。
  Object.assign(ctx.spatial!, { markModified: () => ({ status: 'written', report: { sections: [] }, deliveryError: null }) });
  const realDig = adapter.dig.bind(adapter);
  adapter.dig = async (pos, signal) => {
    const r = await realDig(pos, signal);
    if (r.ok) fillMap(map, 'minecraft:air', [pos]);
    return r;
  };
  const validated = expedition.validate({ direction: 'E', distance: 100, dig: true, maxEdits }, adapter);
  assert.ok(validated.ok);
  const r = await expedition.run(ctx, validated.args);
  const edits = (r.data?.makeWay as { edits: { kind: string; pos: Vec3Like }[] } | undefined)?.edits ?? [];
  const coverage = r.data?.coverage as { start: Vec3Like; end: Vec3Like; travelled: number } | undefined;
  return { r, adapter, edits, coverage };
}

test('expedition 授权 dig：单跳被墙挡住时按已记录体素挖开继续，edits 与 coverage 反映实测进展', async (t) => {
  const { r, adapter, edits, coverage } = await sealedWallExpedition(t, 8);
  assert.equal(r.status, 'succeeded', r.summary);
  assert.ok(Math.floor(adapter.pos.x) > 6, `挖穿墙继续前进（实测 x=${adapter.pos.x}）`);
  assert.deepEqual(edits.map((e) => `${e.kind}@${e.pos.x},${e.pos.y},${e.pos.z}`).sort(), ['dig@6,64,0', 'dig@6,65,0']);
  assert.ok(coverage);
  assert.deepEqual(coverage.start, { x: 0.5, y: 64, z: 0.5 });
  assert.ok(coverage.end.x > 6, `coverage.end 是实测终点：${JSON.stringify(coverage.end)}`);
  assert.ok(coverage.travelled >= 90, `coverage.travelled=${coverage.travelled}`);
});

test('expedition 施工额度用完后仍继续走普通路线，不把额度耗尽当成方向受阻', async (t) => {
  const { r, adapter, edits, coverage } = await sealedWallExpedition(t, 2);
  assert.equal(r.status, 'succeeded', r.summary);
  assert.ok(Math.floor(adapter.pos.x) > 6, `挖穿墙后继续走（实测 x=${adapter.pos.x}）`);
  assert.equal(edits.length, 2, '两处挖开用尽额度');
  assert.ok(coverage);
  assert.ok(coverage.travelled >= 90, `额度用完后普通路线仍推进到 ${coverage.travelled} 格`);
  assert.equal((r.data as { stopReason?: string } | undefined)?.stopReason, undefined);
});

test('expedition 施工额度用完后遇到新墙：停下并报预算耗尽，不说成没有授权', async (t) => {
  const { r, edits } = await sealedWallExpedition(t, 2, true);
  assert.equal(edits.length, 2);
  const data = r.data as { stopReason?: string; lastHopFailure?: string } | undefined;
  assert.equal(data?.stopReason, 'MAKE_WAY_BUDGET_EXHAUSTED');
  assert.ok(data?.lastHopFailure);
  assert.doesNotMatch(r.summary, /没有授权 dig\/place/);
  assert.match(r.summary, /最后一次向前单跳没有通过/);
});

test('expedition place 参数经 make-way 校验进入 args；maxEdits 必须和 dig/place 一起授权', () => {
  const adapter = new FakeAdapter();
  const placed = expedition.validate({ direction: 'E', distance: 100, place: 'netherrack', maxEdits: 8 }, adapter);
  assert.ok(placed.ok);
  assert.equal(placed.args.place, 'netherrack');
  assert.equal(placed.args.maxEdits, 8);
  const noAuth = expedition.validate({ direction: 'E', distance: 100, maxEdits: 8 }, adapter);
  assert.equal(noAuth.ok, false);
  if (!noAuth.ok) assert.match(noAuth.error, /maxEdits/);
});

test('expedition 授权 dig 但没有共享空间 VoxelMap：明确失败，不静默忽略授权也不移动', async (t) => {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = makeCtx(adapter);
  t.after(() => ctx.memory.close());
  const validated = expedition.validate({ direction: 'E', distance: 100, dig: true }, adapter);
  assert.ok(validated.ok);
  const r = await expedition.run(ctx, validated.args);
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'BAD_ARGS');
  assert.match(r.summary, /没有共享空间 VoxelMap/);
  assert.equal(adapter.actions.length, 0, '没有静默改走普通移动');
  const coverage = r.data?.coverage as { start: Vec3Like; end: Vec3Like; travelled: number } | undefined;
  assert.ok(coverage);
  assert.deepEqual(coverage.start, { x: 0.5, y: 64, z: 0.5 });
  assert.deepEqual(coverage.end, { x: 0.5, y: 64, z: 0.5 });
  assert.equal(coverage.travelled, 0);
});

test('take_items 未指定 target 时，把看见的容器和可复制 target 写进摘要', async (t) => {
  const a = new FakeAdapter(), memory = new WorldMemory(null);
  t.after(() => memory.close());
  a.blocks.push({ name: 'chest', pos: { x: 2, y: 64, z: 0 } });
  const { o } = await runSkill(a, 'take_items', { item: 'coal', count: 4 }, memory);
  assert.equal(o.result.status, 'failed');
  assert.equal(o.result.failureCode, 'BAD_ARGS');
  assert.match(o.result.summary, /chest \(2,64,0\)/);
  assert.ok(o.result.summary.includes('target {"x":2,"y":64,"z":0}'), o.result.summary);
  assert.equal((o.result.data?.candidates as unknown[]).length, 1);
});

test('smelt make:true reaches the adapter prepare option; default stays false', async () => {
  const a = new FakeAdapter();
  a.inv.set('raw_iron', 2);
  a.inv.set('coal', 1);
  const seen: any[] = [];
  a.smelt = (async (_input: unknown, _count: unknown, _fuel: unknown, _signal: unknown, opts: unknown) => {
    seen.push(opts);
    return { ok: true, made: 1, output: 'iron_ingot' };
  }) as any;
  const first = await runSkill(a, 'smelt', { item: 'raw_iron' });
  assert.equal(first.o.result.status, 'succeeded', first.o.result.summary);
  assert.equal(seen[0]?.prepare, false);
  const second = await runSkill(a, 'smelt', { item: 'raw_iron', make: true });
  assert.equal(second.o.result.status, 'succeeded', second.o.result.summary);
  assert.equal(seen[1]?.prepare, true);
});
