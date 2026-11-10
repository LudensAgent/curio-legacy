import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
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

function continuousBody(drop: number, surface = { name: 'dirt_path', props: {} }, repeated = false) {
  const require = createRequire(import.meta.url);
  const data = require('minecraft-data')('1.20.1');
  const Block = require('prismarine-block')(data);
  const { Physics, PlayerState } = require('prismarine-physics');
  const surfaceBlock = Block.fromProperties(surface.name, surface.props, 0);
  const top = Math.max(...surfaceBlock.shapes.map((shape: number[]) => shape[4]!));
  const from = { x: -494.37228723784824, y: 99 + top, z: -291.4394734980101 };
  const world = {
    getBlock(position: Vec3) {
      const p = position.floored();
      const surfaceY = p.x <= -495 ? 99 : 99 - drop * (repeated ? p.x + 495 : 1);
      const stateId = p.y === surfaceY ? surfaceBlock.stateId : data.blocksByName[p.y < surfaceY ? 'stone' : 'air'].defaultState;
      const block = Block.fromStateId(stateId, 0);
      block.position = p;
      return block;
    },
  };
  const { bot, controls, writes } = botAt(from.x, from.y, from.z);
  Object.assign(bot.entity, { effects: {}, attributes: {}, isInWeb: false, isCollidedHorizontally: false, isCollidedVertically: false });
  Object.assign(bot, { version: '1.20.1', jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, inventory: { slots: [] }, blockAt: world.getBlock });
  const looks: number[] = [];
  bot.look = async (yaw: number, pitch: number) => { looks.push(yaw); bot.entity.yaw = yaw; bot.entity.pitch = pitch; };
  const physics = Physics(data, world);
  for (let tick = 0; tick < 2; tick++) physics.simulatePlayer(new PlayerState(bot, controls), world).apply(bot);
  const frames: { x: number; speed: number; ground: boolean }[] = [];
  const timer = setInterval(() => {
    physics.simulatePlayer(new PlayerState(bot, controls), world).apply(bot);
    bot.emit('physicsTick');
    frames.push({ x: bot.entity.position.x, speed: Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z), ground: bot.entity.onGround });
  }, 50);
  timer.unref();
  return { bot, controls, writes, looks, timer, frames, from, to: { x: from.x + 1, y: from.y - drop, z: from.z } };
}

for (const surface of [
  { name: 'dirt_path', props: {} },
  { name: 'oak_slab', props: { type: 'bottom', waterlogged: false } },
  { name: 'snow', props: { layers: 4 } },
]) {
  test(`feet 的显式多格下落保留负坐标和 ${surface.name} 连续落点，真实碰撞形状落稳`, async (t) => {
    const { bot, controls, writes, timer, to } = continuousBody(2, surface);
    t.after(() => clearInterval(timer));
    await adapterWith(bot).moveTo({ kind: 'feet', ...to }, { ...opts(), timeoutMs: 6000, maxDropDown: 2 });
    assert.ok(Math.hypot(bot.entity.position.x - to.x, bot.entity.position.z - to.z) <= 0.12, `实测 ${bot.entity.position}`);
    assert.equal(bot.entity.position.y, to.y);
    assert.equal(bot.entity.onGround, true);
    assert.ok(Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z) < 0.003);
    assert.equal(controls.forward, false);
    assert.ok(!writes.includes('jump:true'));
  });
}

test('feet 默认拒绝多格下落；显式下落上限不扩大上行和水平跳跃能力', async () => {
  for (const [dy, extra] of [[-2, {}], [2, { maxDropDown: 4 }], [-2, { maxDropDown: 4, horizontalJump: true }]] as const) {
    const { bot, writes } = botAt(-494.37, 99.9375, -291.44);
    await assert.rejects(adapterWith(bot).moveTo({ kind: 'feet', x: -493.37, y: 99.9375 + dy, z: -291.44 }, { ...opts(), ...extra }), /NOT_CONFIRMED/);
    assert.ok(!writes.includes('forward:true'));
  }
});

