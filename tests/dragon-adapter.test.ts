import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';

const require = createRequire(import.meta.url);
const Vec3 = require('vec3').Vec3;

test('dragon melee targets the actual parent body id and never fabricates a multipart id or head hit', async () => {
  const adapter = new MineflayerAdapter(config, new EventBus());
  const dragon = { id: 44, name: 'ender_dragon', isValid: true, position: new Vec3(2, 64, 0), height: 8, yaw: 1 };
  const attacked: number[] = [];
  const aims: any[] = [];
  adapter.bot = { entity: { position: new Vec3(0, 64, 0), eyeHeight: 1.62 }, entities: { 44: dragon }, game: { dimension: 'the_end' },
    lookAt: async (point: any) => { aims.push(point); }, attack: (target: any) => { attacked.push(target.id); } };
  adapter.mcData = {}; (adapter as any).connectedFlag = true;
  assert.equal(await adapter.attack(44, new AbortController().signal), true);
  assert.deepEqual(attacked, [44]);
  assert.deepEqual({ x: aims[0].x, y: aims[0].y, z: aims[0].z }, { x: 2, y: 65.5, z: 0 });
  dragon.position = new Vec3(20, 64, 0);
  assert.equal(await adapter.attack(44, new AbortController().signal), false);
  assert.deepEqual(attacked, [44]);
});

test('bow release uses the current observed target pose and waits for its aim to reach the server', async () => {
  const adapter = new MineflayerAdapter(config, new EventBus());
  const target = { id: 44, name: 'ender_dragon', isValid: true, position: new Vec3(12, 65, 0), height: 8, velocity: new Vec3(0, 0, 0) };
  const events: string[] = [], aims: any[] = [];
  adapter.bot = { entity: { position: new Vec3(0, 64, 0) }, entities: { 44: target }, game: { dimension: 'the_end' },
    inventory: { items: () => [{ name: 'bow' }, { name: 'arrow' }] },
    equip: async () => {}, lookAt: async (point: any) => { aims.push(point); events.push('aim'); },
    activateItem: () => { events.push('draw'); target.position = new Vec3(20, 66, 3); },
    waitForTicks: async () => { events.push('aim_sent'); }, deactivateItem: () => { events.push('release'); } };
  adapter.mcData = {}; (adapter as any).connectedFlag = true;
  const result = await adapter.rangedAttack(44, new AbortController().signal);
  assert.equal(result.ok, true);
  assert.equal(aims[0].x, 12);
  assert.equal(aims[1].x, 20);
  assert.equal(aims[1].z, 3);
  assert.deepEqual(events.slice(-3), ['aim', 'aim_sent', 'release']);
});
