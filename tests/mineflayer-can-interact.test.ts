import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { Vec3 } from 'vec3';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';

const require = createRequire(import.meta.url);
const data = require('minecraft-data')('1.20.1');
const Block = require('prismarine-block')(data);
const WorldSync = require('prismarine-world/src/worldsync.js');

/** 真实方块形状 + prismarine-world 的同步射线；地面 y=77 石头。 */
function adapterAt(feet: Vec3Like3, placed: { pos: Vec3Like3; name: string; props: Record<string, unknown> }[]) {
  const blocks = new Map(placed.map((entry) => [`${entry.pos.x},${entry.pos.y},${entry.pos.z}`, Block.fromProperties(entry.name, entry.props, 0)]));
  const world = {
    getBlock(position: Vec3) {
      const p = position.floored();
      const block = blocks.get(`${p.x},${p.y},${p.z}`) ?? Block.fromStateId(data.blocksByName[p.y <= 77 ? 'stone' : 'air'].defaultState, 0);
      block.position = p;
      return block;
    },
  };
  const bot = Object.assign(new EventEmitter(), {
    version: '1.20.1', entity: { position: new Vec3(feet.x, feet.y, feet.z), eyeHeight: 1.62, onGround: true },
    blockAt: (pos: Vec3) => world.getBlock(pos),
    world: { raycast: (from: Vec3, direction: Vec3, range: number) => WorldSync.prototype.raycast.call(world, from, direction, range) },
  });
  const driver = new MineflayerAdapter(config, new EventBus());
  driver.bot = bot as unknown as NonNullable<MineflayerAdapter['bot']>;
  driver.mcData = data;
  Reflect.set(driver, 'connectedFlag', true);
  return driver;
}
type Vec3Like3 = { x: number; y: number; z: number };

const chest = { pos: { x: -498, y: 78, z: -255 }, name: 'chest', props: { facing: 'north', type: 'single', waterlogged: false } };
const bed = { pos: { x: -495, y: 78, z: -254 }, name: 'red_bed', props: { facing: 'south', part: 'foot', occupied: false } };

test('交互可达按眼睛到方块面的真实距离射线确认：两格外的箱子、站在箱子上、斜对角的床', () => {
  assert.equal(adapterAt({ x: -496.5, y: 78, z: -254.5 }, [chest]).canInteractAt(chest.pos), true, '东侧两格外的箱子');
  assert.equal(adapterAt({ x: -497.36, y: 78.875, z: -254.5 }, [chest]).canInteractAt(chest.pos), true, '站在箱子顶上低头');
  assert.equal(adapterAt({ x: -495.5, y: 78, z: -254.5 }, [bed]).canInteractAt(bed.pos), true, '斜对角的床');
});

test('超出交互距离或被实心方块挡住时仍然拒绝', () => {
  assert.equal(adapterAt({ x: -492.5, y: 78, z: -254.5 }, [chest]).canInteractAt(chest.pos), false, '五格外');
  const wall = [-497, -496].flatMap((x) => [78, 79, 80].flatMap((y) => [-256, -255, -254].map((z) => ({ pos: { x, y, z }, name: 'stone', props: {} }))));
  assert.equal(adapterAt({ x: -495.5, y: 78, z: -254.5 }, [chest, ...wall]).canInteractAt(chest.pos), false, '隔着石墙');
});
