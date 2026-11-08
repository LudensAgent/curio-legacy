import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import type { BlockHit, GameAdapter, MoveOpts, MoveTarget, Vec3Like } from '../src/adapter/types.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Vision } from '../src/perception/vision.ts';
import { EYE_DESCENT_LABEL, EXCAVATION_CHECKPOINT_LABEL, excavationSkill, type ExcavationArgs } from '../src/skills/excavation.ts';
import { excavateRun } from '../src/skills/movement/index.ts';
import { findStronghold, searchStructure, structureSkills } from '../src/skills/structures.ts';
import type { LandingOption, Senses, SkillCtx } from '../src/skills/types.ts';
import { throwIfAborted } from '../src/util.ts';
import { FakeAdapter } from './fake-adapter.ts';

const AIR = new Set(['air', 'cave_air', 'void_air']);
const require = createRequire(import.meta.url);
class ExcavationWorld extends FakeAdapter {
  digs: Vec3Like[] = [];
  moves: Vec3Like[] = [];
  moveOptions: MoveOpts[] = [];
  acknowledgeDigOnly = false;
  acknowledgeMoveOnly = false;
  afterDig?: (pos: Vec3Like) => void;
  afterMove?: () => void;
  constructor() { super(); this.pos = { x: 0.5, y: 64, z: 0.5 }; this.inv.set('iron_pickaxe', 1); }
  setBlock(pos: Vec3Like, name: string) {
    this.blocks = this.blocks.filter((block) => block.pos.x !== pos.x || block.pos.y !== pos.y || block.pos.z !== pos.z);
    const key = `${pos.x},${pos.y},${pos.z}`;
    if (name === 'air') this.removed.add(key);
    else { this.removed.delete(key); this.blocks.push({ name, pos: { ...pos } }); }
  }
  override async look(yaw: number, pitch: number, signal?: AbortSignal) { throwIfAborted(signal); this.yaw = yaw; this.pitch = pitch; }
  override lightAt() { return { block: 14, sky: 0 }; } // illuminated underground fixture
  override async dig(pos: Vec3Like, signal: AbortSignal) {
    throwIfAborted(signal);
    assert.ok(Math.hypot(pos.x + 0.5 - this.pos.x, pos.y + 0.5 - this.pos.y - 1.62, pos.z + 0.5 - this.pos.z) <= 4.5, 'only the physically adjacent work face is reachable');
    this.digs.push({ ...pos });
    if (!this.acknowledgeDigOnly) this.setBlock(pos, 'air');
    this.afterDig?.(pos);
    return { ok: true };
  }
  override async moveTo(target: MoveTarget, options: MoveOpts) {
    throwIfAborted(options.signal);
    assert.equal(target.kind, 'near');
    if (target.kind !== 'near') throw new Error('Unexpected movement');
    assert.equal(options.constructionSafe, true, 'the pathfinder must never dig or place outside the approved work column');
    assert.ok(Math.hypot(target.pos.x - this.pos.x, target.pos.z - this.pos.z) <= 1.01);
    const feet = { x: Math.floor(target.pos.x), y: target.pos.y, z: Math.floor(target.pos.z) };
    if (target.pos.y > this.pos.y) assert.ok(AIR.has(this.blockAt({ x: Math.floor(this.pos.x), y: Math.floor(this.pos.y) + 2, z: Math.floor(this.pos.z) })), 'jumping first requires actual clearance above the current head');
    for (const level of [0, 1]) assert.ok(AIR.has(this.blockAt({ ...feet, y: feet.y + level })), 'both actual body cells must be cleared before movement');
    assert.ok(!AIR.has(this.blockAt({ ...feet, y: feet.y - 1 })), 'a resolved move cannot fabricate a floor');
    this.moves.push({ ...target.pos }); this.moveOptions.push(options);
    if (!this.acknowledgeMoveOnly) this.pos = { ...target.pos };
    this.afterMove?.();
  }
}

function sensoryFixture(): Senses & { scan(): void; scans: number; visibleNow: Map<string, BlockHit> } {
  return { scans: 0, visibleNow: new Map(), scan() { this.scans++; }, refresh() { this.scan(); }, markSweep() {}, knownBlocks() { return []; }, perceivedEntities() { return []; } };
}
function context(world: GameAdapter, options: { memory?: WorldMemory; senses?: Senses; signal?: AbortSignal; budget?: number } = {}): SkillCtx {
  return { adapter: world, memory: options.memory ?? new WorldMemory(null), senses: options.senses ?? sensoryFixture(), signal: options.signal ?? new AbortController().signal, bus: new EventBus(), taskId: 'excavation-test', deadline: Date.now() + (options.budget ?? 30000), progress() {} };
}
const args = (overrides: Partial<ExcavationArgs> = {}): ExcavationArgs => ({ entry: 'current', mode: 'stairs', direction: 'east', steps: 3, ...overrides });
function entry(ctx: SkillCtx, label = `${EYE_DESCENT_LABEL}（尚未发现要塞）`) {
  const state = ctx.adapter.state(); ctx.memory.setWorld(state.worldId);
  return ctx.memory.addLandmark('waypoint', label, state.dim, state.pos, 0)!.id;
}

test('excavation has explicit bounded args and registers a reusable method without selecting it automatically', () => {
  const world = new ExcavationWorld();
  assert.equal('excavate_path' in structureSkills, false);
  assert.equal(excavationSkill.validate({ entry: 'current', direction: 'east' }, world).ok, true);
  for (const invalid of [{ steps: 9 }, { steps: 1.5 }, { steps: -1 }, { direction: '__proto__' }, { direction: 'toString' }, { direction: 'down' }, { entry: { x: 1, y: 2, z: 3 } }]) assert.equal(excavationSkill.validate({ ...args(), ...invalid }, world).ok, false);
  assert.deepEqual(searchStructure.validate({ kind: 'stronghold' }, world), { ok: true, args: { kind: 'stronghold', method: 'eye' } });
  assert.equal(searchStructure.validate({ kind: 'stronghold', method: 'excavate', entry: 'current', direction: 'east' }, world).ok, false);
});

