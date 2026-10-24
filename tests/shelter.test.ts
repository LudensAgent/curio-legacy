import assert from 'node:assert/strict';
import test from 'node:test';
import type { GameAdapter, Vec3Like } from '../src/adapter/types.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { shelter } from '../src/skills/survival.ts';
import type { SkillCtx } from '../src/skills/types.ts';
import { throwIfAborted } from '../src/util.ts';
import { FakeAdapter } from './fake-adapter.ts';

/** Unlike the general fake, this fixture enforces a supporting face and the
 * player's actual body volume, which exposed the original two-deep geometry. */
class ShelterWorld extends FakeAdapter {
  digs: Vec3Like[] = [];
  placements: Vec3Like[] = [];
  grounded = true;
  descend = true;
  descentDelay = 0;
  acknowledgeDigOnly = false;
  capMode: 'normal' | 'ack-only' | 'wrong-name' = 'normal';
  afterDig?: (pos: Vec3Like) => void;
  afterCap?: () => void;

  constructor() {
    super();
    this.pos = { x: 0.5, y: 64, z: 0.5 };
    this.inv.set('dirt', 1);
  }
  setBlock(pos: Vec3Like, name: string) {
    this.blocks = this.blocks.filter((b) => b.pos.x !== pos.x || b.pos.y !== pos.y || b.pos.z !== pos.z);
    const key = `${pos.x},${pos.y},${pos.z}`;
    if (name === 'air') this.removed.add(key);
    else { this.removed.delete(key); this.blocks.push({ pos: { ...pos }, name }); }
  }
  override state() { return { ...super.state(), onGround: this.grounded }; }
  override async dig(pos: Vec3Like, signal: AbortSignal) {
    throwIfAborted(signal);
    this.digs.push({ ...pos });
    if (!this.acknowledgeDigOnly) {
      this.setBlock(pos, 'air');
      this.grounded = false;
      if (this.descend) {
        const land = () => { this.pos.y = pos.y; this.grounded = true; };
        if (this.descentDelay) setTimeout(land, this.descentDelay);
        else land();
      }
    }
    this.afterDig?.(pos);
    return { ok: true };
  }
  override async placeBlockAt(pos: Vec3Like, names: string[], signal: AbortSignal) {
    throwIfAborted(signal);
    this.placements.push({ ...pos });
    const offsets = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    if (!offsets.some(([dx, dy, dz]) => !['air', 'water', 'lava'].includes(this.blockAt({ x: pos.x + dx, y: pos.y + dy, z: pos.z + dz })))) return { ok: false, reason: 'NO_REFERENCE' };
    if (pos.x < this.pos.x + 0.3 && pos.x + 1 > this.pos.x - 0.3 && pos.z < this.pos.z + 0.3 && pos.z + 1 > this.pos.z - 0.3 && pos.y < this.pos.y + 1.8 && pos.y + 1 > this.pos.y) return { ok: false, reason: 'BODY_COLLISION' };
    if (this.capMode !== 'ack-only') this.setBlock(pos, this.capMode === 'wrong-name' ? 'glass' : names[0]);
    this.afterCap?.();
    return { ok: true };
  }
}

function context(adapter: GameAdapter, options: { signal?: AbortSignal; budget?: number; bus?: EventBus } = {}): SkillCtx {
  return { adapter, memory: new WorldMemory(null), bus: options.bus ?? new EventBus(), signal: options.signal ?? new AbortController().signal, taskId: 'shelter-test', deadline: Date.now() + (options.budget ?? 1000), progress() {}, senses: { knownBlocks: () => [], perceivedEntities: () => [], refresh() {}, markSweep() {} } };
}

test('shelter digs three levels and places a supported surface cap above two dry body cells', async () => {
  const world = new ShelterWorld();
  world.descentDelay = 5;
  const result = await shelter.run(context(world), { until: 'day' });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.deepEqual(world.digs.map((pos) => pos.y), [63, 62, 61]);
  assert.deepEqual(world.placements, [{ x: 0, y: 63, z: 0 }]);
  assert.equal(world.pos.y, 61);
  assert.equal(world.grounded, true);
  assert.equal(world.blockAt({ x: 0, y: 63, z: 0 }), 'dirt');
  assert.equal(world.blockAt({ x: 0, y: 62, z: 0 }), 'air');
  assert.equal(world.blockAt({ x: 0, y: 61, z: 0 }), 'air');
  assert.equal(world.blockAt({ x: 0, y: 60, z: 0 }), 'stone');
});

