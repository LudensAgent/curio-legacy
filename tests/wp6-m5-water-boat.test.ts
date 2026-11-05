import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Vision } from '../src/perception/vision.ts';
import { FakeAdapter } from './fake-adapter.ts';

const { Vec3 } = createRequire(import.meta.url)('vec3');

const flush = async () => { await setImmediate(); };

const AIR = new Set(['air', 'cave_air', 'void_air']);
const WATER = new Set(['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass']);

/**
 * A scripted body: blockAt is authoritative observation, and each physics wait
 * calls `onTick` so a test controls exactly where the body is without a game
 * server. It never lets the adapter's own promises invent a landing.
 */
function scriptedSwimmer(t: TestContext, opts: {
  start: { x: number; y: number; z: number };
  onGround: boolean;
  inWater: boolean;
  blockAt: (cell: { x: number; y: number; z: number }) => string | null;
  onTick: (bot: any, tick: number) => void;
}) {
  let now = 100000, tick = 0;
  t.mock.method(Date, 'now', () => now);
  const controls: Record<string, boolean> = {};
  const bot: any = {
    game: { dimension: 'overworld' },
    entity: { position: new Vec3(opts.start.x, opts.start.y, opts.start.z), velocity: new Vec3(0, 0, 0), eyeHeight: 1.62,
      onGround: opts.onGround, isInWater: opts.inWater, isInLava: false, isCollidedHorizontally: false, yaw: 0, pitch: 0 },
    oxygenLevel: 20,
    pathfinder: { setGoal() {} },
    setControlState(name: string, value: boolean) { controls[name] = value; },
    clearControlStates() { for (const key of Object.keys(controls)) controls[key] = false; },
    blockAt: (p: any) => {
      const name = opts.blockAt({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
      if (name === null) return null;
      return { name, boundingBox: AIR.has(name) || WATER.has(name) || name === 'lava' ? 'empty' : 'block', getProperties: () => ({}) as Record<string, string | number | boolean> };
    },
    async look(yaw: number, pitch: number) { bot.entity.yaw = yaw; bot.entity.pitch = pitch; },
    async waitForTicks(count: number) { for (let i = 0; i < count; i++) { tick++; opts.onTick(bot, tick); now += 50; } },
  };
  const adapter = new MineflayerAdapter(config, new EventBus());
  adapter.bot = bot; adapter.mcData = {}; Reflect.set(adapter, 'connectedFlag', true);
  return { adapter, bot, controls, ticks: () => tick };
}

/** Water spans 0 <= x < 6 at y<=63; stone shores on both sides; a dry island at x=3. */
function shoreWorld(cell: { x: number; y: number; z: number }) {
  if (cell.y >= 64) return 'air';
  if (cell.x < 0 || cell.x >= 6) return 'stone';
  if (cell.x === 3) return 'stone';
  return 'water';
}

test('dry shore -> water -> chosen shore reports approach/swimming/landed and never lands on an island', async (t) => {
  const data = scriptedSwimmer(t, {
    start: { x: 6.5, y: 64, z: 2.5 }, onGround: true, inWater: false, blockAt: shoreWorld,
    onTick: (bot) => {
      const x = Math.max(-0.5, bot.entity.position.x - 0.7);
      const dry = x < 0 || x >= 6 || Math.floor(x) === 3;
      bot.entity.position.set(x, dry ? 64 : 62.4, 2.5);
      bot.entity.onGround = dry;
      bot.entity.isInWater = !dry;
      bot.entity.isCollidedHorizontally = false;
    },
  });
  const r = await data.adapter.swimTo({ x: -0.5, y: 64, z: 2.5 }, new AbortController().signal, { timeoutMs: 15000 });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.landed, true, 'only the chosen far shore is a landing');
  assert.equal(r.goal, 'dry_shore');
  assert.equal(r.stage, 'landed');
  assert.equal(r.enteredWater, true, 'water contact is a separate observed stage');
  assert.equal(r.targetInWater, false);
  assert.ok((r.advanced ?? 0) >= 6, `horizontal progress should be reported: ${r.advanced}`);
  assert.ok(data.bot.entity.position.x < 0, `must not return on the non-target island: x=${data.bot.entity.position.x}`);
  assert.equal(data.controls.forward, false);
  assert.equal(data.controls.jump, false);
  assert.equal(data.controls.sprint, false);
});

test('a surfaced head at the target height does not count as dry landing', async (t) => {
  const data = scriptedSwimmer(t, {
    start: { x: 2.5, y: 62.6, z: 2.5 }, onGround: false, inWater: true,
    blockAt: (cell) => (cell.y >= 64 ? 'air' : cell.y >= 60 ? 'water' : 'stone'),
    onTick: () => {},
  });
  const r = await data.adapter.swimTo({ x: 2.5, y: 64, z: 2.5 }, new AbortController().signal, { timeoutMs: 1500 });
  assert.equal(r.ok, false, 'breathing is not arrival');
  assert.equal(r.landed, false);
  assert.equal(r.surfaced, true, 'head in air is reported as its own fact');
  assert.equal(r.goal, 'dry_shore');
  assert.notEqual(r.stage, 'landed');
});

test('a transient airborne inWater=false at the target is not a landing', async (t) => {
  const data = scriptedSwimmer(t, {
    start: { x: 2.5, y: 62.6, z: 2.5 }, onGround: false, inWater: false,
    blockAt: (cell) => (cell.y >= 64 ? 'air' : cell.y >= 60 ? 'water' : 'stone'),
    onTick: () => {},
  });
  const r = await data.adapter.swimTo({ x: 2.5, y: 64, z: 2.5 }, new AbortController().signal, { timeoutMs: 1000 });
  assert.equal(r.landed, false, 'no onGround support => not dry footing');
  assert.equal(r.stage !== 'landed', true);
});

test('vertical bobbing against a bank does not refresh progress', async (t) => {
  const data = scriptedSwimmer(t, {
    start: { x: 2.5, y: 62.4, z: 2.5 }, onGround: false, inWater: true,
    blockAt: (cell) => (cell.y >= 64 ? 'air' : cell.y >= 60 ? 'water' : 'stone'),
    onTick: (bot, tick) => { bot.entity.position.y = 62.4 + (tick % 6 < 3 ? 0.7 : -0.7); },
  });
  const begun = Date.now();
  const r = await data.adapter.swimTo({ x: 20.5, y: 62.4, z: 2.5 }, new AbortController().signal, { timeoutMs: 10000 });
  assert.equal(r.reason, 'SWIM_NO_PROGRESS', `bobbing must not look like progress: ${r.reason}`);
  assert.equal(r.landed, false);
  assert.ok(Date.now() - begun < 10000, 'stall detection fires inside the budget');
});

test('a caller-selected in-water target completes in water without forcing a landing', async (t) => {
  const data = scriptedSwimmer(t, {
    start: { x: 6.5, y: 62.4, z: 2.5 }, onGround: false, inWater: true,
    blockAt: (cell) => (cell.y >= 64 ? 'air' : cell.y >= 60 ? 'water' : 'stone'),
    onTick: (bot) => { bot.entity.position.x = Math.max(2.5, bot.entity.position.x - 0.8); },
  });
  const r = await data.adapter.swimTo({ x: 2.5, y: 62.4, z: 2.5 }, new AbortController().signal, { timeoutMs: 5000 });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.goal, 'surface_target');
  assert.equal(r.stage, 'surface_reached');
  assert.equal(r.targetInWater, true);
  assert.equal(r.landed, false, 'in-water completion is not a dry landing');
});