test('stairs clear the three-cell transition and verify each real landing; results and next entry preserve only the actual route', async () => {
  const world = new ExcavationWorld(), senses = sensoryFixture(), ctx = context(world, { senses });
  const result = await excavationSkill.run(ctx, args());
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.completedSteps, 3);
  assert.equal(result.data?.structureVerified, false);
  assert.deepEqual(world.pos, { x: 3.5, y: 61, z: 0.5 });
  assert.deepEqual(world.moves.map((pos) => pos.y), [63, 62, 61]);
  assert.ok(world.digs.some((pos) => pos.x === 3 && pos.y === 63), 'the descending third step clears its upper transition cell too');
  assert.deepEqual(result.data?.actualOffset, { x: 3, y: -3, z: 0 });
  assert.equal((result.data?.path as unknown[]).length, 4);
  assert.equal(senses.scans, 4, 'pure excavation peeks the dig direction once per entry and landing, not four-way');
  const next = ctx.memory.landmarks().find((landmark) => landmark.id === result.data?.nextEntryId)!;
  assert.deepEqual(next.pos, { x: 3, y: 61, z: 0 });
  assert.equal(ctx.memory.landmarks().filter((landmark) => landmark.label.startsWith(EXCAVATION_CHECKPOINT_LABEL)).length, 1, 'the call updates one checkpoint rather than inventing intermediate discoveries');
  const resumed = await excavationSkill.run(ctx, args({ entry: next.id, steps: 1 }));
  assert.equal(resumed.status, 'succeeded', resumed.summary);
  assert.deepEqual(world.pos, { x: 4.5, y: 60, z: 0.5 });
});

test('excavation refuses unsafe, partial or unknown floors and adjacent liquids before digging', async () => {
  for (const name of ['water', 'lava', 'gravel', 'magma_block', 'stone_slab', 'nether_portal', null]) {
    const world = new ExcavationWorld(), adapter: GameAdapter = world;
    if (name === null) { const read = adapter.blockAt.bind(adapter); adapter.blockAt = (pos) => pos.x === 1 && pos.y === 62 ? null : read(pos); }
    else world.setBlock({ x: 1, y: 62, z: 0 }, name);
    const result = await excavationSkill.run(context(adapter), args({ steps: 1 }));
    assert.equal(result.status, 'failed', String(name));
    assert.equal(world.digs.length, 0, String(name)); assert.equal(world.moves.length, 0, String(name));
  }
  const world = new ExcavationWorld(); world.setBlock({ x: 2, y: 63, z: 0 }, 'water');
  assert.equal((await excavationSkill.run(context(world), args({ steps: 1 }))).status, 'failed');
  assert.equal(world.digs.length, 0);
});

test('a shallow missing support is followed down to the actual floor without spending blocks', async () => {
  const world = new ExcavationWorld();
  world.setBlock({ x: 1, y: 62, z: 0 }, 'air'); // 下一脚格 y63 的支撑格是空气；同列 y61 是石头，落差 1
  world.inv.set('cobblestone', 3);
  const result = await excavationSkill.run(context(world), args({ steps: 1 }));
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(world.inv.get('cobblestone'), 3, '下落到实际楼面不消耗材料');
  assert.ok(!world.actions.some((action) => action.startsWith('place:')), '没有隐式放置');
  assert.deepEqual(result.data?.adjustedDrops, [{ requestedFoot: 63, landingFoot: 62, drop: 1, block: 'stone', blockCell: { x: 1, y: 61, z: 0 } }]);
  assert.deepEqual(world.pos, { x: 1.5, y: 62, z: 0.5 });
});

test('a deep missing support returns the gap before digging and never spends blocks', async () => {
  const world = new ExcavationWorld();
  for (const y of [62, 61, 60, 59, 58]) world.setBlock({ x: 1, y, z: 0 }, 'air'); // 第一处楼面 y57，落差 5
  world.inv.set('cobblestone', 3);
  const result = await excavationSkill.run(context(world), args({ steps: 1 }));
  assert.equal(result.status, 'failed', result.summary);
  assert.equal(world.digs.length, 0, '报缺口之前没有开挖');
  assert.equal(world.moves.length, 0, '报缺口之前没有移动');
  assert.equal(world.inv.get('cobblestone'), 3, '纯开挖不擅自消耗材料垫块');
  assert.ok(!world.actions.some((action) => action.startsWith('place:')), '没有隐式放置');
  const cavity = result.data?.cavity as { reason: string; nextLanding: Vec3Like; supportCell: Vec3Like; visibleLandings: unknown[]; handoff: string };
  assert.equal(cavity.reason, 'next_landing_support_air');
  assert.deepEqual(cavity.nextLanding, { x: 1, y: 63, z: 0 });
  assert.deepEqual(cavity.supportCell, { x: 1, y: 62, z: 0 });
  assert.deepEqual(cavity.visibleLandings, [], '没有可见落点时不编造');
  assert.match(cavity.handoff, /descend/);
  assert.match(cavity.handoff, /没有自动垫方块/);
  // 显式补上支撑（Agent 自己选择 place_at 的组合动作）后，同一段开挖可以完成。
  world.setBlock({ x: 1, y: 62, z: 0 }, 'cobblestone');
  const done = await excavationSkill.run(context(world), args({ steps: 1 }));
  assert.equal(done.status, 'succeeded', done.summary);
  assert.deepEqual(world.pos, { x: 1.5, y: 63, z: 0.5 });
});