test('连续多格下落取消后松开控制，保留空中实测位置', async () => {
  const { bot, controls, writes } = botAt(-494.37, 99.9375, -291.44);
  const controller = new AbortController();
  const original = bot.setControlState;
  bot.setControlState = (name: string, value: boolean) => {
    original(name, value);
    if (name === 'forward' && value) setTimeout(() => {
      bot.entity.position = new Vec3(-493.6, 99.2, -291.44);
      bot.entity.onGround = false;
      controller.abort();
    }, 25);
  };
  await assert.rejects(adapterWith(bot).moveTo({ kind: 'feet', x: -493.37, y: 97.9375, z: -291.44 }, { ...opts(controller.signal), maxDropDown: 2 }), { name: 'AbortedError' });
  assert.equal(bot.entity.position.y, 99.2);
  assert.equal(controls.forward, false);
  const count = writes.length;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(writes.length, count);
});

for (const drop of [0, -1]) {
  test(`连续四步 dirt_path ${drop === 0 ? '步行' : '上台阶'}：微调实测越位时不转身，保持落稳`, async (t) => {
    const { bot, timer, from, looks, writes, controls } = continuousBody(drop, undefined, true);
    t.after(() => clearInterval(timer));
    const adapter = adapterWith(bot);
    for (let step = 1; step <= 4; step++) {
      const to = { x: from.x + step, y: from.y - drop * step, z: from.z };
      await adapter.moveTo({ kind: 'feet', ...to }, { ...opts(), timeoutMs: 6000 });
      assert.ok(Math.hypot(bot.entity.position.x - to.x, bot.entity.position.z - to.z) <= 0.12);
      assert.equal(bot.entity.position.y, to.y);
      assert.equal(bot.entity.onGround, true);
    }
    assert.equal(looks.length, 4, '每段只定向一次，不为制动后的微调反复转向');
    assert.ok(looks.every((yaw) => Math.abs(yaw + Math.PI / 2) < 0.01), `朝向 ${looks}`);
    if (drop === 0) assert.ok(writes.includes('back:true'), '真实越位仍经过后退短脉冲纠正');
    assert.ok(Object.values(controls).every((pressed) => !pressed));
  });
}

test('16 格连续脚位没有中间停车帧，并与同世界持续前进对照', async (t) => {
  const route = continuousBody(0);
  t.after(() => clearInterval(route.timer));
  const adapter = adapterWith(route.bot);
  const started = performance.now();
  let beforeFinal = 0;
  for (let step = 1; step <= 16; step++) {
    if (step === 16) beforeFinal = route.frames.length;
    await adapter.moveTo({ kind: 'feet', x: route.from.x + step, y: route.from.y, z: route.from.z }, {
      ...opts(), timeoutMs: 6000, settleAtTarget: step === 16,
    });
  }
  const routeMs = performance.now() - started;
  const stoppedMiddleFrames = route.frames.slice(0, beforeFinal).filter(frame => frame.speed < 0.003).length;
  assert.equal(stoppedMiddleFrames, 0, '中间点不能再经过速度归零再起步');
  clearInterval(route.timer);

  const native = continuousBody(0);
  t.after(() => clearInterval(native.timer));
  const nativeAdapter = adapterWith(native.bot);
  await native.bot.look(-Math.PI / 2, 0);
  const nativeStarted = performance.now();
  native.bot.setControlState('forward', true);
  while (native.bot.entity.position.x - native.from.x < 16 && performance.now() - nativeStarted < 10_000) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await nativeAdapter.settleMovement({ ...opts(), timeoutMs: 2000 });
  assert.ok(native.bot.entity.position.x - native.from.x >= 16);
  t.diagnostic(`16-block route=${Math.round(routeMs)}ms, held-forward=${Math.round(performance.now() - nativeStarted)}ms including final stop; middle stopped frames=${stoppedMiddleFrames}`);
});

