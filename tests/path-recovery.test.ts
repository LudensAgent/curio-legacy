import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';

const { Vec3 } = createRequire(import.meta.url)('vec3');
const flush = async () => { await setImmediate(); };

// Local collision/ownership fixtures only: no server or simulated game ticks.
function fixture() {
  const blocks = new Map<string, string | null>(), controls: Record<string, boolean> = {}, dug: string[] = [];
  const bot: any = {
    entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0, onGround: true }, game: { dimension: 'overworld' },
    blockAt(pos: any) {
      const position = pos.floored(), key = position.toString();
      const name = blocks.has(key) ? blocks.get(key) : position.y < 64 ? 'stone' : 'air';
      if (name === null) return null;
      const empty = name === 'air' || name === 'short_grass' || name === 'water';
      return { name, position, boundingBox: empty ? 'empty' : 'block', shapes: empty ? [] : [[0, 0, 0, 1, 1, 1]] };
    },
    canDigBlock: () => true,
    async dig(block: any) { dug.push(block.name); blocks.set(block.position.toString(), 'air'); },
    setControlState(key: string, value: boolean) { controls[key] = value; },
    clearControlStates() { for (const key of Object.keys(controls)) controls[key] = false; },
    pathfinder: { stop() {}, setGoal() {} },
  };
  const adapter = new MineflayerAdapter(config, new EventBus());
  adapter.bot = bot;
  const controller = new AbortController();
  const opts = { signal: controller.signal, timeoutMs: 20000 };
  const put = (x: number, y: number, z: number, name: string | null) => blocks.set(new Vec3(x, y, z).toString(), name);
  return { adapter, bot, controls, dug, opts, controller, put };
}

function clock(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 });
  return async (ms: number) => { t.mock.timers.tick(ms); await flush(); };
}

test('path correction clears an actual soft collision only with explicit terrain permission', async (t) => {
  const advance = clock(t), w = fixture();
  w.put(0, 65, -1, 'oak_leaves');
  const ordinary = (w.adapter as any).nudge(new Set(), w.opts);
  await advance(150);
  assert.match(await ordinary, /向左/);
  assert.deepEqual(w.dug, [], 'ordinary travel never digs its way through foliage or structures');
  assert.match(await (w.adapter as any).nudge(new Set(), { ...w.opts, allowTerrainChanges: true }), /oak_leaves/);
  assert.deepEqual(w.dug, ['oak_leaves']);
});

test('a confirmed one-block step permits a short jump; construction uses a supported crouched sidestep', async (t) => {
  const advance = clock(t), w = fixture();
  w.put(0, 64, -1, 'stone');
  const jump = (w.adapter as any).nudge(new Set(), w.opts);
  assert.equal(w.controls.jump, true); assert.equal(w.controls.forward, true);
  await advance(180);
  assert.match(await jump, /台阶/);
  assert.equal(w.controls.jump, false); assert.equal(w.controls.forward, false);
  const safe = (w.adapter as any).nudge(new Set(), { ...w.opts, constructionSafe: true, allowTerrainChanges: true });
  assert.equal(w.controls.sneak, true); assert.equal(w.controls.left, true);
  assert.equal(w.controls.jump, false);
  await advance(250);
  assert.match(await safe, /向左/);
  assert.deepEqual(w.dug, []);
});

test('corrections reject unknown, hazardous and unsupported routes rather than blindly backing off', async () => {
  for (const obstacle of [null, 'water', 'air']) {
    const w = fixture();
    for (const [x, z] of [[-1, 0], [1, 0], [0, 1]]) w.put(x, 63, z, obstacle);
    w.put(0, 65, -1, 'stone');
    assert.equal(await (w.adapter as any).nudge(new Set(), w.opts), null, String(obstacle));
    assert.deepEqual(w.controls, {});
  }
});