test('cancelled swimming releases exactly jump/forward/sprint and a late tick cannot revive them', async (t) => {
  const data = scriptedSwimmer(t, {
    start: { x: 2.5, y: 62.4, z: 2.5 }, onGround: false, inWater: true,
    blockAt: (cell) => (cell.y >= 64 ? 'air' : cell.y >= 60 ? 'water' : 'stone'),
    onTick: () => {},
  });
  let release!: () => void;
  data.bot.waitForTicks = () => new Promise<void>((resolve) => { release = resolve; });
  const controller = new AbortController();
  const pending = data.adapter.swimTo({ x: 20.5, y: 64.4, z: 2.5 }, controller.signal, { timeoutMs: 5000 });
  await flush();
  assert.equal(data.controls.jump, true, 'buoyancy was pressed');
  assert.equal(data.controls.forward, true, 'forward was pressed');
  controller.abort('paused');
  (data.adapter as unknown as { stopAll(): void }).stopAll();
  await assert.rejects(pending, { name: 'AbortedError' });
  release(); await Promise.resolve();
  assert.equal(data.controls.jump, false);
  assert.equal(data.controls.forward, false);
  assert.equal(data.controls.sprint, false);
  assert.deepEqual(Object.entries(data.controls).filter(([, on]) => on), [], 'no swim control key stays pressed');
});