test('shelter preflight refuses fluids, open drops, falling or unknown fourth-level floors before digging', async () => {
  for (const floor of ['water', 'lava', 'air', 'sand', 'gravel', null]) {
    const world = new ShelterWorld();
    const adapter: GameAdapter = world;
    if (floor === null) {
      const read = adapter.blockAt.bind(adapter);
      adapter.blockAt = (pos) => pos.y === 60 ? null : read(pos);
    } else world.setBlock({ x: 0, y: 60, z: 0 }, floor);
    const result = await shelter.run(context(adapter), { until: 'day' });
    // 原地不安全：绝不在这一列动手；可以走到旁边安全的地方再挖（像玩家一样换个位置）
    const here = (p: Vec3Like) => p.x === 0 && p.z === 0;
    assert.equal(world.digs.filter(here).length, 0, String(floor));
    assert.equal(world.placements.filter(here).length, 0, String(floor));
    if (result.status === 'succeeded') assert.match(result.summary, /原地挖不了，走到/, String(floor));
  }
});

test('shelter checks the third dig level before any mutation and permits stable bedrock as the fourth-level floor', async () => {
  const unsafe = new ShelterWorld();
  unsafe.setBlock({ x: 0, y: 61, z: 0 }, 'water');
  await shelter.run(context(unsafe), { until: 'day' });
  assert.equal(unsafe.digs.filter((p) => Math.abs(p.x) + Math.abs(p.z) <= 1).length, 0, '不在挨着水的那一列和它旁边挖');
  const stable = new ShelterWorld();
  stable.setBlock({ x: 0, y: 60, z: 0 }, 'bedrock');
  assert.equal((await shelter.run(context(stable), { until: 'day' })).status, 'succeeded');
});

test('shelter bounds descent confirmation and never digs deeper or caps an unconfirmed fall', async () => {
  for (const acknowledgedOnly of [false, true]) {
    const world = new ShelterWorld();
    world.descend = false;
    world.acknowledgeDigOnly = acknowledgedOnly;
    const result = await shelter.run(context(world, { budget: 40 }), { until: 'day' });
    assert.equal(result.failureCode, 'TIMEOUT');
    assert.equal(world.digs.length, 1);
    assert.equal(world.placements.length, 0);
  }
});

test('shelter requires onGround as well as the observed feet height', async () => {
  const world = new ShelterWorld();
  world.afterDig = () => { world.grounded = false; };
  const result = await shelter.run(context(world, { budget: 40 }), { until: 'day' });
  assert.equal(result.failureCode, 'TIMEOUT');
  assert.equal(world.digs.length, 1);
  assert.equal(world.placements.length, 0);
});

test('shelter cancellation interrupts descent polling without another dig or cap', async () => {
  const world = new ShelterWorld(), controller = new AbortController();
  world.descend = false;
  const run = shelter.run(context(world, { signal: controller.signal }), { until: 'day' });
  setTimeout(() => controller.abort('test interruption'), 10);
  await assert.rejects(run, { name: 'AbortedError' });
  assert.equal(world.digs.length, 1);
  assert.equal(world.placements.length, 0);
});

test('shelter does not claim a false placement acknowledgement or a different cap block', async () => {
  for (const mode of ['ack-only', 'wrong-name'] as const) {
    const world = new ShelterWorld();
    world.capMode = mode;
    const ctx = context(world);
    const result = await shelter.run(ctx, { until: 'day' });
    assert.equal(result.status, 'failed');
    assert.match(result.summary, /封顶/);
    assert.equal(ctx.bus.recent().filter((event) => event.type === 'shelter').length, 0);
  }
});

test('shelter verifies dry headroom and floor again after sealing', async () => {
  for (const change of ['water', 'head', 'floor']) {
    const world = new ShelterWorld();
    world.afterCap = () => {
      if (change === 'water') world.inWater = true;
      if (change === 'head') world.setBlock({ x: 0, y: 62, z: 0 }, 'stone');
      if (change === 'floor') world.setBlock({ x: 0, y: 60, z: 0 }, 'air');
    };
    assert.equal((await shelter.run(context(world), { until: 'day' })).status, 'failed', change);
  }
});

test('shelter rechecks its seal and dry body cells before returning success', async () => {
  for (const change of ['water', 'head', 'cap', 'disconnect']) {
    const world = new ShelterWorld(), bus = new EventBus();
    bus.on('event', (event) => {
      if (event.type !== 'shelter') return;
      if (change === 'water') world.inWater = true;
      if (change === 'head') world.setBlock({ x: 0, y: 62, z: 0 }, 'water');
      if (change === 'cap') world.setBlock({ x: 0, y: 63, z: 0 }, 'air');
      if (change === 'disconnect') world.connected = false;
    });
    assert.equal((await shelter.run(context(world, { bus }), { until: 'day' })).status, 'failed', change);
  }
});