test('中间点终止时只松键等待实际制动，不回到旧检查点', async (t) => {
  const { bot, timer, from, to, controls, writes } = continuousBody(0);
  t.after(() => clearInterval(timer));
  const adapter = adapterWith(bot);
  await adapter.moveTo({ kind: 'feet', ...to }, { ...opts(), settleAtTarget: false });
  const checkpoint = bot.entity.position.x;
  const count = writes.length;
  await adapter.settleMovement({ ...opts(), timeoutMs: 2000 });
  assert.ok(bot.entity.position.x > checkpoint + 0.05, `制动位移 ${bot.entity.position.x - checkpoint}`);
  assert.ok(bot.entity.position.x < from.x + 1.5);
  assert.ok(Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z) < 0.003);
  assert.ok(writes.slice(count).every(event => event.endsWith(':false')), '收尾不主动倒车或重新前进');
  assert.ok(Object.values(controls).every(held => !held));
});

test('连续脚位保留 sprint 委托，取消时释放本次运动键', async (t) => {
  const { bot, timer, from, controls, writes } = continuousBody(0);
  t.after(() => clearInterval(timer));
  const adapter = adapterWith(bot);
  await adapter.moveTo({ kind: 'feet', x: from.x + 1, y: from.y, z: from.z }, { ...opts(), sprint: true, settleAtTarget: false });
  assert.ok(writes.includes('sprint:true'));
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 60);
  await assert.rejects(adapter.moveTo({ kind: 'feet', x: from.x + 2, y: from.y, z: from.z }, {
    ...opts(controller.signal), sprint: true, settleAtTarget: false,
  }), { name: 'AbortedError' });
  const count = writes.length;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(writes.length, count);
  assert.ok(Object.values(controls).every(held => !held));
  assert.equal(bot.listenerCount('physicsTick'), 0);
});

test('同一调用栈连续物理帧在实际到位帧松键，交接时读取最新脚位', async () => {
  const { bot, controls } = botAt(0.5, 64, 0.5);
  const movement = adapterWith(bot).moveTo({ kind: 'feet', x: 1.5, y: 64, z: 0.5 }, {
    ...opts(), settleAtTarget: false,
  });
  bot.entity.position.x = 1.421;
  bot.entity.velocity.x = 0.118;
  bot.emit('physicsTick');
  assert.equal(controls.forward, false, '必须在第一帧同步松键，等待 Promise 会错过窗口');
  bot.entity.position.x += controls.forward ? 0.216 : bot.entity.velocity.x;
  bot.emit('physicsTick');
  await movement;
  assert.ok(Math.abs(bot.entity.position.x - 1.539) < 1e-9);
  assert.equal(bot.listenerCount('physicsTick'), 0);
});

test('松键后实际停在纠偏窗外，立即报告过冲', async () => {
  const { bot, controls } = botAt(0.5, 64, 0.5);
  const original = bot.setControlState;
  bot.setControlState = (name: string, value: boolean) => {
    original(name, value);
    if (name === 'forward') {
      bot.entity.position.x = value ? 1.85 : 2.109;
      bot.entity.velocity.x = value ? 0.2 : 0;
    }
  };
  await assert.rejects(adapterWith(bot).moveTo({ kind: 'feet', x: 1.5, y: 64, z: 0.5 }, { ...opts(), timeoutMs: 800 }), /越过了连续脚位目标/);
  assert.equal(controls.forward, false);
  assert.equal(bot.listenerCount('physicsTick'), 0);
});

test('经过检查点后又被移出容差时，不能用旧物理帧确认到达', async () => {
  const { bot } = botAt(0.5, 64, 0.5);
  const moved = adapterWith(bot).moveTo({ kind: 'feet', x: 1.5, y: 64, z: 0.5 }, { ...opts(), settleAtTarget: false });
  bot.entity.position.x = 1.421;
  bot.emit('physicsTick');
  bot.entity.position.x = 2.109;
  bot.emit('physicsTick');
  await assert.rejects(moved, /越过了连续脚位目标/);
  assert.equal(bot.listenerCount('physicsTick'), 0);
});