test('session reset clears swim controls and a late physics wait cannot resume them', async (t) => {
  const data = scriptedSwimmer(t, {
    start: { x: 2.5, y: 62.4, z: 2.5 }, onGround: false, inWater: true,
    blockAt: (cell) => (cell.y >= 64 ? 'air' : cell.y >= 60 ? 'water' : 'stone'),
    onTick: () => {},
  });
  let release!: () => void;
  data.bot.waitForTicks = () => new Promise<void>((resolve) => { release = resolve; });
  const pending = data.adapter.swimTo({ x: 20.5, y: 64.4, z: 2.5 }, new AbortController().signal, { timeoutMs: 5000 });
  await flush();
  (data.adapter as unknown as { newSession(): void }).newSession(); // a real `end`/respawn path calls this
  release(); await Promise.resolve();
  await assert.rejects(pending, { name: 'AbortedError' });
  assert.equal(data.controls.jump, false);
  assert.equal(data.controls.forward, false);
  assert.equal(data.controls.sprint, false);
});

test('swim_to rejects an observed lava target without letting the water controller enter it', async () => {
  const a = new FakeAdapter();
  a.inWater = true;
  a.blocks.push({ name: 'lava', pos: { x: 10, y: 63, z: 0 } });
  const arbiter = new Arbiter(a, new WorldMemory(null), new EventBus(), new Vision(a));
  const done = new Promise<TaskOutcome>((resolve) => arbiter.once('done', resolve));
  assert.ok(!('error' in arbiter.start({ skill: 'swim_to', args: { xyz: { x: 10, y: 63, z: 0 } } }, 'llm')));
  const result = (await done).result;
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'BAD_ARGS');
  assert.equal(result.data?.unsupportedTarget, 'lava');
  assert.ok(!a.actions.some((action) => action.startsWith('swim:')), 'no water control was delegated');
});

