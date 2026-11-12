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
function blockAt(p: Vec3, fire = false) {
  const portal = p.z === -256 && p.x >= -498 && p.x <= -497 && p.y >= 79 && p.y <= 81;
  const frame = p.z === -256 && (p.x === -499 || p.x === -496 || p.y === 78 || p.y === 82) && p.x >= -499 && p.x <= -496 && p.y >= 78 && p.y <= 82;
  const step = p.z === -255 && p.y === 78 && p.x >= -499 && p.x <= -496;
  const burning = fire && p.z >= -254 && p.z <= -253 && p.y >= 78 && p.y <= 79;
  const name = portal ? 'nether_portal' : frame || step ? 'obsidian' : burning ? 'fire' : p.y <= 77 ? 'grass_block' : 'air';
  const block = portal ? Block.fromProperties('nether_portal', { axis: 'x' }, 0) : Block.fromStateId(data.blocksByName[name].defaultState, 0);
  block.position = p;
  return block;
}

async function enterFrom(feet: Vec3, opts: { fire?: boolean } = {}) {
  const world = { getBlock: (position: Vec3) => blockAt(position.floored(), opts.fire) };
  const controls: Record<string, boolean> = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  const entity = {
    position: feet.clone(), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, height: 1.8, eyeHeight: 1.62,
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
  let driveCalls = 0;
  const realDrive = driver.drive.bind(driver);
  Reflect.set(driver, 'drive', (...args: Parameters<typeof realDrive>) => { driveCalls += 1; return realDrive(...args); });
  const started = Date.now();
  let result: Awaited<ReturnType<MineflayerAdapter['enterPortalAt']>> | undefined;
  try {
    result = await driver.enterPortalAt({ x: -498, y: 79, z: -256 }, abort.signal).catch(() => undefined);
  } finally {
    clearInterval(timer);
    clearInterval(watcher);
  }
  return { entered: abort.signal.aborted, at: entity.position.clone(), result, driveCalls, ms: Date.now() - started };
}

test('真实物理：门前站位高一级时，进门的直推会跳上台阶并压进门方块', { timeout: 30_000 }, async () => {
  const result = await enterFrom(new Vec3(-497.5, 78, -253.3));
  assert.equal(result.entered, true, `身体没有压进门方块，停在 ${result.at}`);
  assert.ok(result.at.y >= 79 - 0.05, '跳上了门前台阶');
});

test('真实物理：导航没送到站位时，从斜前方几格外直接走到站位再进门', { timeout: 30_000 }, async () => {
  const result = await enterFrom(new Vec3(-494.5, 78, -251.5));
  assert.equal(result.entered, true, `身体没有压进门方块，停在 ${result.at}`);
});

test('真实物理：门前火带让推进每拍都被拒绝时，如实交回而不是空转到期限', { timeout: 20_000 }, async () => {
  const r = await enterFrom(new Vec3(-497.5, 78, -252.3), { fire: true });
  assert.equal(r.entered, false, '身体不应压进门方块');
  assert.equal(r.result?.ok, false);
  assert.match(String(r.result?.reason), /^ENTRY_BLOCKED:/, `回执应写明受阻原因，实际 ${r.result?.reason}`);
  assert.ok(r.driveCalls <= 12, `被拒的推进不该反复重试，实际调用 drive ${r.driveCalls} 次`);
  assert.ok(r.ms < 8000, `不该耗满推进期限，实际 ${r.ms}ms`);
});
