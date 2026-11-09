import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';

const require = createRequire(import.meta.url);
const { Vec3 } = require('vec3');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const data = require('minecraft-data')('1.20.1');
const Block = require('prismarine-block')(data);

/**
 * 仿线上 02:05 的下界：起点 (0,64,0) 往南（+z）。射线 x=0 下面全是岩浆；x=6 有一条南北向的岩石通道，
 * 起点处有一段东西向的连接。射线上的段终点 (0,20) 在岩浆上，走到它 3 格内的路不存在；沿通道能往南推进 20 格。
 */
function netherWorld() {
  const floor = (x: number, z: number) => (z === 0 && x >= 0 && x <= 6) || (x === 6 && z >= 0 && z <= 24);
  const bot: any = Object.assign(new EventEmitter(), {
    registry: data, version: '1.20.1', game: { dimension: 'the_nether' }, entities: {},
    entity: { position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), onGround: true, height: 1.8 },
    inventory: { items: () => [], slots: [] },
    blockAt: (pos: any) => {
      const p = pos.floored();
      if (Math.abs(p.x) > 40 || Math.abs(p.z) > 40) return null;
      const name = p.y === 63 ? (floor(p.x, p.z) ? 'netherrack' : 'lava') : p.y < 63 ? 'netherrack' : 'air';
      const block = Block.fromStateId(data.blocksByName[name].defaultState, 0);
      block.position = p;
      return block;
    },
  });
  pathfinder(bot);
  const movements = new Movements(bot);
  movements.canDig = false; movements.allow1by1towers = false; movements.scafoldingBlocks = []; movements.allowParkour = false;
  const lava = data.blocksByName.lava.id;
  movements.liquids.delete(lava); movements.replaceables.delete(lava); movements.blocksCantBreak.add(lava);
  const search = (goal: unknown) => {
    const { value } = bot.pathfinder.getPathFromTo(movements, bot.entity.position, goal, { searchRadius: 48, timeout: 5000 }).next();
    return value.result as { status: string; path: { x: number; y: number; z: number }[] };
  };
  return { bot, search };
}

/** 让适配器按 MoveTarget 造出真实的 pathfinder 目标，截下来交给真 A* 搜索。 */
async function adapterGoal(target: Parameters<MineflayerAdapter['moveTo']>[0]) {
  const adapter = new MineflayerAdapter(config, new EventBus());
  let captured: unknown;
  adapter.bot = {
    ...new EventEmitter(), entity: { position: new Vec3(0.5, 64, 0.5), onGround: true }, game: { dimension: 'the_nether' },
    pathfinder: { goto: async (goal: unknown) => { captured = goal; throw new Error('captured'); }, stop() {}, setGoal() {} },
  };
  adapter.mcData = {};
  Reflect.set(adapter, 'connectedFlag', true);
  await adapter.moveTo(target, { signal: new AbortController().signal, timeoutMs: 1000 }).catch(() => {});
  assert.ok(captured, '适配器把目标交给了 pathfinder');
  return captured;
}

test('段终点在岩浆上：按点找路无路，按沿方向推进能沿旁边的通道走出 17 格', async () => {
  const w = netherWorld();
  const point = w.search(new goals.GoalNearXZ(0, 20, 3));
  assert.equal(point.status, 'noPath', '射线上那个点 3 格内没有能站的地方');

  const goal = await adapterGoal({ kind: 'advance', origin: { x: 0.5, z: 0.5 }, dir: { x: 0, z: 1 }, minAlong: 17, maxLateral: 16 });
  const advance = w.search(goal);
  assert.equal(advance.status, 'success');
  const end = advance.path.at(-1)!;
  assert.equal(Math.floor(end.x), 6, '沿 x=6 的通道走');
  assert.ok(end.z + 0.5 - 0.5 >= 17, `沿方向推进到 ${end.z}`);
});

test('沿方向推进不接受横向偏离超出范围的站位', async () => {
  const w = netherWorld();
  const goal = await adapterGoal({ kind: 'advance', origin: { x: 0.5, z: 0.5 }, dir: { x: 0, z: 1 }, minAlong: 17, maxLateral: 4 });
  assert.equal(w.search(goal).status, 'noPath', '通道离射线 6 格，超出 4 格的横向范围就不算');
});