// ---------------------------------------------------------------- mounted controls
function boatFixture(opts: { name?: string; vehicleId?: number } = {}) {
  const vehicleId = opts.vehicleId ?? 7, playerId = 42;
  const packets: { name: string; payload: any }[] = [];
  const client: any = new EventEmitter();
  client.write = (name: string, payload: any) => packets.push({ name, payload });
  const vehicle: any = { name: opts.name ?? 'boat', id: vehicleId, position: new Vec3(0, 64, 0), yaw: -Math.PI / 2, passengers: [playerId] };
  const bot: any = Object.assign(new EventEmitter(), {
    _client: client, game: { dimension: 'overworld' }, physicsEnabled: true, vehicle, entities: { [vehicleId]: vehicle },
    entity: { id: playerId, position: new Vec3(0, 64.4, 0), yaw: 0, pitch: 0 },
    blockAt: (pos: any) => ({ name: pos.y < 64 ? 'water' : 'air', boundingBox: 'empty', getProperties: () => ({}) }),
    waitForTicks() { assert.fail('mounted vehicles do not emit player physicsTick'); },
    clearControlStates() {}, deactivateItem() {}, pathfinder: { stop() {}, setGoal() {} },
    async look() {},
    moveVehicle(left: number, forward: number) {
      packets.push({ name: 'player_input', payload: { inputs: { forward: forward > 0, backward: forward < 0, left: left > 0, right: left < 0 } } });
    },
    dismount() {},
  });
  const adapter = new MineflayerAdapter(config, new EventBus());
  adapter.bot = bot; adapter.mcData = {}; Reflect.set(adapter, 'connectedFlag', true);
  return { adapter, bot, client, packets, vehicle };
}

test('cancelled boat ride releases both paddles and removes the server-correction listener', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  const w = boatFixture();
  const controller = new AbortController();
  const pending = w.adapter.ride({ x: 100, z: 0 }, controller.signal, { timeoutMs: 5000 });
  await flush();
  controller.abort('paused');
  w.adapter.stopAll();
  await assert.rejects(pending, { name: 'AbortedError' });
  const release = w.packets.filter((p) => p.name === 'steer_boat').at(-1)!;
  assert.deepEqual(release.payload, { leftPaddle: false, rightPaddle: false }, 'two paddle inputs released');
  assert.equal(w.client.listenerCount('vehicle_move'), 0, 'correction listener removed');
});

test('cancelled mounted (non-boat) ride releases all four movement inputs', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  const w = boatFixture({ name: 'horse' });
  const controller = new AbortController();
  const pending = w.adapter.ride({ x: 100, z: 0 }, controller.signal, { timeoutMs: 5000 });
  await flush();
  controller.abort('paused');
  w.adapter.stopAll();
  await assert.rejects(pending, { name: 'AbortedError' });
  const release = w.packets.filter((p) => p.name === 'player_input').at(-1)!;
  assert.deepEqual(release.payload.inputs, { forward: false, backward: false, left: false, right: false }, 'four direction inputs released');
});

test('server position correction resynchronises the locally-driven boat instead of accumulating', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  const advance = async (ms: number) => { t.mock.timers.tick(ms); await flush(); };
  const w = boatFixture();
  const pending = w.adapter.ride({ x: 100, z: 0 }, new AbortController().signal, { timeoutMs: 400 });
  await flush();
  w.client.emit('vehicle_move', { x: 5, y: 64, z: 0 });
  await advance(50); await advance(50);
  const moves = w.packets.filter((p) => p.name === 'vehicle_move');
  assert.ok(moves.length >= 1);
  const x = moves.at(-1)!.payload.x;
  assert.ok(x >= 4.9 && x < 6, `boat continues from the server-corrected position, got ${x}`);
  await advance(400);
  await pending;
});

test('repeated empty passenger broadcasts clear the stale vehicle only once', () => {
  const w = boatFixture();
  let dismounts = 0;
  w.bot.on('dismount', () => { dismounts++; });
  const sync = (w.adapter as unknown as { syncDismount(b: any, pk: any): void }).syncDismount.bind(w.adapter);
  sync(w.bot, { entityId: w.vehicle.id, passengers: [] });
  sync(w.bot, { entityId: w.vehicle.id, passengers: [] });
  assert.equal(dismounts, 1, 'a repeated broadcast cannot re-emit dismount');
  assert.equal(w.bot.vehicle, null);
  assert.equal(w.bot.physicsEnabled, true);
});