test('tunnel with explicit fill places the missing support before digging and advances', async () => {
  const world = new ExcavationWorld();
  world.setBlock({ x: 1, y: 63, z: 0 }, 'air'); // 下一脚格 y64 的支撑格是空的
  world.inv.set('netherrack', 5);
  const result = await excavationSkill.run(context(world), args({ mode: 'tunnel', steps: 1, fill: 'netherrack' }));
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.filledBlocks, 1);
  assert.deepEqual(result.data?.fillFacts, [{ at: { x: 1, y: 63, z: 0 }, item: 'netherrack' }]);
  assert.equal(world.blockAt({ x: 1, y: 63, z: 0 }), 'netherrack');
  assert.equal(world.inv.get('netherrack'), 4, '补支撑消耗 1 块');
  assert.deepEqual(world.pos, { x: 1.5, y: 64, z: 0.5 });
});

test('tunnel without fill stops at the support gap before digging or spending blocks', async () => {
  const world = new ExcavationWorld();
  world.setBlock({ x: 1, y: 63, z: 0 }, 'air');
  world.inv.set('netherrack', 5);
  const result = await excavationSkill.run(context(world), args({ mode: 'tunnel', steps: 1 }));
  assert.equal(result.status, 'failed', result.summary);
  assert.equal(world.digs.length, 0);
  assert.equal(world.moves.length, 0);
  assert.equal(world.inv.get('netherrack'), 5, '没有 fill 授权就不消耗材料');
  assert.match(result.summary, /支撑格 \(1,63,0\) 是空/);
  assert.match(result.summary, /没有自动垫方块/);
});

test('stairs_up with explicit fill places the step support and climbs', async () => {
  const world = new ExcavationWorld();
  world.inv.set('netherrack', 5);
  const result = await excavationSkill.run(context(world), args({ mode: 'stairs_up', steps: 1, fill: 'netherrack' }));
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.ascendedLevels, 1);
  assert.deepEqual(result.data?.fillFacts, [{ at: { x: 1, y: 64, z: 0 }, item: 'netherrack' }]);
  assert.equal(world.blockAt({ x: 1, y: 64, z: 0 }), 'netherrack');
  assert.equal(world.inv.get('netherrack'), 4);
  assert.deepEqual(world.pos, { x: 1.5, y: 65, z: 0.5 });
});

test('the air-gap failure includes currently visible lower landings without choosing one', async () => {
  const world = new ExcavationWorld();
  for (const y of [62, 61, 60, 59, 58]) world.setBlock({ x: 1, y, z: 0 }, 'air');
  const option: LandingOption = {
    target: { x: 1.5, y: 61, z: 0.5 }, support: { pos: { x: 1, y: 60, z: 0 }, name: 'stone' },
    surface: 'ground', surfaceY: 61, drop: 3, horizontalDistance: 1,
    clearance: 'clear', corridor: 'unknown', approach: 'adjacent', waterDepth: 'unknown', unknowns: ['接近入口或下落通道没有全部看清'],
    receipt: { worldId: world.worldId, sessionId: 's', dimension: 'overworld', observationId: 1, at: Date.now(), from: { x: 0.5, y: 64, z: 0.5 }, onGround: true },
  };
  const senses = { ...sensoryFixture(), landingOptions: () => [option] } as Senses;
  const result = await excavationSkill.run(context(world, { senses }), args({ steps: 1 }));
  const cavity = result.data?.cavity as { visibleLandings: Array<{ target: Vec3Like; corridor: string }> };
  assert.equal(result.status, 'failed');
  assert.equal(cavity.visibleLandings.length, 1);
  assert.deepEqual(cavity.visibleLandings[0].target, option.target);
  assert.equal(cavity.visibleLandings[0].corridor, 'unknown');
  assert.equal(world.moves.length, 0, 'handoff lists facts but does not choose or execute a descent');
});

test('a partial support surface is a geometric mismatch, not a claim that the game block is unstable', async () => {
  const world = new ExcavationWorld();
  world.setBlock({ x: 1, y: 62, z: 0 }, 'oak_slab');
  world.blockProperties.set('1,62,0', { type: 'bottom' }); // 顶面 62.5，不是请求的脚高 63
  const result = await excavationSkill.run(context(world), args({ steps: 1 }));
  assert.equal(result.status, 'failed', result.summary);
  assert.equal(result.data?.unsupportedGeometry, true);
  assert.match(result.summary, /支撑面在 y=62\.50/);
  assert.doesNotMatch(result.summary, /站不稳/);
  assert.equal(world.digs.length, 0);
  assert.equal(world.moves.length, 0);
});

test('excavation refuses an unknown body cell instead of treating it as clear', async () => {
  const world = new ExcavationWorld(), adapter: GameAdapter = world;
  const read = adapter.blockAt.bind(adapter);
  adapter.blockAt = (pos) => pos.x === 0 && pos.y === 64 ? null : read(pos);
  const result = await excavationSkill.run(context(adapter), args({ steps: 1 }));
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'NOT_FOUND');
  assert.equal(world.digs.length, 0);
  assert.equal(world.moves.length, 0);
});

test('transparent diggable blocks in the work face (wall_torch) are cleared, not rejected', async () => {
  const world = new ExcavationWorld();
  world.setBlock({ x: 1, y: 63, z: 0 }, 'wall_torch');
  const result = await excavationSkill.run(context(world), args({ steps: 1 }));
  assert.equal(result.status, 'succeeded', result.summary);
  assert.ok(world.digs.some((pos) => pos.x === 1 && pos.y === 63), 'the torch cell is dug instead of aborting excavation');
});