for (const drop of [0, -1]) {
  test(`连续路线中间${drop === 0 ? '步行' : '台阶'}点落地后保留速度交接，最后一点才停稳`, async (t) => {
    const { bot, timer, from, controls, looks } = continuousBody(drop, undefined, true);
    t.after(() => clearInterval(timer));
    const adapter = adapterWith(bot);
    const started = performance.now();
    const checkpoints: { speed: number; ground: boolean; x: number }[] = [];
    for (let step = 1; step <= 4; step++) {
      const to = { x: from.x + step, y: from.y - drop * step, z: from.z };
      await adapter.moveTo({ kind: 'feet', ...to }, { ...opts(), timeoutMs: 6000, settleAtTarget: step === 4 });
      checkpoints.push({ speed: Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z), ground: bot.entity.onGround, x: bot.entity.position.x });
      assert.ok(Math.hypot(bot.entity.position.x - to.x, bot.entity.position.z - to.z) <= 0.12, `checkpoint ${step}: ${bot.entity.position}`);
      assert.equal(bot.entity.position.y, to.y);
    }
    assert.ok(checkpoints.slice(0, -1).every((point) => point.ground && point.speed > 0.003), JSON.stringify(checkpoints));
    assert.ok(checkpoints.at(-1)!.ground && checkpoints.at(-1)!.speed < 0.003);
    assert.equal(looks.length, 4);
    assert.ok(Object.values(controls).every((held) => !held));
    t.diagnostic(`${drop === 0 ? 'walk' : 'step'} 4 blocks ${Math.round(performance.now() - started)}ms; checkpoint speeds ${checkpoints.map(point => point.speed.toFixed(4)).join(',')}`);
  });
}

test('后退微调被取消时释放本次按键且不再转向', async () => {
  const { bot, controls, writes } = botAt(-494.37, 99.9375, -291.44);
  const to = { x: -493.37, y: 99.9375, z: -291.44 };
  const looks: number[] = [];
  // 固定复现“首段制动后越过目标 .2 格”的测量序列，不依赖计时器恰好采到哪一帧。
  bot.look = async (yaw: number) => { looks.push(yaw); bot.entity.position = new Vec3(to.x + 0.2, to.y, to.z); };
  let velocityReads = 0;
  Object.defineProperty(bot.entity, 'velocity', { get: () => new Vec3(++velocityReads === 1 ? 0.1 : 0, 0, 0) });
  const controller = new AbortController();
  const original = bot.setControlState;
  bot.setControlState = (name: string, value: boolean) => {
    original(name, value);
    if (name === 'back' && value) setTimeout(() => controller.abort(), 10);
  };
  await assert.rejects(adapterWith(bot).moveTo({ kind: 'feet', ...to }, { ...opts(controller.signal), timeoutMs: 6000 }), { name: 'AbortedError' });
  assert.ok(writes.includes('back:true'));
  assert.ok(Object.values(controls).every((pressed) => !pressed));
  const count = writes.length;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(writes.length, count);
  assert.equal(looks.length, 1);
});

test('实测侧向惯性用侧移纠正，保持初始朝向与原目标', async (t) => {
  const { bot, timer, controls, writes, looks, to } = continuousBody(0);
  t.after(() => clearInterval(timer));
  bot.entity.velocity = new Vec3(0, 0, 0.02);
  await adapterWith(bot).moveTo({ kind: 'feet', ...to }, { ...opts(), timeoutMs: 6000 });
  assert.ok(writes.includes('left:true'), '面东时向南的惯性应由左移纠正');
  assert.ok(Math.hypot(bot.entity.position.x - to.x, bot.entity.position.z - to.z) <= 0.12);
  assert.equal(looks.length, 1);
  assert.ok(Object.values(controls).every((pressed) => !pressed));
});

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
