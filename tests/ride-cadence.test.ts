import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';

const { Vec3 } = createRequire(import.meta.url)('vec3');
const flush = async () => { await setImmediate(); };

// Clock, packets and ownership only; no game or vehicle physics simulation.
function fixture() {
  const packets: { name: string; payload: any }[] = [];
  const client: any = new EventEmitter();
  client.write = (name: string, payload: any) => packets.push({ name, payload });
  const bot: any = { _client: client, game: { dimension: 'overworld' }, physicsEnabled: true,
    vehicle: { name: 'boat', position: new Vec3(0, 64, 0) }, entity: { position: new Vec3(0, 64.4, 0) },
    blockAt: (pos: any) => ({ name: pos.y < 64 ? 'water' : 'air', boundingBox: 'empty' }),
    waitForTicks() { assert.fail('mounted vehicles do not emit player physicsTick'); },
    clearControlStates() {}, deactivateItem() {}, pathfinder: { stop() {}, setGoal() {} },
  };
  const adapter = new MineflayerAdapter(config, new EventBus());
  adapter.bot = bot; adapter.mcData = {}; (adapter as any).connectedFlag = true;
  return { adapter, bot, client, packets };
}

test('mounted ride uses an independent bounded cadence, preserves new ownership and restores physics after dismount', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  const advance = async (ms: number) => { t.mock.timers.tick(ms); await flush(); };
  const w = fixture(), start = Date.now();
  const pending = w.adapter.ride({ x: 8, z: 0 }, new AbortController().signal, { timeoutMs: 125 });
  await flush();
  assert.equal(w.bot.physicsEnabled, false);
  await advance(50); await advance(50); await advance(25);
  const result = await pending;
  assert.equal(result.reason, 'TIMEOUT');
  assert.equal(Date.now() - start, 125, 'a short budget must not expand to one second');
  assert.equal(w.packets.filter((p) => p.name === 'vehicle_move').length, 3, 'input continues without any physicsTick');
  assert.equal(w.packets.at(-1)?.payload.leftPaddle, false);
  assert.equal(w.client.listenerCount('vehicle_move'), 0);

  const owned = fixture(), ownedController = new AbortController();
  const ownedRide = owned.adapter.ride({ x: 8, z: 0 }, ownedController.signal, { timeoutMs: 2000 });
  await flush(); ownedController.abort('cancelled');
  assert.equal(owned.packets.at(-1)?.payload.leftPaddle, false, 'abort must release input synchronously before stopAll changes ownership');
  owned.adapter.stopAll();
  await assert.rejects(ownedRide, { name: 'AbortedError' });

  const cancelled = fixture(), controller = new AbortController();
  const oldRide = cancelled.adapter.ride({ x: 8, z: 0 }, controller.signal, { timeoutMs: 2000 });
  await flush(); cancelled.adapter.stopAll();
  cancelled.bot.vehicle.position = new Vec3(100, 64, 0);
  cancelled.client.emit('vehicle_move', { x: 2, y: 64, z: 0 });
  assert.equal(cancelled.bot.vehicle.position.x, 100, 'stale resync callbacks cannot overwrite the new owner position');
  cancelled.client.write('steer_boat', { leftPaddle: true, rightPaddle: true });
  const before = cancelled.packets.length;
  controller.abort('replaced');
  await assert.rejects(oldRide, { name: 'AbortedError' });
  await advance(100);
  assert.equal(cancelled.packets.length, before, 'late cleanup must not stop the next owner paddles');
  assert.equal(cancelled.client.listenerCount('vehicle_move'), 0);

  const dismounted = fixture();
  const losingRide = dismounted.adapter.ride({ x: 8, z: 0 }, new AbortController().signal, { timeoutMs: 2000 });
  await flush(); dismounted.bot.vehicle = null;
  await advance(50);
  assert.equal((await losingRide).reason, 'DISMOUNTED');
  assert.equal(dismounted.bot.physicsEnabled, true);
});

test('boat ride ignores the server echoing the boat moves back to its own passenger (no double speed)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  const w = fixture();
  w.bot.vehicle.yaw = -Math.PI / 2; // 船头朝东（+x）
  // 服务器把船的每次移动当 rel_entity_move 广播回来，mineflayer 会再加一遍到 vehicle.position 上
  let lastX = 0;
  const write = w.client.write;
  w.client.write = (name: string, payload: any) => {
    write(name, payload);
    if (name === 'vehicle_move') { const d = payload.x - lastX; lastX = payload.x; queueMicrotask(() => { w.bot.vehicle.position = w.bot.vehicle.position.offset(d, 0, 0); }); }
  };
  const pending = w.adapter.ride({ x: 100, z: 0 }, new AbortController().signal, { timeoutMs: 1000 });
  for (let i = 0; i < 21; i++) { t.mock.timers.tick(50); await flush(); await flush(); }
  const r = await pending;
  const moves = w.packets.filter((p) => p.name === 'vehicle_move');
  const x = moves.at(-1)!.payload.x;
  // 原版式加速：20 刻约 3.4 格；要是把服务器的回显也算进去，会翻倍还越滚越快
  assert.ok(x > 2.5 && x < 4.2, `1 秒只该划出 3 格多，实际 ${x.toFixed(2)}；${r.reason}`);
  const steps = moves.map((p, i) => p.payload.x - (i ? moves[i - 1].payload.x : 0));
  assert.ok(steps.every((s) => s <= 0.29), `每刻不超过 0.28 格：${steps.map((s) => s.toFixed(2)).join(' ')}`);
});

test('boat ride checks the whole hull: grazing a bank corner stops it quickly instead of being pulled back by the server', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 });
  const w = fixture();
  w.bot.vehicle.position = new Vec3(0.5, 64, 0.5);
  w.bot.vehicle.yaw = -Math.PI / 2; // 船头朝东
  // 船心沿 z=0.5 往东走，船身探到 z=1.19；(3,64,1) 这块岸角会蹭到船舷
  w.bot.blockAt = (pos: any) => {
    const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z);
    if (x === 3 && y === 64 && z === 1) return { name: 'stone', boundingBox: 'block' };
    return { name: y < 64 ? 'water' : 'air', boundingBox: 'empty' };
  };
  const pending = w.adapter.ride({ x: 10.5, z: 0.5 }, new AbortController().signal, { timeoutMs: 5000 });
  for (let i = 0; i < 101 && !(await Promise.race([pending.then(() => true), flush().then(() => false)])); i++) { t.mock.timers.tick(50); await flush(); }
  const r = await pending;
  assert.equal(r.blocked, true, JSON.stringify(r));
  const xs = w.packets.filter((p) => p.name === 'vehicle_move').map((p) => p.payload.x);
  assert.ok(Math.max(...xs) <= 3 - 0.69 + 1e-6, `船身不能压进岸角：最远 x=${Math.max(...xs).toFixed(2)}`);
  assert.ok(Date.now() - 1_700_000_000_000 < 4000, '卡住一秒多就该放弃，不是干等十秒');
});