test('excavation rejects unbreakable, falling-roof and protected work faces before digging', async () => {
  for (const mode of ['bedrock', 'roof', 'frame']) {
    const world = new ExcavationWorld();
    if (mode === 'bedrock') world.setBlock({ x: 1, y: 63, z: 0 }, 'bedrock');
    if (mode === 'roof') world.setBlock({ x: 1, y: 66, z: 0 }, 'gravel');
    if (mode === 'frame') world.setBlock({ x: 1, y: 63, z: 0 }, 'end_portal_frame');
    const result = await excavationSkill.run(context(world), args({ steps: 1 }));
    assert.equal(result.status, 'failed', mode);
    assert.equal(world.digs.length, 0, mode);
    assert.equal(world.moves.length, 0, mode);
  }
});

test('清路不要求采到掉落：没有采掘工具也能挖开普通方块', async () => {
  const world = new ExcavationWorld();
  world.inv.clear();
  world.setBlock({ x: 1, y: 63, z: 0 }, 'stone');
  const result = await excavationSkill.run(context(world), args({ steps: 1 }));
  assert.equal(result.status, 'succeeded', result.summary);
  assert.ok(world.digs.length > 0, '没有镐仍可挖开清路');
});

test('a newly exposed liquid boundary stops movement and never creates a fictitious landing checkpoint', async () => {
  const world = new ExcavationWorld(), ctx = context(world);
  world.afterDig = () => world.setBlock({ x: 2, y: 63, z: 0 }, 'lava');
  const result = await excavationSkill.run(ctx, args({ steps: 1 }));
  assert.equal(result.status, 'failed');
  assert.equal(result.data?.completedSteps, 0);
  assert.equal(world.moves.length, 0);
  assert.ok(!ctx.memory.landmarks().some((landmark) => landmark.label.startsWith(EXCAVATION_CHECKPOINT_LABEL)));
});

test('false dig and movement acknowledgements cannot count as actual explored route', async () => {
  for (const mode of ['dig', 'move']) {
    const world = new ExcavationWorld();
    if (mode === 'dig') world.acknowledgeDigOnly = true;
    else world.acknowledgeMoveOnly = true;
    const result = await excavationSkill.run(context(world, { budget: 80 }), args({ steps: 1 }));
    assert.equal(result.status, 'failed', mode);
    assert.equal(result.data?.completedSteps, 0, mode);
    assert.deepEqual(world.pos, { x: 0.5, y: 64, z: 0.5 });
  }
});

test('cancelled or replaced excavation sessions cannot dig another cell, move or write a landing checkpoint', async () => {
  for (const mode of ['cancel', 'session']) {
    const world = new ExcavationWorld(), controller = new AbortController(), ctx = context(world, { signal: controller.signal });
    world.afterDig = () => { if (mode === 'cancel') controller.abort('paused'); else world.sessionId = 'replacement-session'; };
    await assert.rejects(excavationSkill.run(ctx, args()), (error: { name?: string; partial?: Record<string, unknown> }) => {
      assert.equal(error.name, 'AbortedError', mode);
      assert.equal(error.partial?.excavatedBlocks, 1, `${mode}: 取消保留已经实际挖掉的格数`);
      assert.equal(error.partial?.completedSteps, 0, `${mode}: 未迈步不能报成完成一段`);
      return true;
    });
    assert.equal(world.digs.length, 1);
    assert.equal(world.moves.length, 0);
    assert.ok(!ctx.memory.landmarks().some((landmark) => landmark.label.startsWith(EXCAVATION_CHECKPOINT_LABEL)));
  }
});

test('a bounded excavation timeout keeps the blocks actually dug and never invents a landing', async () => {
  const world = new ExcavationWorld(), ctx = context(world);
  world.afterDig = () => { ctx.deadline = Date.now() - 1; };
  const result = await excavationSkill.run(ctx, args({ steps: 1 }));
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'TIMEOUT');
  assert.equal(result.data?.excavatedBlocks, 1, '超时前实际挖掉的方块保留在结果里');
  assert.equal(result.data?.completedSteps, 0, '没有迈到下一级就不算完成');
  assert.equal(world.moves.length, 0);
  assert.ok(!ctx.memory.landmarks().some((landmark) => landmark.label.startsWith(EXCAVATION_CHECKPOINT_LABEL)));
});

test('structure continuation requires the actual scoped descent or explored entry and never starts from arbitrary labels', async () => {
  for (const mode of ['missing', 'invented-label', 'other-world', 'far']) {
    const world = new ExcavationWorld(), ctx = context(world);
    let id = 'nonexistent';
    if (mode !== 'missing') id = entry(ctx, mode === 'invented-label' ? '我猜这里有要塞' : undefined);
    if (mode === 'other-world') world.worldId = 'another-world';
    if (mode === 'far') world.pos.x = 50.5;
    const result = await searchStructure.run(ctx, { kind: 'stronghold', method: 'excavate', entry: id, direction: 'east', steps: 1 });
    assert.equal(result.status, 'failed', mode);
    assert.equal(result.data?.structureVerified, false, mode);
    assert.equal(world.digs.length, 0, mode);
  }
});

test('bounded room search digs actual horizontal passages and only a newly visible frame proves the structure', async () => {
  const world = new ExcavationWorld(); world.pos.y = 60;
  for (const x of [0, 3, 4]) for (const y of [60, 61]) world.setBlock({ x, y, z: 0 }, 'air');
  world.setBlock({ x: 4, y: 60, z: 0 }, 'end_portal_frame');
  const ctx = context(world, { senses: new Vision(world) });
  const id = entry(ctx);
  const result = await searchStructure.run(ctx, { kind: 'stronghold', method: 'room_search', entry: id, direction: 'east', steps: 8 });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.structureVerified, true);
  assert.equal(result.data?.completedSteps, 2, 'the route stops when a real newly exposed frame is observed');
  assert.equal(world.pos.y, 60, 'room search remains at the chosen underground level');
  assert.ok(ctx.memory.landmarks().some((landmark) => landmark.label === '实际末地门室门框'));
});

