import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';

const require = createRequire(import.meta.url);
const Vec3 = require('vec3').Vec3;

/** 一个最小的“坐在船上”的假 bot：dismount() 时服务器回 set_passengers(船, [])——mineflayer 自己不认这种包 */
function ridingBot(opts: { serverReplies: 'passengers' | 'teleport' | 'nothing' }) {
  const bot: any = new EventEmitter();
  const boat = { id: 7, name: 'oak_boat', position: new Vec3(0, 62, 0), passengers: [] as any[] };
  bot.entity = { id: 1, position: new Vec3(0, 62.4, 0) };
  boat.passengers.push(bot.entity);
  bot.entities = { 7: boat };
  bot.vehicle = boat;
  bot.physicsEnabled = false;
  bot._client = new EventEmitter();
  bot.dismount = () => {
    if (opts.serverReplies === 'passengers') setTimeout(() => bot._client.emit('set_passengers', { entityId: 7, passengers: [] }), 5);
    if (opts.serverReplies === 'teleport') bot.entity.position = new Vec3(1.5, 63, 0.5);
  };
  return { bot, boat };
}

function adapterWith(bot: any) {
  const adapter = new MineflayerAdapter(config, new EventBus());
  adapter.bot = bot; adapter.mcData = {}; (adapter as any).connectedFlag = true;
  // connect() 里挂的 set_passengers 补丁：测试不走 connect，这里照样挂上
  bot._client.on('set_passengers', (pk: any) => (adapter as any).syncDismount(bot, pk));
  return adapter;
}

test('dismount succeeds when the server drops the bot from the boat passenger list', async () => {
  const { bot } = ridingBot({ serverReplies: 'passengers' });
  const adapter = adapterWith(bot);
  let dismounted = 0; bot.on('dismount', () => dismounted++);
  const r = await adapter.dismount(new AbortController().signal);
  assert.deepEqual(r, { ok: true });
  assert.equal(bot.vehicle, null);
  assert.equal(bot.physicsEnabled, true);
  assert.equal(dismounted, 1);
});

test('dismount falls back to position when no event arrives but the server moved the bot off the boat', async () => {
  const { bot } = ridingBot({ serverReplies: 'teleport' });
  const adapter = adapterWith(bot);
  const r = await adapter.dismount(new AbortController().signal);
  assert.equal(r.ok, true);
  assert.equal(bot.vehicle, null);
  assert.equal(bot.physicsEnabled, true);
});

test('dismount still reports failure while the bot is really in the boat', async () => {
  const { bot, boat } = ridingBot({ serverReplies: 'nothing' });
  const adapter = adapterWith(bot);
  const r = await adapter.dismount(new AbortController().signal);
  assert.deepEqual(r, { ok: false, reason: 'DISMOUNT_FAILED' });
  assert.equal(bot.vehicle, boat);
});

test('a set_passengers update for another vehicle, or one that still lists the bot, leaves riding state alone', () => {
  const { bot, boat } = ridingBot({ serverReplies: 'nothing' });
  adapterWith(bot);
  bot._client.emit('set_passengers', { entityId: 99, passengers: [] });
  bot._client.emit('set_passengers', { entityId: 7, passengers: [1, 5] });
  assert.equal(bot.vehicle, boat);
  assert.equal(bot.physicsEnabled, false);
});
