import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import type { BlockHit, GameAdapter, MoveOpts, MoveTarget, Vec3Like } from '../src/adapter/types.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Vision } from '../src/perception/vision.ts';
import { EYE_DESCENT_LABEL, EXCAVATION_CHECKPOINT_LABEL, excavationSkill, type ExcavationArgs } from '../src/skills/excavation.ts';
import { findStronghold, searchStructure, structureSkills } from '../src/skills/structures.ts';
import type { Senses, SkillCtx } from '../src/skills/types.ts';
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
  assert.equal(structureSkills.excavate_path, excavationSkill);
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
  for (const name of ['air', 'water', 'lava', 'gravel', 'magma_block', 'stone_slab', 'nether_portal', null]) {
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

test('a shallow missing support returns the gap before digging and never spends blocks', async () => {
  const world = new ExcavationWorld();
  world.setBlock({ x: 1, y: 62, z: 0 }, 'air'); // 目标脚格下是空气，再下面 y61 是石头
  world.inv.set('cobblestone', 3);
  const result = await excavationSkill.run(context(world), args({ steps: 1 }));
  assert.equal(result.status, 'failed', result.summary);
  assert.equal(world.digs.length, 0, '报缺口之前没有开挖');
  assert.equal(world.moves.length, 0, '报缺口之前没有移动');
  assert.equal(world.inv.get('cobblestone'), 3, '纯开挖不擅自消耗材料垫块');
  assert.ok(!world.actions.some((action) => action.startsWith('place:')), '没有隐式放置');
  // 显式补上支撑（Agent 自己选择 place_at 的组合动作）后，同一段开挖可以完成。
  world.setBlock({ x: 1, y: 62, z: 0 }, 'cobblestone');
  const done = await excavationSkill.run(context(world), args({ steps: 1 }));
  assert.equal(done.status, 'succeeded', done.summary);
  assert.deepEqual(world.pos, { x: 1.5, y: 63, z: 0.5 });
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

test('excavation checks actual registry harvest tools, hardness, falling roofs and protected blocks', async () => {
  for (const mode of ['tool', 'bedrock', 'roof', 'frame']) {
    const world = new ExcavationWorld();
    if (mode === 'tool') { world.inv.clear(); world.setBlock({ x: 1, y: 63, z: 0 }, 'stone'); }
    if (mode === 'bedrock') world.setBlock({ x: 1, y: 63, z: 0 }, 'bedrock');
    if (mode === 'roof') world.setBlock({ x: 1, y: 66, z: 0 }, 'gravel');
    if (mode === 'frame') world.setBlock({ x: 1, y: 63, z: 0 }, 'end_portal_frame');
    const result = await excavationSkill.run(context(world), args({ steps: 1 }));
    assert.equal(result.status, 'failed', mode);
    if (mode === 'tool') assert.equal(result.failureCode, 'TOOL_MISSING');
    assert.equal(world.digs.length, 0, mode);
    assert.equal(world.moves.length, 0, mode);
  }
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
    await assert.rejects(excavationSkill.run(ctx, args()), { name: 'AbortedError' });
    assert.equal(world.digs.length, 1);
    assert.equal(world.moves.length, 0);
    assert.ok(!ctx.memory.landmarks().some((landmark) => landmark.label.startsWith(EXCAVATION_CHECKPOINT_LABEL)));
  }
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

test('ascending excavation rejects an unbreakable or falling jump ceiling and an inadequate real obsidian tool before mutation', async () => {
  for (const mode of ['bedrock', 'gravel', 'tool']) {
    const world = new ExcavationWorld(); tower(world);
    if (mode === 'tool') { world.inv.clear(); world.inv.set('iron_pickaxe', 1); }
    else world.setBlock({ x: 0, y: 66, z: 0 }, mode);
    const result = await excavationSkill.run(context(world), args({ mode: 'stairs_up', steps: 1 }));
    assert.equal(result.status, 'failed', mode);
    if (mode === 'tool') assert.equal(result.failureCode, 'TOOL_MISSING');
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
