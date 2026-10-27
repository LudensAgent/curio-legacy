import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeBridge } from '../src/codeskills/bridge.ts';
import { EventBus } from '../src/events.ts';

const world: Record<string, string> = { '0,64,6': 'iron_ore', '0,64,7': 'diamond_ore', '0,64,1': 'coal_ore', '0,70,6': 'air' };
const ctx: any = { bus: new EventBus(),
  adapter: {
    state: () => ({ pos: { x: 0.5, y: 64, z: 0.5 } }), eye: () => ({ x: 0.5, y: 65.62, z: 0.5, yaw: 0, pitch: 0 }),
    blockAt: (p: any) => world[`${p.x},${p.y},${p.z}`] ?? 'stone',
  },
  // 只亲眼见过 (0,64,6) 那块铁矿；(0,64,7) 的钻石矿埋在里面没露出来
  senses: { refresh() {}, recognizedAt: (p: any) => (p.x === 0 && p.y === 64 && p.z === 6 ? 'iron_ore' : null) },
};

test('技能的 api.blockAt / region 不透视：没看见过的实心方块只知道是实心，不知道是什么', async () => {
  const api = makeBridge(ctx);
  assert.deepEqual(await api('blockAt', [0, 64, 6]), { name: 'iron_ore', kind: 'solid' });
  assert.deepEqual(await api('blockAt', [0, 64, 7]), { name: null, kind: 'solid' }, '埋着的钻石矿认不出');
  assert.deepEqual(await api('blockAt', [0, 64, 1]), { name: 'coal_ore', kind: 'solid' }, '手边摸得到的认得出');
  assert.deepEqual(await api('blockAt', [0, 70, 6]), { name: 'air', kind: 'open' });
  const reg = await api('region', [0, 64, 5, 0, 64, 8]) as any;
  assert.ok(reg.palette.includes('iron_ore'));
  assert.ok(!reg.palette.includes('diamond_ore'));
  assert.ok(reg.palette.includes('solid?'));
  assert.equal(reg.kinds[reg.palette.indexOf('solid?')], 'solid');
});