test('remembered but occluded frames and excavated stone bricks never become fresh structure proof', async () => {
  const world = new ExcavationWorld(), senses = sensoryFixture();
  senses.knownBlocks = () => [{ name: 'end_portal_frame', pos: { x: 4, y: 60, z: 0 }, dist: 5 }];
  world.setBlock({ x: 4, y: 60, z: 0 }, 'end_portal_frame');
  world.setBlock({ x: 1, y: 63, z: 0 }, 'stone_bricks');
  const ctx = context(world, { senses }), id = entry(ctx);
  const result = await searchStructure.run(ctx, { kind: 'stronghold', method: 'excavate', entry: id, direction: 'east', steps: 1 });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.structureVerified, false);
  assert.ok(!ctx.memory.landmarks().some((landmark) => landmark.label === '实际末地门室门框'));
  world.inv.delete('ender_eye');
  const eye = await findStronghold.run(ctx, { throws: 1, step: 8 });
  assert.equal(eye.status, 'failed');
  assert.notEqual(eye.data?.structureVerified, true);
});

function tower(world: ExcavationWorld) {
  for (let x = 0; x <= 4; x++) for (let y = 64; y <= 72; y++) world.setBlock({ x, y, z: 0 }, 'obsidian');
  for (const y of [64, 65]) world.setBlock({ x: 0, y, z: 0 }, 'air');
  world.inv.clear(); world.inv.set('diamond_pickaxe', 1);
}

test('explicit stairs_up clears jump transitions and ascends real supported steps without breaking either floor', async () => {
  const world = new ExcavationWorld(); tower(world);
  const result = await excavationSkill.run(context(world), args({ mode: 'stairs_up', steps: 3 }));
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.ascendedLevels, 3);
  assert.equal(result.data?.descendedLevels, 0);
  assert.deepEqual(world.pos, { x: 3.5, y: 67, z: 0.5 });
  assert.equal(world.blockAt({ x: 0, y: 63, z: 0 }), 'grass_block');
  for (let x = 1; x <= 3; x++) assert.equal(world.blockAt({ x, y: 63 + x, z: 0 }), 'obsidian', 'the ascending step itself remains solid');
  assert.deepEqual(world.digs[0], { x: 0, y: 66, z: 0 }, 'clear the current jump ceiling before opening the next landing');
  assert.deepEqual(result.data?.actualOffset, { x: 3, y: 3, z: 0 });
  assert.equal(result.data?.structureVerified, false, 'climbing is not evidence of a discovered structure or a cleared cage');
});

test('a non-load-bearing next landing reports its own reason, not the liquid hint', async () => {
  const world = new ExcavationWorld(); tower(world);
  world.setBlock({ x: 1, y: 64, z: 0 }, 'wall_torch');
  const result = await excavationSkill.run(context(world), args({ mode: 'stairs_up', steps: 1 }));
  assert.equal(result.status, 'failed');
  assert.match(result.summary, /没有水平承重顶面/);
  assert.match(result.summary, /不是能站的水平承重面/, '落点不能承重要给对应的处理方向');
  assert.doesNotMatch(result.summary, /避开液体/, '「没有水平承重顶面」不能被单个「水」字误判成液体');
  assert.equal(world.moves.length, 0);
});

test('ascending excavation rejects an unbreakable or falling jump ceiling before mutation', async () => {
  for (const mode of ['bedrock', 'gravel']) {
    const world = new ExcavationWorld(); tower(world);
    world.setBlock({ x: 0, y: 66, z: 0 }, mode);
    const result = await excavationSkill.run(context(world), args({ mode: 'stairs_up', steps: 1 }));
    assert.equal(result.status, 'failed', mode);
    assert.equal(world.digs.length, 0, mode);
    assert.equal(world.moves.length, 0, mode);
  }
});

test('a false current jump-ceiling dig cannot be accepted as an ascending step', async () => {
  const world = new ExcavationWorld(); tower(world); world.acknowledgeDigOnly = true;
  const result = await excavationSkill.run(context(world), args({ mode: 'stairs_up', steps: 1 }));
  assert.equal(result.status, 'failed');
  assert.equal(result.data?.ascendedLevels, 0);
  assert.equal(world.digs.length, 1);
  assert.equal(world.moves.length, 0);
});