test('being dismounted during a ride stops it, restores physics and releases paddles/listener', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  const advance = async (ms: number) => { t.mock.timers.tick(ms); await flush(); };
  const w = boatFixture();
  const pending = w.adapter.ride({ x: 100, z: 0 }, new AbortController().signal, { timeoutMs: 2000 });
  await flush();
  w.bot.vehicle = null;
  w.bot.emit('dismount', w.vehicle);
  await advance(50);
  const r = await pending;
  assert.equal(r.reason, 'DISMOUNTED');
  assert.equal(w.bot.physicsEnabled, true);
  assert.equal(w.client.listenerCount('vehicle_move'), 0);
  assert.deepEqual(w.packets.filter((p) => p.name === 'steer_boat').at(-1)?.payload, { leftPaddle: false, rightPaddle: false });
});

test('session reset during a boat ride removes the correction listener and late broadcasts cannot move it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  const advance = async (ms: number) => { t.mock.timers.tick(ms); await flush(); };
  const w = boatFixture();
  const pending = w.adapter.ride({ x: 100, z: 0 }, new AbortController().signal, { timeoutMs: 2000 });
  const rejected = assert.rejects(pending, { name: 'AbortedError' });
  await flush();
  (w.adapter as unknown as { newSession(): void }).newSession();
  const newOwnerPosition = new Vec3(9, 64, 9);
  w.bot.vehicle.position = newOwnerPosition;
  w.client.emit('vehicle_move', { x: 1, y: 64, z: 1 });
  assert.deepEqual(w.bot.vehicle.position, newOwnerPosition, 'stale correction cannot overwrite the next session body');
  await advance(50);
  await rejected;
  assert.equal(w.client.listenerCount('vehicle_move'), 0);
});

test('dismount reports failure while the body still reports the same vehicle', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  const w = boatFixture();
  const pending = w.adapter.dismount(new AbortController().signal);
  await flush();
  t.mock.timers.tick(2600); await flush();
  const r = await pending;
  assert.equal(r.ok, false, 'adapter ok would contradict the still-mounted body');
  assert.equal(r.reason, 'DISMOUNT_FAILED');
  assert.equal(w.bot.vehicle, w.vehicle);
});

test('dismount succeeds only after the server removes the passenger and restores physics', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  const w = boatFixture();
  w.bot.dismount = () => { w.bot.vehicle = null; w.bot.emit('dismount', w.vehicle); };
  const r = await w.adapter.dismount(new AbortController().signal);
  assert.equal(r.ok, true);
  assert.equal(w.bot.vehicle, null);
  assert.equal(w.bot.physicsEnabled, true);
});

test('public dismount does not translate adapter ok into success while riding remains', async () => {
  const a = new FakeAdapter();
  a.riding = 'boat';
  (a as unknown as { dismount(): Promise<{ ok: boolean }> }).dismount = async () => ({ ok: true });
  const arbiter = new Arbiter(a, new WorldMemory(null), new EventBus(), new Vision(a));
  const done = new Promise<TaskOutcome>((resolve) => arbiter.once('done', resolve));
  assert.ok(!('error' in arbiter.start({ skill: 'dismount', args: {} }, 'llm')));
  const result = (await done).result;
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'EFFECT_NOT_CONFIRMED');
  assert.equal(result.data?.stillRiding, true);
  assert.equal(result.data?.disembarked, false);
  assert.equal(a.riding, 'boat');
});

test('travel with no swim controller fails the water leg instead of walking across it', async () => {
  const a = new FakeAdapter();
  for (let x = 10; x <= 20; x++) for (let z = -40; z <= 40; z++) a.blocks.push({ name: 'water', pos: { x, y: 63, z } });
  Reflect.set(a, 'swimTo', undefined);
  const arbiter = new Arbiter(a, new WorldMemory(null), new EventBus(), new Vision(a));
  const done = new Promise<TaskOutcome>((resolve) => arbiter.once('done', resolve));
  assert.ok(!('error' in arbiter.start({ skill: 'travel', args: { to: '30,0' } }, 'llm')));
  const result = (await done).result;
  assert.equal(result.status, 'failed');
  assert.match(result.summary, /NO_SWIM|没到指定岸/);
  assert.ok(a.pos.x < 10.5, `must not silently walk into the river: x=${a.pos.x}`);
  assert.ok(!a.actions.some((action) => action.startsWith('swim:')), 'no swim controller was available');
});

