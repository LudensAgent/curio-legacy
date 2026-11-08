import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import type { UseItemOptions } from '../src/adapter/types.ts';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Vision } from '../src/perception/vision.ts';
import { useEndGateway } from '../src/skills/travel.ts';
import { travelStore } from '../src/travel/store.ts';
import { FakeAdapter } from './fake-adapter.ts';

function fixture(duration = 2500) {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), signal = new AbortController().signal;
  adapter.dim = 'the_end'; adapter.speed = 100000; adapter.inv.set('ender_pearl', 4);
  memory.setWorld(adapter.state().worldId);
  const pos = { x: 3, y: 64, z: 0 };
  adapter.blocks.push({ name: 'end_gateway', pos });
  const endpoint = travelStore(memory).observe(adapter.state(), pos, 'end_gateway');
  const context = { adapter, memory, senses: new Vision(adapter), bus: new EventBus(), signal, deadline: Date.now() + duration, taskId: 'gateway-regression', progress() {} };
  return { adapter, memory, endpoint, context };
}

test('gateway retries an ignored item cooldown only after readback and retains its supported side pose', async () => {
  const { adapter, memory, endpoint, context } = fixture();
  const attempts: number[] = [], poses: any[] = [];
  adapter.useItem = async (_item, _signal, options: UseItemOptions = {}) => {
    attempts.push(Date.now()); poses.push(adapter.state().pos);
    assert.deepEqual(options.aim, { x: 3.5, y: 64.5, z: 0.5 });
    if (attempts.length > 1) { adapter.inv.set('ender_pearl', 3); adapter.pos = { x: 1003, y: 64, z: 0 }; }
    return { ok: true };
  };
  const result = await useEndGateway.run(context, { portalId: endpoint.id });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(attempts.length, 2);
  assert.ok(attempts[1] - attempts[0] >= 1200);
  assert.equal(result.data?.throwAttempts, 2);
  assert.equal(result.data?.pearlConsumed, true);
  assert.deepEqual(poses[0], { x: 0.5, y: 64, z: 0.5 }, 'the near-gateway shortcut must not replace the safe three-block side cell');
  assert.equal(travelStore(memory).snapshot(adapter.worldId).gateways.length, 1);
});

test('a consumed pearl that misses the gateway is never blindly thrown again', async () => {
  const { adapter, memory, endpoint, context } = fixture(1600);
  let attempts = 0;
  adapter.useItem = async () => { attempts++; adapter.inv.set('ender_pearl', 3); return { ok: true }; };
  const result = await useEndGateway.run(context, { portalId: endpoint.id });
  assert.equal(result.failureCode, 'TIMEOUT');
  assert.equal(attempts, 1);
  assert.equal(result.data?.pearlConsumed, true);
  assert.deepEqual(travelStore(memory).snapshot(adapter.worldId).gateways, []);
});

test('teleport packets can prove arrival before a delayed inventory update without an extra throw', async () => {
  const { adapter, endpoint, context } = fixture();
  let attempts = 0;
  adapter.useItem = async () => { attempts++; adapter.pos = { x: 1003, y: 64, z: 0 }; return { ok: true }; };
  const result = await useEndGateway.run(context, { portalId: endpoint.id });
  assert.equal(result.status, 'succeeded');
  assert.equal(attempts, 1);
});

test('gateway movement rejects unsafe support and cancellation never records an arrival', async () => {
  const unsafe = fixture();
  unsafe.adapter.blockAt = (pos) => pos.y === 63 ? 'lava' : pos.x === 3 && pos.y === 64 && pos.z === 0 ? 'end_gateway' : 'air';
  assert.equal((await useEndGateway.run(unsafe.context, { portalId: unsafe.endpoint.id })).failureCode, 'NOT_FOUND');
  assert.ok(!unsafe.adapter.actions.some((action) => action.startsWith('use:')));
  const cancelled = fixture(), controller = new AbortController();
  cancelled.adapter.useItem = async () => { controller.abort(); return { ok: true }; };
  await assert.rejects(useEndGateway.run({ ...cancelled.context, signal: controller.signal }, { portalId: cancelled.endpoint.id }), { name: 'AbortedError' });
  assert.deepEqual(travelStore(cancelled.memory).snapshot(cancelled.adapter.worldId).gateways, []);
});

function aimedAdapter(abortOnTick = false, blocked = false) {
  const require = createRequire(import.meta.url), { Vec3 } = require('vec3');
  const events: string[] = [], controller = new AbortController();
  const adapter = new MineflayerAdapter(config, new EventBus());
  adapter.bot = { entity: { position: new Vec3(0, 64, 0), eyeHeight: 1.62 }, game: { dimension: 'the_end' },
    inventory: { items: () => [{ name: 'ender_pearl', count: 2 }] }, blockAt: () => ({ name: 'air' }),
    world: { raycast: () => blocked ? { position: new Vec3(1, 65, 0) } : null },
    equip: async () => { events.push('equip'); }, lookAt: async (_point: any, force: boolean) => { assert.equal(force, true); events.push('force_both_axes'); },
    waitForTicks: async () => { events.push('aim_packet'); if (abortOnTick) controller.abort(); }, activateItem: () => { events.push('use'); } };
  adapter.mcData = {}; (adapter as any).connectedFlag = true;
  return { adapter, controller, events };
}

test('aimed item use verifies the clear ray and sends both aim axes before activation', async () => {
  const { adapter, controller, events } = aimedAdapter();
  assert.equal((await adapter.useItem('ender_pearl', controller.signal, { aim: { x: 3.5, y: 66.5, z: 0.5 } })).ok, true);
  assert.deepEqual(events, ['equip', 'force_both_axes', 'aim_packet', 'use']);
  const blocked = aimedAdapter(false, true);
  assert.equal((await blocked.adapter.useItem('ender_pearl', blocked.controller.signal, { aim: { x: 3.5, y: 66.5, z: 0.5 } })).reason, 'BLOCKED_AIM');
  assert.ok(!blocked.events.includes('use'));
  const cancelled = aimedAdapter(true);
  await assert.rejects(cancelled.adapter.useItem('ender_pearl', cancelled.controller.signal, { aim: { x: 3.5, y: 66.5, z: 0.5 } }), { name: 'AbortedError' });
  assert.ok(!cancelled.events.includes('use'));
});