test('installed Minecraft physics can jump onto an excavated upper step under the remaining solid tower ceiling', async () => {
  const data = require('minecraft-data')('1.20.1');
  const { Physics, PlayerState } = require('prismarine-physics');
  const Block = require('prismarine-block')(data), Vec3 = require('vec3').Vec3;
  class PhysicalWorld extends ExcavationWorld {
    player: any;
    override state() { return { ...super.state(), onGround: this.player?.entity.onGround ?? true }; }
    override async moveTo(target: MoveTarget, options: MoveOpts) {
      throwIfAborted(options.signal);
      assert.equal(target.kind, 'near'); assert.equal(options.constructionSafe, true);
      if (target.kind !== 'near') throw new Error('Unexpected movement');
      const controls = { forward: true, back: false, left: false, right: false, jump: true, sprint: false, sneak: false };
      const environment = { getBlock: (position: any) => {
        const p = position.floored(), block = Block.fromStateId(data.blocksByName[this.blockAt(p)].defaultState, 0);
        block.position = p; return block;
      } };
      this.player = { version: '1.20.1', entity: { position: new Vec3(this.pos.x, this.pos.y, this.pos.z), velocity: new Vec3(0, 0, 0),
        onGround: true, isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: false,
        yaw: -Math.PI / 2, pitch: 0, effects: {}, attributes: {} }, inventory: { slots: [] }, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0 };
      const physics = Physics(data, environment);
      for (let tick = 0; tick < 100; tick++) {
        throwIfAborted(options.signal);
        if (this.player.entity.position.x >= target.pos.x - 0.2) { controls.forward = false; controls.jump = false; }
        physics.simulatePlayer(new PlayerState(this.player, controls), environment).apply(this.player);
        this.pos = { ...this.player.entity.position };
        if (tick > 20 && this.player.entity.onGround && Math.abs(this.pos.y - target.pos.y) < 0.1) break;
      }
      assert.equal(this.player.entity.onGround, true);
      assert.ok(Math.abs(this.pos.y - target.pos.y) < 0.1, `actual physics failed to ascend: ${JSON.stringify(this.pos)}`);
      this.moves.push({ ...this.pos });
    }
  }
  const world = new PhysicalWorld(); tower(world);
  const result = await excavationSkill.run(context(world), args({ mode: 'stairs_up', steps: 1 }));
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.ascendedLevels, 1);
  assert.equal(world.pos.y, 65);
  assert.equal(world.state().onGround, true);
  assert.equal(world.blockAt({ x: 0, y: 67, z: 0 }), 'obsidian', 'the test retains a real solid ceiling, rather than granting open sky');
  assert.equal(world.blockAt({ x: 1, y: 64, z: 0 }), 'obsidian', 'the real jump lands on the original retained step');
});

test('standing on a partial support is a capability gap that returns BAD_ARGS with remediation', async () => {
  const world = new ExcavationWorld();
  world.setBlock({ x: 0, y: 63, z: 0 }, 'soul_sand');
  world.pos = { x: 0.5, y: 63.875, z: 0.5 };
  const result = await excavationSkill.run(context(world), args({ mode: 'stairs_up', steps: 1 }));
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'BAD_ARGS', '按规格 capability → BAD_ARGS + unsupportedGeometry + remediation');
  assert.equal(result.data?.unsupportedGeometry, true);
  assert.match(result.summary, /半格/);
  assert.deepEqual(result.data?.remediation, { action: 'move_step', at: { x: 0, y: 63, z: 0 }, reason: 'fractional_foot_support' });
  assert.equal(world.digs.length, 0);
});

test('excavate_run 保留 excavate_path 的逐格验收，并把风险停下的类别交回', async () => {
  const world = new ExcavationWorld(), ctx = context(world);
  assert.ok(excavateRun.validate({ mode: 'stairs', direction: 'east', steps: 1 }, world).ok);
  assert.equal(excavateRun.validate({ entry: 'current', mode: 'stairs', direction: 'east', steps: 1 }, world).ok, false);
  assert.equal(excavateRun.name, 'excavate_run');
  world.setBlock({ x: 1, y: 63, z: 1 }, 'water');
  const blocked = await excavateRun.run(ctx, args({ steps: 1 }));
  assert.equal(blocked.status, 'failed');
  assert.equal(blocked.data?.stopKind, 'risk');
  assert.equal(blocked.data?.decisionRequired, true);
  assert.equal(world.digs.length, 0);
});

test('excavate_run wet:true 接受相邻水流入并继续开挖', async () => {
  const world = new ExcavationWorld(), ctx = context(world);
  world.setBlock({ x: 1, y: 63, z: 1 }, 'water');
  const result = await excavateRun.run(ctx, args({ steps: 1, wet: true }));
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.completedSteps, 1);
});

test('excavate_run allowFalling:true 接受沙砾支撑；默认仍在风险前停下', async () => {
  const world = new ExcavationWorld(), ctx = context(world);
  world.setBlock({ x: 1, y: 62, z: 0 }, 'gravel');
  const blocked = await excavateRun.run(ctx, args({ steps: 1 }));
  assert.equal(blocked.status, 'failed');
  assert.equal(blocked.data?.stopKind, 'risk');
  const allowed = await excavateRun.run(ctx, args({ steps: 1, allowFalling: true }));
  assert.equal(allowed.status, 'succeeded', allowed.summary);
});

test('excavate_run 邻格未加载只跳过、不阻断整条开挖，并把未知邻格作为数据返回', async () => {
  const world = new ExcavationWorld(), ctx = context(world);
  const read = world.blockAt.bind(world);
  world.blockAt = ((pos) => pos.x === 1 && pos.y === 63 && pos.z === 1 ? null : read(pos)) as unknown as typeof world.blockAt;
  const result = await excavateRun.run(ctx, args({ steps: 1 }));
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.completedSteps, 1);
  const unknown = result.data?.unknownAdjacent as Vec3Like[];
  assert.deepEqual(unknown, [{ x: 1, y: 63, z: 1 }], '未知邻格作为边界事实返回，不当成危险也不阻断');
});

test('工作面自身的下落方块默认可挖，并在回执里标记为已接受风险', async () => {
  const world = new ExcavationWorld();
  world.setBlock({ x: 1, y: 63, z: 0 }, 'sand');
  const result = await excavationSkill.run(context(world), args({ steps: 1 }));
  assert.equal(result.status, 'succeeded', result.summary);
  assert.ok(world.digs.some((pos) => pos.x === 1 && pos.y === 63), '工作面沙子默认挖开');
  const risks = result.data?.risks as Array<{ at: Vec3Like; name: string; kind: string; role: string; authorization: string; accepted: boolean }>;
  assert.deepEqual(risks.find((risk) => risk.at.x === 1 && risk.at.y === 63), {
    at: { x: 1, y: 63, z: 0 }, name: 'sand', kind: 'falling', role: 'work_face', authorization: 'allowFalling', accepted: true,
  });
  assert.deepEqual(result.data?.riskCells, [{ x: 1, y: 63, z: 0 }]);
});

