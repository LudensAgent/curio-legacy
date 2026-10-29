import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';

const require = createRequire(import.meta.url);
const { Vec3 } = require('vec3');

function fixture(x = 0.8) {
  const data = require('minecraft-data')('1.20.1'), Block = require('prismarine-block')(data);
  const cells = new Map<string, string | null>(), controls: Record<string, boolean> = {};
  const bot: any = new EventEmitter();
  bot.registry = data; bot.game = { dimension: 'overworld' };
  bot.entity = { position: new Vec3(x, 64, 0.5), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, onGround: true,
    isInWater: false, isInLava: false, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: false, effects: {}, attributes: {} };
  bot.inventory = { items: () => [{ name: 'cobblestone' }], slots: [] };
  bot.setControlState = (key: string, value: boolean) => { controls[key] = value; };
  bot.getControlState = (key: string) => !!controls[key];
  bot.clearControlStates = () => { for (const key of Object.keys(controls)) controls[key] = false; };
  bot.equip = async () => {}; bot.look = async () => {}; bot.placeBlock = async () => {};
  bot.blockAt = (pos: any) => {
    const p = pos.floored(), key = `${p.x},${p.y},${p.z}`;
    const name = cells.has(key) ? cells.get(key) : p.y < 64 ? 'stone' : 'air';
    if (!name) return null;
    const block = Block.fromStateId(data.blocksByName[name].defaultState, 0); block.position = p; return block;
  };
  const adapter = new MineflayerAdapter(config, new EventBus());
  adapter.bot = bot; adapter.mcData = data; (adapter as any).connectedFlag = true;
  const put = (x: number, y: number, z: number, name: string | null) => cells.set(`${x},${y},${z}`, name);
  return { bot, adapter, controls, put, data };
}

test('actual body width detects an adjacent ceiling even when the centre column is empty', () => {
  const w = fixture(); w.put(1, 66, 0, 'stone');
  assert.deepEqual((w.adapter as any).pillarClearance(), { kind: 'blocked', min: { x: 0, y: 65, z: 0 }, max: { x: 1, y: 66, z: 0 } });
  w.bot.entity.position.x = 0.5;
  assert.equal((w.adapter as any).pillarClearance(), null);
  w.bot.entity.position.x = 0.8; w.put(1, 66, 0, null);
  assert.deepEqual((w.adapter as any).pillarClearance(), { kind: 'unknown', min: { x: 0, y: 65, z: 0 }, max: { x: 1, y: 66, z: 0 } });
});

test('clearance uses partial collision shapes and ignores blocks above the swept height', () => {
  const w = fixture();
  w.put(1, 66, 0, 'stone_slab');
  assert.equal((w.adapter as any).pillarClearance()?.kind, 'blocked');
  w.put(1, 66, 0, 'air'); w.put(1, 67, 0, 'stone');
  assert.equal((w.adapter as any).pillarClearance(), null);
});

test('actual 1.20.1 physics demonstrates the adjacent ceiling obstruction', () => {
  const { Physics, PlayerState } = require('prismarine-physics');
  for (const x of [0.5, 0.8]) {
    const w = fixture(x); w.put(1, 66, 0, 'stone');
    const world = { getBlock: w.bot.blockAt }, physics = Physics(w.data, world);
    w.bot.version = '1.20.1'; w.bot.jumpTicks = 0; w.bot.jumpQueued = false; w.bot.fireworkRocketDuration = 0;
    const controls = { forward: false, back: false, left: false, right: false, jump: true, sprint: false, sneak: false };
    let highest = 64;
    for (let i = 0; i < 20; i++) {
      physics.simulatePlayer(new PlayerState(w.bot, controls), world).apply(w.bot);
      highest = Math.max(highest, w.bot.entity.position.y);
    }
    assert.equal(highest >= 65.02, x === 0.5, `jump from x=${x} peaked at ${highest}`);
  }
});

