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