test('挖后复核持续失败：工作面沙被落块回填时不报成功、不移动', async () => {
  const world = new ExcavationWorld();
  world.setBlock({ x: 1, y: 63, z: 0 }, 'sand');
  world.afterDig = (pos) => { if (pos.x === 1 && pos.y === 63) world.setBlock(pos, 'sand'); };
  const result = await excavationSkill.run(context(world), args({ steps: 1 }));
  assert.equal(result.status, 'failed', result.summary);
  assert.equal(result.failureCode, 'EFFECT_NOT_CONFIRMED');
  assert.equal(result.data?.completedSteps, 0);
  assert.deepEqual(result.data?.refill, { at: { x: 1, y: 63, z: 0 }, name: 'sand' });
  assert.equal(world.moves.length, 0);
  assert.ok(!world.actions.some((action) => action.startsWith('place:')), '复核失败没有用回填掩盖或自行垫块');
});

test('落点上方的下落方块默认停在风险前，allowFalling 后才继续并报告授权', async () => {
  const world = new ExcavationWorld();
  world.setBlock({ x: 1, y: 66, z: 0 }, 'gravel'); // 两格高隧道的头顶上方
  const blocked = await excavationSkill.run(context(world), args({ mode: 'tunnel', steps: 1 }));
  assert.equal(blocked.status, 'failed', blocked.summary);
  assert.equal(blocked.failureCode, 'BAD_ARGS', '风险不是笼统 ERROR');
  assert.equal(blocked.data?.stopKind, 'risk');
  assert.equal(blocked.data?.decisionRequired, true);
  const risks = blocked.data?.risks as Array<{ at: Vec3Like; name: string; kind: string; authorization: string; accepted: boolean }>;
  assert.deepEqual(risks.find((risk) => risk.name === 'gravel'), {
    at: { x: 1, y: 66, z: 0 }, name: 'gravel', kind: 'falling', role: 'neighbor', authorization: 'allowFalling', accepted: false,
  });
  assert.deepEqual(blocked.data?.riskCells, [{ x: 1, y: 66, z: 0 }]);
  assert.deepEqual(blocked.data?.remediation, { action: 'authorize', authorization: 'allowFalling', at: { x: 1, y: 66, z: 0 }, reason: 'unaccepted_risk' });
  assert.equal(world.digs.length, 0);
  assert.equal(world.moves.length, 0);

  const allowedWorld = new ExcavationWorld();
  allowedWorld.setBlock({ x: 1, y: 66, z: 0 }, 'gravel');
  const allowed = await excavationSkill.run(context(allowedWorld), args({ mode: 'tunnel', steps: 1, allowFalling: true }));
  assert.equal(allowed.status, 'succeeded', allowed.summary);
  const allowedRisks = allowed.data?.risks as Array<{ name: string; accepted: boolean }>;
  assert.ok(allowedRisks.some((risk) => risk.name === 'gravel' && risk.accepted));
});

test('相邻岩浆默认停在风险前，lava:true 显式接受后才继续', async () => {
  const world = new ExcavationWorld();
  world.setBlock({ x: 1, y: 63, z: 1 }, 'lava');
  const blocked = await excavationSkill.run(context(world), args({ steps: 1 }));
  assert.equal(blocked.status, 'failed', blocked.summary);
  assert.equal(blocked.failureCode, 'BAD_ARGS');
  assert.equal(blocked.data?.stopKind, 'risk');
  assert.equal(blocked.data?.decisionRequired, true);
  const risks = blocked.data?.risks as Array<{ name: string; kind: string; authorization: string; accepted: boolean }>;
  assert.deepEqual(risks.find((risk) => risk.name === 'lava'), { at: { x: 1, y: 63, z: 1 }, name: 'lava', kind: 'liquid', role: 'neighbor', authorization: 'lava', accepted: false });
  assert.deepEqual(blocked.data?.remediation, { action: 'authorize', authorization: 'lava', at: { x: 1, y: 63, z: 1 }, reason: 'unaccepted_risk' });
  assert.equal(world.digs.length, 0);
  assert.equal(world.moves.length, 0);

  const allowedWorld = new ExcavationWorld();
  allowedWorld.setBlock({ x: 1, y: 63, z: 1 }, 'lava');
  const allowed = await excavationSkill.run(context(allowedWorld), args({ steps: 1, lava: true }));
  assert.equal(allowed.status, 'succeeded', allowed.summary);
  assert.equal(allowed.data?.completedSteps, 1);
});

test('落点支撑或身体是液体时 wet/lava 不能授权，补救不再建议 authorize', async () => {
  const cases: Array<{ name: 'water' | 'lava'; auth: Partial<ExcavationArgs>; at: Vec3Like; role: 'landing_support' | 'body' }> = [
    { name: 'water', auth: { wet: true }, at: { x: 1, y: 62, z: 0 }, role: 'landing_support' },
    { name: 'lava', auth: { lava: true }, at: { x: 1, y: 62, z: 0 }, role: 'landing_support' },
    { name: 'water', auth: { wet: true }, at: { x: 0, y: 64, z: 0 }, role: 'body' },
    { name: 'lava', auth: { lava: true }, at: { x: 0, y: 64, z: 0 }, role: 'body' },
  ];
  for (const c of cases) {
    for (const override of [{}, c.auth]) {
      const world = new ExcavationWorld();
      world.setBlock(c.at, c.name);
      const result = await excavationSkill.run(context(world), args({ steps: 1, ...override }));
      assert.equal(result.status, 'failed', `${c.role}/${c.name}: 液体不会被 wet/lava 变成可站`);
      assert.equal(result.failureCode, 'BAD_ARGS');
      assert.equal(result.data?.stopKind, 'risk');
      const risks = result.data?.risks as Array<{ at: Vec3Like; name: string; kind: string; role: string; authorization: string | null; accepted: boolean }>;
      assert.deepEqual(risks.find((risk) => risk.at.x === c.at.x && risk.at.y === c.at.y), {
        at: c.at, name: c.name, kind: 'liquid', role: c.role, authorization: null, accepted: false,
      }, `${c.role}/${c.name}: 落点/身体的液体没有可授权开关`);
      const remediation = result.data?.remediation as { action: string; authorization?: string } | undefined;
      assert.equal(remediation?.action, 'change_direction', `${c.role}/${c.name}: 补救不能建议 wet/lava`);
      assert.equal(remediation?.authorization, undefined);
      assert.equal(world.digs.length, 0);
      assert.equal(world.moves.length, 0);
    }
  }
});