test('in-water target does not overshoot to the surface once jump is no longer needed', async (t) => {
  let ctrl: Record<string, boolean> = {};
  const data = scriptedSwimmer(t, {
    start: { x: 2.5, y: 60.5, z: 2.5 }, onGround: false, inWater: true,
    blockAt: (cell) => (cell.y >= 63 ? 'air' : cell.y >= 60 ? 'water' : 'stone'),
    onTick: (bot) => {
      bot.entity.position.y += ctrl.jump ? 0.5 : -0.15;
      bot.entity.isInWater = bot.entity.position.y < 62.8;
    },
  });
  ctrl = data.controls;
  const r = await data.adapter.swimTo({ x: 2.5, y: 62, z: 2.5 }, new AbortController().signal, { timeoutMs: 5000 });
  assert.equal(r.ok, true, `${r.reason} @ y=${data.bot.entity.position.y}`);
  assert.equal(r.goal, 'surface_target');
  assert.equal(r.stage, 'surface_reached');
  assert.ok(data.bot.entity.position.y < 62.8, `must stay in water instead of floating through the target: y=${data.bot.entity.position.y}`);
  assert.equal(data.controls.jump, false, 'no buoyancy key stays pressed after arrival');
});

test('blocked above reports the ceiling and the nearest open water column', async (t) => {
  const data = scriptedSwimmer(t, {
    start: { x: 2.5, y: 61.2, z: 2.5 }, onGround: false, inWater: true,
    blockAt: (cell) => {
      if (cell.x === 2 && cell.z === 2 && cell.y === 63) return 'netherrack';
      if (cell.x >= 3 && cell.x <= 3 && cell.z === 2 && cell.y >= 63) return 'air';
      if (cell.y >= 63) return 'air';
      return cell.y >= 60 ? 'water' : 'stone';
    },
    onTick: () => {},
  });
  const r = await data.adapter.swimTo({ x: 2, y: 64, z: 2 }, new AbortController().signal, { timeoutMs: 5000 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'SWIM_NO_PROGRESS');
  assert.deepEqual(r.blockedAbove, { x: 2, y: 63, z: 2, name: 'netherrack' }, 'the overhead block is reported, not hidden behind 游不动');
  assert.equal(r.openWater?.dir, 'E');
  assert.equal(r.openWater?.x, 3);
  assert.equal(r.openWater?.dist, 1, 'the open column next to the body is reported');
  assert.equal(r.targetOnEdge, true, 'integer x/z is reported as a block-boundary target');
});

test('rising toward an overhead water target counts as progress instead of a horizontal stall', async (t) => {
  let ctrl: Record<string, boolean> = {};
  const data = scriptedSwimmer(t, {
    start: { x: 2.5, y: 58.5, z: 2.5 }, onGround: false, inWater: true,
    blockAt: (cell) => (cell.y >= 71 ? 'air' : cell.y >= 58 ? 'water' : 'stone'),
    onTick: (bot) => {
      bot.entity.position.y += ctrl.jump ? 0.12 : -0.03;
      bot.entity.isInWater = bot.entity.position.y < 70.8;
    },
  });
  ctrl = data.controls;
  const r = await data.adapter.swimTo({ x: 2.5, y: 70, z: 2.5 }, new AbortController().signal, { timeoutMs: 20000 });
  assert.equal(r.ok, true, `${r.reason} @ y=${data.bot.entity.position.y}`);
  assert.equal(r.goal, 'surface_target');
  assert.ok(data.bot.entity.position.y >= 68.5, `must be allowed to ascend for more than 2.5s: y=${data.bot.entity.position.y}`);
});
