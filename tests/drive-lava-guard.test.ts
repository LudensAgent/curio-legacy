import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';

const require = createRequire(import.meta.url), Vec3 = require('vec3').Vec3;
const registry = require('minecraft-data')('1.20.1');

function fixture(blocks: Record<string, string>) {
  const pressed = new Set<string>();
  const bot: any = {
    game: { dimension: 'the_nether' }, entities: {}, inventory: { items: () => [] },
    // 面朝北（yaw 0），按 back 往南（+z）退。
    entity: { position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, onGround: true, height: 1.8 },
    blockAt: (p: any) => {
      const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
      return { name: blocks[k] ?? 'air', position: p };
    },
    setControlState(k: string, v: boolean) { if (v) pressed.add(k); else pressed.delete(k); },
    clearControlStates() { pressed.clear(); }, lookAt() {}, pathfinder: { stop() {}, setGoal() {} },
  };
  const adapter = new MineflayerAdapter(config, new EventBus());
  adapter.bot = bot; adapter.mcData = registry; (adapter as any).connectedFlag = true;
  return { adapter, bot, pressed };
}

test('drive 的身体本能：后退时前方脚下空、往下一格是岩浆，起步就停，不退下去', async () => {
  // 站在 (0,63,0) 上；身后 z=1 那列 y63 是空的，y62 是岩浆（一级台阶下面的岩浆池）。
  const { adapter } = fixture({ '0,63,0': 'netherrack', '0,62,1': 'lava', '0,61,1': 'netherrack' });
  const r = await adapter.drive({ back: true }, 300, new AbortController().signal);
  assert.equal(r.stopped, 'lava', JSON.stringify(r));
});

test('drive 的身体本能：前方下面是实心地（一级台阶）照常走，不误判', async () => {
  const { adapter } = fixture({ '0,63,0': 'netherrack', '0,62,1': 'netherrack' });
  const r = await adapter.drive({ back: true }, 120, new AbortController().signal);
  assert.equal(r.stopped, undefined, JSON.stringify(r));
});