test('缺支撑返回契约字段 supportMissing 和一步补救，而不是只给文本', async () => {
  const world = new ExcavationWorld();
  world.setBlock({ x: 1, y: 63, z: 0 }, 'air'); // tunnel 下一脚格 y64 的支撑格为空
  const result = await excavationSkill.run(context(world), args({ mode: 'tunnel', steps: 1 }));
  assert.equal(result.status, 'failed', result.summary);
  assert.equal(result.failureCode, 'PATH_NOT_FOUND');
  assert.equal(result.data?.stopKind, 'missing_support');
  assert.equal(result.data?.decisionRequired, true);
  assert.deepEqual(result.data?.supportMissing, {
    at: { x: 1, y: 63, z: 0 },
    item: 'any',
    stance: { kind: 'adjacent', recommended: 'west' },
    cost: 1,
    reason: 'next_landing_support_air',
  });
  assert.deepEqual(result.data?.remediation, { action: 'place_support', at: { x: 1, y: 63, z: 0 }, item: 'any', reason: 'next_landing_support_air' });
  assert.equal(world.digs.length, 0);
  assert.equal(world.moves.length, 0);
});

test('fill 材料不足时按 capability 分类，仍返回 supportMissing（含指定材料）且不挖不垫', async () => {
  const world = new ExcavationWorld();
  world.setBlock({ x: 1, y: 63, z: 0 }, 'air');
  const result = await excavationSkill.run(context(world), args({ mode: 'tunnel', steps: 1, fill: 'netherrack' }));
  assert.equal(result.status, 'failed', result.summary);
  assert.equal(result.failureCode, 'MISSING_MATERIALS');
  assert.equal(result.data?.stopKind, 'capability', '材料不足不是缺支撑');
  assert.equal(result.data?.decisionRequired, true);
  const missing = result.data?.supportMissing as { at: Vec3Like; item: string; cost: number };
  assert.deepEqual(missing.at, { x: 1, y: 63, z: 0 });
  assert.equal(missing.item, 'netherrack', '回执带出 Agent 指定的 fill 材料');
  assert.equal(missing.cost, 1);
  assert.equal(result.data?.remediation && (result.data.remediation as { action: string }).action, 'place_support');
  assert.equal(world.digs.length, 0);
  assert.equal(world.moves.length, 0);
  assert.ok(!world.actions.some((action) => action.startsWith('place:')), '补支撑失败没有自行换材料');
});

test('fill 补支撑仍无支撑时报 missing_support，并带出结构化站位尝试', async () => {
  const world = new ExcavationWorld();
  world.setBlock({ x: 1, y: 63, z: 0 }, 'air');
  world.inv.set('netherrack', 5);
  const place = world.placeBlockAt.bind(world);
  world.placeBlockAt = async (pos, itemNames, signal) => pos.x === 1 && pos.y === 63 && pos.z === 0
    ? { ok: false as const, reason: 'NO_REFERENCE' }
    : place(pos, itemNames, signal);
  const result = await excavationSkill.run(context(world), args({ mode: 'tunnel', steps: 1, fill: 'netherrack' }));
  assert.equal(result.status, 'failed', result.summary);
  assert.equal(result.failureCode, 'PATH_NOT_FOUND');
  assert.equal(result.data?.stopKind, 'missing_support', '补了仍无支撑才是缺支撑');
  const attempts = result.data?.fillAttempts as Record<string, unknown>[];
  assert.ok(Array.isArray(attempts) && attempts.length > 0, 'attempts 作为结构化字段返回');
  assert.equal(attempts[0].stance, 'current');
  assert.match(result.summary, /站位尝试/);
  assert.equal(world.digs.length, 0);
  assert.equal(world.inv.get('netherrack'), 5, '补支撑失败没有消耗材料');
});

test('两格高隧道按真实几何保留天花板并逐格确认身体空间', async () => {
  const world = new ExcavationWorld();
  for (const x of [1, 2, 3]) world.setBlock({ x, y: 66, z: 0 }, 'stone');
  const result = await excavationSkill.run(context(world), args({ mode: 'tunnel', steps: 2 }));
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.completedSteps, 2);
  assert.deepEqual(world.pos, { x: 2.5, y: 64, z: 0.5 });
  for (const x of [1, 2, 3]) assert.equal(world.blockAt({ x, y: 66, z: 0 }), 'stone', '头顶天花板保持完整');
  assert.equal(world.digs.length, 0, '两格高通道的脚/头空间本来就是空气，只在工作面实心时才挖');
});

test('未知工作面仍然硬停，不把未知当空气挖', async () => {
  const world = new ExcavationWorld(), adapter: GameAdapter = world;
  const read = adapter.blockAt.bind(adapter);
  adapter.blockAt = (pos) => pos.x === 1 && pos.y === 63 ? null : read(pos);
  const result = await excavationSkill.run(context(adapter), args({ steps: 1 }));
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'NOT_FOUND');
  assert.equal(world.digs.length, 0);
  assert.equal(world.moves.length, 0);
});