test('cancelled correction cannot release the next action owner controls', async (t) => {
  clock(t);
  const w = fixture(), pending = (w.adapter as any).nudge(new Set(), w.opts);
  assert.equal(w.controls.left, true);
  w.adapter.stopAll();
  w.bot.setControlState('left', true);
  w.controller.abort('replaced');
  await assert.rejects(pending, { name: 'AbortedError' });
  assert.equal(w.controls.left, true);
});

test('stale path watchdog and timeout never stop the next owner', async (t) => {
  const advance = clock(t), w = fixture();
  let stops = 0;
  w.bot.pathfinder = { goto: () => new Promise(() => {}), isMoving: () => true, stop() { stops++; }, setGoal() {} };
  const pending = (w.adapter as any).gotoUnstalled({}, { ...w.opts, timeoutMs: 4000 }, (w.adapter as any).actionCheckpoint(w.opts.signal));
  const rejected = assert.rejects(pending, { name: 'TimeoutError' });
  w.adapter.stopAll();
  const previousStops = stops;
  w.bot.setControlState('forward', true);
  await advance(4500); await rejected;
  assert.equal(stops, previousStops);
  assert.equal(w.controls.forward, true);
});

test('failed corrections are bounded at one obstruction and reset after real route progress', async (t) => {
  const advance = clock(t);
  for (const progress of [false, true]) {
    const w = fixture();
    let corrections = 0, rejectPath: (e: Error) => void = () => {};
    w.bot.pathfinder = { goto: () => new Promise((_, reject) => { rejectPath = reject; }), isMoving: () => true,
      stop() { rejectPath(new Error('Path was stopped')); }, setGoal() {} };
    (w.adapter as any).nudge = async () => {
      corrections++;
      if (progress && corrections === 2) w.bot.entity.position = w.bot.entity.position.offset(2, 0, 0);
      return '侧挪';
    };
    let finished = false;
    const pending = (w.adapter as any).gotoUnstalled({}, w.opts, (w.adapter as any).actionCheckpoint(w.opts.signal));
    const rejected = assert.rejects(pending, /No path/).then(() => { finished = true; });
    for (let i = 0; i < 7 && !finished; i++) await advance(2700);
    await rejected;
    assert.equal(corrections, progress ? 5 : 3);
  }
});

test('standing over an edge, the bot sneaks back onto the block it actually stands on before planning a path', async () => {
  const w = fixture();
  w.put(1, 63, 0, 'air');
  w.bot.entity.position = new Vec3(1.15, 64, 0.5);
  const events: string[] = [];
  (w.adapter as any).bus.on('event', (e: any) => events.push(e.type));
  const sneaked: boolean[] = [];
  const set = w.bot.setControlState.bind(w.bot);
  w.bot.setControlState = (key: string, value: boolean) => {
    set(key, value);
    if (key === 'forward' && value) { sneaked.push(!!w.controls.sneak); w.bot.entity.position = new Vec3(0.55, 64, 0.5); }
  };
  w.bot.look = async () => {};
  let startedAt: any = null;
  w.bot.pathfinder = { goto: async () => { startedAt = w.bot.entity.position.clone(); }, isMoving: () => false, stop() {}, setGoal() {} };
  assert.deepEqual((w.adapter as any).edgeSupport(), { x: 0, z: 0 });
  await (w.adapter as any).gotoUnstalled({}, w.opts, (w.adapter as any).actionCheckpoint(w.opts.signal));
  assert.deepEqual(sneaked, [true], 'sneaking cannot walk off the edge');
  assert.ok(Math.abs(startedAt.x - 0.5) < 0.1, 'the path starts from the supporting block centre');
  assert.equal(w.controls.forward, false);
  assert.equal(w.controls.sneak, false);
  assert.ok(events.includes('path_steady'));
  w.bot.entity.position = new Vec3(0.5, 64, 0.5);
  assert.equal((w.adapter as any).edgeSupport(), null, 'a centred stance needs no correction');
});
