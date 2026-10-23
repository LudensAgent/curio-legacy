import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { CATS, DEFAULT_VISION, Vision } from '../src/perception/vision.ts';

const require = createRequire(import.meta.url);
const data = require('minecraft-data')('1.20.1');
const Block = require('prismarine-block')(data);
const Vec3 = require('vec3').Vec3;
const WorldSync = require('prismarine-world/src/worldsync.js');
const defaultBar = data.blocksByName.iron_bars.defaultState;
const key = (p: any) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;

function fixture(z = 0.2, registry = data) {
  const cells = new Map<string, number>();
  let unknownX: number | null = null;
  const getBlock = (p: any) => {
    if (Math.floor(p.x) === unknownX) return null;
    const state = cells.get(key(p)) ?? data.blocksByName[p.y < 64 ? 'stone' : 'air'].defaultState;
    if (!data.blocksByStateId[state]) return null;
    const block = Block.fromStateId(state, 0); block.position = p.floored(); return block;
  };
  const bot: any = {
    registry, username: 'OpticsCheck', health: 20, food: 20, oxygenLevel: 20, time: { timeOfDay: 1000, isDay: true },
    game: { dimension: 'the_end' }, entity: { id: 1, position: new Vec3(0.5, 64, z), eyeHeight: 1.62, yaw: -Math.PI / 2, pitch: 0, onGround: true },
    inventory: { items: () => [], slots: [], emptySlotCount: () => 36 }, entities: {}, blockAt: getBlock,
    world: { getColumnAt: (p: any) => Math.floor(p.x) === unknownX ? null : {},
      getBlockStateId: (p: any) => cells.get(key(p)) ?? data.blocksByName[p.y < 64 ? 'stone' : 'air'].defaultState,
      getBlockLight: () => 15, getSkyLight: () => 15 },
  };
  const adapter = new MineflayerAdapter({ ...config, memory: { ...config.memory, worldId: 'iron-bars-optics-test' } }, new EventBus());
  adapter.bot = bot; adapter.mcData = registry;
  Object.assign(adapter, { connectedFlag: true, spawned: true, dimension: 'the_end' });
  const vision = new Vision(adapter, { ...DEFAULT_VISION, range: 16, cols: 1, rows: 1, bandCols: 0, bandRows: 0 });
  const put = (name: string, x: number, y: number, z: number, state = data.blocksByName[name].defaultState) => cells.set(`${x},${y},${z}`, state);
  for (let y = 64; y <= 68; y++) put('iron_bars', 3, y, 0);
  put('iron_ore', 6, 65, 0);
  return { adapter, bot, vision, put, unknown: (x: number) => { unknownX = x; },
    physicalRay: () => WorldSync.prototype.raycast.call({ getBlock }, new Vec3(0.5, 65.62, z), new Vec3(1, 0, 0), 16) };
}

test('real 1.20.1 iron-bar states resolve distinct connected collision shapes and cache by state', () => {
  const { adapter, put } = fixture();
  const isolated = adapter.blockOptics(3, 65, 0)!;
  assert.equal(isolated.kind, 'solid');
  assert.deepEqual(isolated.shapes, [[0.4375, 0, 0.4375, 0.5625, 1, 0.5625]]);
  let northSouth = -1;
  for (let state = data.blocksByName.iron_bars.minStateId; state <= data.blocksByName.iron_bars.maxStateId; state++) {
    const props = Block.fromStateId(state, 0).getProperties();
    if (props.north && props.south && !props.east && !props.west && !props.waterlogged) { northSouth = state; break; }
  }
  assert.ok(northSouth >= 0);
  put('iron_bars', 3, 65, 0, northSouth);
  const connected = adapter.blockOptics(3, 65, 0)!;
  assert.deepEqual(connected.shapes, [[0.4375, 0, 0, 0.5625, 1, 1]]);
  assert.notStrictEqual(connected, isolated);
  put('iron_bars', 3, 65, 0, defaultBar);
  assert.strictEqual(adapter.blockOptics(3, 65, 0), isolated);
});

test('visual first hits agree with installed world raycasting for an iron-bar gap and its opaque rod', () => {
  const gap = fixture(0.2);
  gap.vision.scan();
  assert.equal(gap.physicalRay().name, 'iron_ore');
  assert.equal(CATS[gap.vision.frame!.cats[0]], 'ore');
  assert.equal(gap.vision.knownBlocks(['iron_ore'], 16).length, 1);
  const rod = fixture(0.5);
  rod.vision.scan();
  assert.equal(rod.physicalRay().name, 'iron_bars');
  assert.notEqual(CATS[rod.vision.frame!.cats[0]], 'ore');
  assert.equal(rod.vision.knownBlocks(['iron_ore'], 16).length, 0);
  assert.ok(rod.vision.knownBlocks(['iron_bars'], 16).length > 0, 'only an actually hit bar becomes a known gathering target');
});

test('a crystal is visible through geometric gaps while a rod, full wall or unknown column still blocks it', () => {
  const crystal = (world: ReturnType<typeof fixture>) => {
    world.bot.entities[42] = { id: 42, name: 'end_crystal', type: 'other', position: new Vec3(6.5, 64.62, world.bot.entity.position.z), height: 2 };
    world.vision.scan(); return world.vision.perceivedEntities(16).some(e => e.id === 42);
  };
  assert.equal(crystal(fixture(0.2)), true);
  assert.equal(crystal(fixture(0.5)), false);
  const wall = fixture(0.2);
  for (let y = 64; y <= 68; y++) wall.put('stone', 5, y, 0);
  assert.equal(crystal(wall), false);
  const unknown = fixture(0.2); unknown.unknown(5);
  assert.equal(crystal(unknown), false);
});

test('missing iron-bar shape metadata remains opaque and unregistered block states remain unknown', () => {
  const world = fixture(0.2, { ...data, blockCollisionShapes: { blocks: {}, shapes: {} } });
  assert.deepEqual(world.adapter.blockOptics(3, 65, 0), { name: 'iron_bars', kind: 'solid' });
  world.vision.scan();
  assert.equal(world.vision.knownBlocks(['iron_ore'], 16).length, 0);
  world.put('iron_bars', 3, 65, 0, 9999999);
  assert.equal(world.adapter.blockOptics(3, 65, 0), null);
});