test('explicit pillar refuses an obstructed jump before toggling jump or placing', async () => {
  const w = fixture(); w.put(1, 66, 0, 'stone');
  const result = await w.adapter.pillarUp(['cobblestone'], new AbortController().signal);
  assert.equal(result.reason, 'NOT_PLACED:头顶跳跃空间受阻');
  assert.match(result.clearanceDetail!, /x=0\.\.1, y=65\.\.66, z=0\.\.0/);
  assert.match(result.clearanceDetail!, /具体障碍位置和方块名称未确认/);
  assert.doesNotMatch(result.clearanceDetail!, /stone/);
  assert.notEqual(w.controls.jump, true);
});

test('goto stops a blocked Pathfinder tower after its planned digging and before the next physics step', async () => {
  const w = fixture();
  let rejectPath: (error: Error) => void = () => {}, stopped = false;
  w.bot.pathfinder = { goto: () => new Promise((_, reject) => { rejectPath = reject; }), isBuilding: () => true,
    stop() { stopped = true; }, setGoal() { w.bot.clearControlStates(); rejectPath(new Error('GoalChanged')); } };
  const signal = new AbortController().signal;
  const pending = (w.adapter as any).gotoUnstalled({ x: 0, y: 70, z: 0 }, { signal, timeoutMs: 3000 }, (w.adapter as any).actionCheckpoint(signal));
  // The earlier Pathfinder physicsTick listener has finished the planned dig
  // and selected jump-to-place; the adjacent ceiling is still present.
  w.put(1, 66, 0, 'stone'); w.bot.setControlState('jump', true); w.bot.emit('physicsTick');
  // 搭柱被头顶挡住：先停下寻路、清掉 jump，再退半步重规划；mock 的 pathfinder 不会二次前进，最终以超时收场
  await assert.rejects(pending);
  assert.equal(stopped, true);
  assert.equal(w.controls.jump, false);
  assert.equal(w.bot.listenerCount('physicsTick'), 0);
});

test('installed Pathfinder schedules tower jump before the adapter listener stops it', async () => {
  const w = fixture(); w.put(1, 66, 0, 'stone');
  w.bot.entities = {}; w.bot.entity.id = 1;
  w.bot.inventory.items = () => [{ name: 'cobblestone', type: w.data.itemsByName.cobblestone.id, count: 8 }];
  w.bot.world = { getBlock: w.bot.blockAt };
  require('mineflayer-pathfinder').pathfinder(w.bot);
  const movements = w.bot.pathfinder.movements;
  movements.allow1by1towers = true;
  movements.allowEntityDetection = false;
  movements.getNeighbors = function (node: any) { const next: any[] = []; this.getMoveUp(node, next); return next; };
  w.bot.pathfinder.setMovements(movements);
  const signal = new AbortController().signal;
  const pending = (w.adapter as any).gotoUnstalled(new (require('mineflayer-pathfinder').goals.GoalBlock)(0, 65, 0),
    { signal, timeoutMs: 3000 }, (w.adapter as any).actionCheckpoint(signal));
  w.bot.emit('physicsTick');
  await assert.rejects(pending);
  assert.equal(w.controls.jump, false);
  assert.equal(w.bot.pathfinder.goal, null);
  assert.equal(w.bot.listenerCount('physicsTick'), 1, 'only the permanent Pathfinder listener remains');
});

test('aborting before a tower jump removes the clearance listener and cannot stop a later control owner', async () => {
  const w = fixture(); w.put(1, 66, 0, 'stone');
  w.bot.pathfinder = { goto: () => new Promise(() => {}), isBuilding: () => true, stop() {}, setGoal() {} };
  const controller = new AbortController();
  const pending = (w.adapter as any).gotoUnstalled({ x: 0, y: 65, z: 0 },
    { signal: controller.signal, timeoutMs: 3000 }, (w.adapter as any).actionCheckpoint(controller.signal));
  controller.abort();
  await assert.rejects(pending, { name: 'AbortedError' });
  assert.equal(w.bot.listenerCount('physicsTick'), 0);
  w.bot.setControlState('jump', true);
  w.bot.emit('physicsTick');
  assert.equal(w.controls.jump, true);
});
