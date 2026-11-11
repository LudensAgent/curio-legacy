import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { Vec3 } from 'vec3';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { bodyOverlapsPortal } from '../src/perception/portal.ts';

const require = createRequire(import.meta.url);
const data = require('minecraft-data')('1.20.1');
const Block = require('prismarine-block')(data);
const { Physics, PlayerState } = require('prismarine-physics');

/**
 * 门框：z=-256 一排，x=-499/-496 与 y=78/82 为黑曜石，内部 x=-498..-497、y=79..81 为下界门方块。
 * 门前 z=-255 一排是黑曜石台面（站位脚高 79），其余地面是 y=77 草方块（脚高 78），低一级。
 */
function blockAt(p: Vec3) {
  const portal = p.z === -256 && p.x >= -498 && p.x <= -497 && p.y >= 79 && p.y <= 81;
  const frame = p.z === -256 && (p.x === -499 || p.x === -496 || p.y === 78 || p.y === 82) && p.x >= -499 && p.x <= -496 && p.y >= 78 && p.y <= 82;
  const step = p.z === -255 && p.y === 78 && p.x >= -499 && p.x <= -496;
  const name = portal ? 'nether_portal' : frame || step ? 'obsidian' : p.y <= 77 ? 'grass_block' : 'air';
  const block = portal ? Block.fromProperties('nether_portal', { axis: 'x' }, 0) : Block.fromStateId(data.blocksByName[name].defaultState, 0);
  block.position = p;
  return block;
}

test('真实物理：门前站位高一级时，进门的直推会跳上台阶并压进门方块', { timeout: 30_000 }, async () => {
  const world = { getBlock: (position: Vec3) => blockAt(position.floored()) };
  const controls: Record<string, boolean> = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  const entity = {
    position: new Vec3(-497.5, 78, -253.3), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, height: 1.8, eyeHeight: 1.62,
    onGround: true, isInWater: false, isInLava: false, isInWeb: false,
    isCollidedHorizontally: false, isCollidedVertically: false, effects: {}, attributes: {},
  };
  const bot = Object.assign(new EventEmitter(), {
    version: '1.20.1', entity, controls, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, entities: {},
    inventory: { slots: [] }, vehicle: null, game: { dimension: 'overworld' }, health: 20, food: 20, oxygenLevel: 20,
    blockAt: (pos: Vec3) => world.getBlock(pos),
    setControlState(name: string, value: boolean) { controls[name] = value; },
    clearControlStates() { Object.keys(controls).forEach((key) => { controls[key] = false; }); },
    async look(yaw: number, pitch: number) { entity.yaw = yaw; entity.pitch = pitch; },
    async lookAt(point: Vec3) { entity.yaw = Math.atan2(-(point.x - entity.position.x), -(point.z - entity.position.z)); },
  });
  const driver = new MineflayerAdapter(config, new EventBus());
  driver.bot = bot as unknown as NonNullable<MineflayerAdapter['bot']>;
  driver.mcData = data;
  Reflect.set(driver, 'connectedFlag', true);
  // 这里只验证接近与进门的身体控制：状态读取用最小可信快照代替完整客户端。
  Reflect.set(driver, 'state', () => ({ observationReady: true, connected: true, alive: true, dim: 'overworld', worldId: 'w', sessionId: 's', pos: { ...entity.position } }));
  Reflect.set(driver, 'transitionProbe', () => ({ connected: true, alive: true, dim: 'overworld', sessionId: 's', observationReady: true }));
  const physics = Physics(data, world);
  const timer = setInterval(() => {
    physics.simulatePlayer(new PlayerState(bot, controls), world).apply(bot);
    bot.emit('physicsTick');
  }, 50);
  const inPortal = () => bodyOverlapsPortal((p) => world.getBlock(new Vec3(p.x, p.y, p.z)).name, entity.position, ['nether_portal']);
  const abort = new AbortController();
  const watcher = setInterval(() => { if (inPortal()) abort.abort(); }, 50);
  try {
    await driver.enterPortalAt({ x: -498, y: 79, z: -256 }, abort.signal).catch(() => undefined);
  } finally {
    clearInterval(timer);
    clearInterval(watcher);
  }
  assert.equal(abort.signal.aborted, true, `身体没有压进门方块，停在 (${entity.position.x.toFixed(2)},${entity.position.y.toFixed(2)},${entity.position.z.toFixed(2)})`);
  assert.ok(entity.position.y >= 79 - 0.05, '跳上了门前台阶');
});
