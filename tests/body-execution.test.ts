import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Vec3 } from 'vec3';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import type { MoveOpts, NavigationDelegate } from '../src/adapter/types.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';

function botAt(x: number, y: number, z: number) {
  const controls: Record<string, boolean> = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  const writes: string[] = [];
  const bot: any = Object.assign(new EventEmitter(), {
    entity: {
      position: new Vec3(x, y, z), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0,
      onGround: true, isInWater: false, isInLava: false, eyeHeight: 1.62,
    },
    game: { dimension: 'overworld' }, vehicle: null,
    setControlState(name: string, value: boolean) { controls[name] = value; writes.push(`${name}:${value}`); },
    clearControlStates() { for (const key of Object.keys(controls)) controls[key] = false; },
    async look() {},
    blockAt: () => null,
  });
  return { bot, controls, writes };
}

function adapterWith(bot: any) {
  const adapter = new MineflayerAdapter(config, new EventBus());
  adapter.bot = bot;
  adapter.mcData = {};
  Reflect.set(adapter, 'connectedFlag', true);
  return adapter;
}

function opts(signal = new AbortController().signal): MoveOpts {
  return { signal, timeoutMs: 3000 };
}

test('没有绑定导航委托时非本地 moveTo 明确失败，不直走或回退旧后端', async () => {
  const { bot } = botAt(0.5, 64, 0.5);
  const adapter = adapterWith(bot);
  await assert.rejects(
    adapter.moveTo({ kind: 'near', pos: { x: 3, y: 64, z: 0.5 }, range: 1 }, opts()),
    (error: Error) => /NAVIGATION_UNAVAILABLE/.test(error.message),
  );
  assert.equal(bot.entity.position.x, 0.5, '没有委托时不得直走');
});

test('非本地 moveTo 的 sprint 请求通过异步执行作用域传给委托内的 feet 控制', async () => {
  const { bot, controls, writes } = botAt(0.5, 64, 0.5);
  const adapter = adapterWith(bot);
  const delegate: NavigationDelegate = {
    async navigate(_target, moveOpts) {
      // 委托内部派发逐段 feet；sprint 只能来自外层 moveTo 的执行作用域。
      await adapter.moveTo({ kind: 'feet', x: 0.5, y: 64, z: 0.5 }, { signal: moveOpts.signal, timeoutMs: 1000 });
    },
  };
  await adapter.withNavigation!(delegate, () => adapter.moveTo(
    { kind: 'near', pos: { x: 1, y: 64, z: 0.5 }, range: 1 },
    { ...opts(), sprint: true },
  ));
  assert.ok(writes.includes('sprint:true'), `实际控制写入：${writes.join(',')}`);
  assert.equal(writes.at(-1) === 'sprint:false' || controls.sprint, true, '动作结束时 sprint 必须被释放');
  assert.equal(controls.sprint, false);
});

test('梯子上行：只按住 jump，到位后释放并实测脚高', async () => {
  const { bot, controls, writes } = botAt(0.5, 64, 0.5);
  const original = bot.setControlState;
  bot.setControlState = (name: string, value: boolean) => {
    original(name, value);
    if (name === 'jump' && value) setTimeout(() => { bot.entity.position = new Vec3(0.5, 65, 0.5); }, 25);
  };
  const adapter = adapterWith(bot);
  await adapter.moveTo({ kind: 'ladder', x: 0, y: 65, z: 0 }, opts());
  assert.equal(bot.entity.position.y, 65);
  assert.equal(controls.jump, false, '到位后必须松开 jump');
  assert.ok(writes.includes('jump:true'));
  assert.ok(!writes.includes('forward:true'), '同列上行不按前进键，避免离开梯子列');
});

test('梯子下行：按住 sneak，到位后释放并实测脚高', async () => {
  const { bot, controls } = botAt(0.5, 66, 0.5);
  const original = bot.setControlState;
  bot.setControlState = (name: string, value: boolean) => {
    original(name, value);
    if (name === 'sneak' && value) setTimeout(() => { bot.entity.position = new Vec3(0.5, 64, 0.5); }, 25);
  };
  const adapter = adapterWith(bot);
  await adapter.moveTo({ kind: 'ladder', x: 0, y: 64, z: 0 }, opts());
  assert.equal(bot.entity.position.y, 64);
  assert.equal(controls.sneak, false, '到位后必须松开 sneak');
});

test('明确相邻下行：走离支撑后落地到所选列，不跳不挖不放', async () => {
  const { bot, controls, writes } = botAt(0.5, 64, 0.5);
  const original = bot.setControlState;
  bot.setControlState = (name: string, value: boolean) => {
    original(name, value);
    if (name === 'forward' && value) {
      setTimeout(() => {
        bot.entity.position = new Vec3(1.5, 63.4, 0.5);
        bot.entity.onGround = false;
      }, 20);
      setTimeout(() => {
        bot.entity.position = new Vec3(1.5, 62, 0.5);
        bot.entity.onGround = true;
      }, 60);
    }
  };
  const adapter = adapterWith(bot);
  await adapter.moveTo({ kind: 'xyz', x: 1, y: 62, z: 0 }, { ...opts(), maxDropDown: 3, allowSwimming: false });
  assert.equal(bot.entity.position.y, 62);
  assert.equal(Math.floor(bot.entity.position.x), 1);
  assert.equal(controls.forward, false);
  assert.ok(!writes.includes('jump:true'), '受控下落不额外起跳');
});

test('梯子攀爬被取消后不再写按键', async () => {
  const { bot, controls, writes } = botAt(0.5, 64, 0.5);
  const original = bot.setControlState;
  bot.setControlState = (name: string, value: boolean) => {
    original(name, value);
    if (name === 'jump' && value) setTimeout(() => { bot.entity.position = new Vec3(0.5, 64.3, 0.5); }, 25);
  };
  const adapter = adapterWith(bot);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(adapter.moveTo({ kind: 'ladder', x: 0, y: 66, z: 0 }, { signal: controller.signal, timeoutMs: 3000 }), { name: 'AbortedError' });
  const after = writes.length;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(writes.length, after, `取消后不得再写控制：${writes.slice(after).join(',')}`);
  assert.equal(controls.jump, false, '取消后必须释放本次持有的 jump');
});
