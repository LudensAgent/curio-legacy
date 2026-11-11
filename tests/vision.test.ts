import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { CATS, Vision, dirOfYaw, relOf, yawTo } from '../src/perception/vision.ts';
import { SKILLS } from '../src/skills/index.ts';
import type { GameAdapter } from '../src/adapter/types.ts';
import { FakeAdapter } from './fake-adapter.ts';

// FakeAdapter：角色站在 (0,64,0)，地面 y=63 草方块、y<63 石头；默认面朝东(+X)，略低头

const setup = () => {
  const adapter = new FakeAdapter();
  const vision = new Vision(adapter);
  return { adapter, vision };
};
const sees = (v: Vision, name: string) => [...v.visibleNow.values()].some((b) => b.name === name);

test('方向约定：yaw 0 = 北，正值向左；相对方位正确', () => {
  assert.equal(dirOfYaw(0), 'N');
  assert.equal(dirOfYaw(-Math.PI / 2), 'E');
  assert.equal(dirOfYaw(Math.PI / 2), 'W');
  assert.equal(dirOfYaw(yawTo(1, 1)), 'SE');
  assert.equal(relOf(0), '正前');
  assert.equal(relOf(-Math.PI / 2), '右侧');
  assert.equal(relOf(Math.PI / 2), '左侧');
  assert.equal(relOf(Math.PI), '正后');
});

test('看得见视野内的方块；同一方块被墙挡住时看不见（不透视）', () => {
  const { adapter, vision } = setup();
  adapter.blocks.push({ name: 'iron_ore', pos: { x: 10, y: 64, z: 0 } });
  vision.scan();
  assert.ok(sees(vision, 'iron_ore'), '无遮挡时应看见铁矿');

  const { adapter: a2, vision: v2 } = setup();
  a2.blocks.push({ name: 'iron_ore', pos: { x: 10, y: 64, z: 0 } });
  for (let y = 63; y <= 70; y++) for (let z = -6; z <= 6; z++) a2.blocks.push({ name: 'stone', pos: { x: 5, y, z } });
  v2.scan();
  assert.ok(!sees(v2, 'iron_ore'), '墙后的铁矿不应被看见');
  assert.ok(sees(v2, 'stone'), '应该看见挡在前面的墙');
});

test('后台分片扫描与同步扫描在同一视点得到同一帧', async () => {
  const { adapter, vision } = setup();
  adapter.blocks.push({ name: 'iron_ore', pos: { x: 10, y: 64, z: 0 } });
  await vision.scanAsync();
  assert.ok(vision.frame, '分片扫描完成后应提交一帧');
  assert.ok(sees(vision, 'iron_ore'));
  const sliced = [...vision.frame!.cats];
  vision.scan();
  assert.deepEqual([...vision.frame!.cats], sliced, '同一视点下两种扫描方式的画面分类一致');
});

test('后台分片扫描在慢查询下让出事件循环', async () => {
  const adapter = new FakeAdapter();
  const original = adapter.blockOptics.bind(adapter);
  let lookups = 0;
  adapter.blockOptics = (x: number, y: number, z: number) => {
    lookups += 1;
    const until = performance.now() + 0.25;
    while (performance.now() < until) { /* simulate a costly world read */ }
    return original(x, y, z);
  };
  const vision = new Vision(adapter, { range: 8, hFov: 120, vFov: 96, cols: 24, rows: 12, hearRadius: 10, bandCols: 0, bandRows: 0 });
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 1);
  await vision.scanAsync();
  clearInterval(timer);
  assert.ok(lookups > 0);
  assert.ok(ticks > 0, `分片扫描应让出事件循环（查询 ${lookups} 次，计时器 ${ticks} 次）`);
});

test('地下的矿看不见；背后的树看不见，环顾一圈后才知道', async () => {
  const { adapter, vision } = setup();
  adapter.blocks.push({ name: 'diamond_ore', pos: { x: 6, y: 58, z: 0 } }); // 埋在地下
  adapter.blocks.push({ name: 'oak_log', pos: { x: -12, y: 64, z: 0 } }, { name: 'oak_log', pos: { x: -12, y: 65, z: 0 } }); // 在背后（西边）
  vision.scan();
  assert.ok(!sees(vision, 'diamond_ore'), '地下的钻石不应可见');
  assert.equal(vision.knownBlocks(['oak_log'], 96).length, 0, '背后的树还不知道');

  const bus = new EventBus();
  const arbiter = new Arbiter(adapter, new WorldMemory(null), bus, vision);
  const done = new Promise<TaskOutcome>((r) => arbiter.once('done', r));
  arbiter.start({ skill: 'look_around', args: { seconds: 2 } }, 'llm');
  assert.equal((await done).result.status, 'succeeded');
  assert.ok(vision.knownBlocks(['oak_log'], 96).length >= 1, '环顾之后应记住树的位置');
  assert.equal(vision.knownBlocks(['diamond_ore'], 96).length, 0, '环顾也看不见地下的钻石');
  assert.ok(vision.lastSweepAt > 0);
});

test('记忆：转身后保留所见地点，重新看见方块消失才遗忘', () => {
  const { adapter, vision } = setup();
  adapter.blocks.push({ name: 'coal_ore', pos: { x: 8, y: 64, z: 1 } });
  vision.scan();
  adapter.yaw = Math.PI / 2; // 转向西
  vision.scan();
  assert.ok(!sees(vision, 'coal_ore'));
  assert.equal(vision.knownBlocks(['coal_ore'], 96).length, 1, '应记得煤矿位置');
  adapter.blocks = adapter.blocks.filter((b) => b.name !== 'coal_ore');
  assert.equal(vision.knownBlocks(['coal_ore'], 96).length, 1, '背后的变化不能更新记忆');
  adapter.yaw = -Math.PI / 2;
  assert.equal(vision.knownBlocks(['coal_ore'], 96).length, 0, '重新看见该格为空才遗忘');
});

test('实体：墙后的僵尸看不见；近处的能“听见”，远处的感知不到', () => {
  const { adapter, vision } = setup();
  for (let y = 64; y <= 68; y++) for (let z = -6; z <= 6; z++) adapter.blocks.push({ name: 'stone', pos: { x: 3, y, z } });
  adapter.entities.push({ id: 1, name: 'zombie', kind: 'hostile', pos: { x: 6, y: 64, z: 0 }, dist: 0, height: 1.95 });
  adapter.entities.push({ id: 2, name: 'skeleton', kind: 'hostile', pos: { x: 30, y: 64, z: 0 }, dist: 0, height: 1.99 });
  vision.scan();
  assert.equal(vision.seen.length, 0);
  assert.deepEqual(vision.heard.map((e) => e.name), ['zombie']);
  assert.deepEqual(vision.perceivedEntities(40).map((e) => e.name), ['zombie']);
});

test('实体：视野内且无遮挡的牛能看见，并给出画面坐标与方位', () => {
  const { adapter, vision } = setup();
  adapter.entities.push({ id: 3, name: 'cow', kind: 'passive', pos: { x: 12, y: 64, z: -3 }, dist: 0, height: 1.4 });
  vision.scan();
  assert.equal(vision.seen.length, 1);
  const cow = vision.seen[0];
  assert.equal(cow.how, 'seen');
  assert.ok(cow.u! < 0.5, '面朝东时北边在左手边，画面坐标 u 应 < 0.5');
  assert.equal(cow.rel, '正前');
  assert.equal(cow.dir, 'E');
});

test('黑暗：没有光时只能看清身边几格，远处是 dark', () => {
  const { adapter, vision } = setup();
  adapter.light = 0;
  adapter.blocks.push({ name: 'coal_ore', pos: { x: 8, y: 64, z: 0 } });
  adapter.blocks.push({ name: 'gold_ore', pos: { x: 20, y: 64, z: 0 } });
  adapter.entities.push({ id: 4, name: 'creeper', kind: 'hostile', pos: { x: 15, y: 64, z: 0 }, dist: 0, height: 1.7 });
  vision.scan();
  assert.ok(sees(vision, 'coal_ore'), '全黑时仍能看清身边约 10 格内的煤');
  assert.ok(!sees(vision, 'gold_ore'), '20 格外仍然看不清');
  assert.equal(vision.seen.length, 0, '黑暗中 15 格外的苦力怕看不见');
  const dark = vision.frame!.cats.filter((c) => CATS[c] === 'dark').length;
  assert.ok(dark > 0, '画面中应有 dark 像素');
});

test('平视时正头顶的矿石也在视野内（垂直视野覆盖头顶）', () => {
  const { adapter, vision } = setup();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.pitch = 0;
  // 两格高的巷道：天花板在脚上方 2 格，正头顶那格换成铁矿
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) adapter.blocks.push({ name: 'stone', pos: { x, y: 66, z } });
  adapter.blocks = adapter.blocks.filter((b) => !(b.pos.x === 0 && b.pos.y === 66 && b.pos.z === 0));
  adapter.blocks.push({ name: 'iron_ore', pos: { x: 0, y: 66, z: 0 } });
  vision.scan();
  assert.ok(sees(vision, 'iron_ore'), '正头顶的铁矿石应进入视野记忆');
});

test('技能调用透视接口会被拒绝（必须用 ctx.senses）', async () => {
  const { adapter, vision } = setup();
  const arbiter = new Arbiter(adapter, new WorldMemory(null), new EventBus(), vision);
  SKILLS.test_xray = {
    name: 'test_xray', description: '', argsDoc: '{}', timeoutMs: 3000, movement: false,
    validate: () => ({ ok: true, args: {} }),
    async run(ctx) {
      ctx.adapter.findBlocks(['diamond_ore'], 64, 10);
      return { status: 'succeeded', summary: '不应到达' };
    },
  };
  try {
    const done = new Promise<TaskOutcome>((r) => arbiter.once('done', r));
    arbiter.start({ skill: 'test_xray' }, 'llm');
    const o = await done;
    assert.equal(o.result.status, 'failed');
    assert.match(o.result.summary, /NO_XRAY/);
  } finally {
    delete SKILLS.test_xray;
  }
});

test('内置技能可以读取碰撞形状；原始方块搜索仍被拒绝', async () => {
  const { adapter, vision } = setup();
  const arbiter = new Arbiter(adapter, new WorldMemory(null), new EventBus(), vision);
  SKILLS.test_shape = {
    name: 'test_shape', description: '', argsDoc: '{}', timeoutMs: 3000, movement: false,
    validate: () => ({ ok: true, args: {} }),
    async run(ctx) {
      const optics = ctx.adapter.blockOptics(0, adapter.groundY, 0);
      return optics
        ? { status: 'succeeded', summary: `shape:${optics.name}` }
        : { status: 'failed', summary: '没有碰撞形状' };
    },
  };
  try {
    const done = new Promise<TaskOutcome>((r) => arbiter.once('done', r));
    arbiter.start({ skill: 'test_shape' }, 'llm');
    const o = await done;
    assert.equal(o.result.status, 'succeeded', o.result.summary);
    assert.match(o.result.summary, /shape:grass_block/);
  } finally {
    delete SKILLS.test_shape;
  }
});

test('gather：埋在地下的原木不会去挖（NOT_FOUND）；背后的树要转头看见后才去砍；看不见石头时不自己往下挖', async () => {
  const { adapter, vision } = setup();
  adapter.blocks.push({ name: 'oak_log', pos: { x: 3, y: adapter.groundY - 3, z: 0 } }); // 埋在地下：转头也看不见
  const arbiter = new Arbiter(adapter, new WorldMemory(null), new EventBus(), vision);
  let done = new Promise<TaskOutcome>((r) => arbiter.once('done', r));
  arbiter.start({ skill: 'gather', args: { block: 'log', count: 1 } }, 'llm');
  let o = await done;
  assert.equal(o.result.failureCode, 'NOT_FOUND');
  assert.equal(adapter.inv.get('oak_log') ?? 0, 0);

  adapter.blocks.push({ name: 'oak_log', pos: { x: -15, y: 64, z: 0 } }); // 背后：开始时不在视野里
  const yaw0 = adapter.yaw;
  done = new Promise<TaskOutcome>((r) => arbiter.once('done', r));
  arbiter.start({ skill: 'gather', args: { block: 'log', count: 1 } }, 'llm');
  o = await done;
  assert.equal(o.result.status, 'succeeded', o.result.summary);
  assert.notEqual(adapter.yaw, yaw0, '必须转头看见之后才能去砍');
  assert.equal(adapter.inv.get('oak_log'), 1);

  adapter.pitch = 0.3; // 抬头，看不到地面
  done = new Promise<TaskOutcome>((r) => arbiter.once('done', r));
  const y0 = adapter.state().pos.y;
  arbiter.start({ skill: 'gather', args: { block: 'stone', count: 2 } }, 'llm');
  o = await done;
  assert.equal(o.result.failureCode, 'NOT_FOUND', o.result.summary);
  assert.ok(adapter.state().pos.y >= y0 - 0.01, '不自己往下挖');
});

test('扫描性能（40×32 射线，64 格）', () => {
  const { adapter, vision } = setup();
  for (let i = 0; i < 40; i++) adapter.blocks.push({ name: 'oak_log', pos: { x: 10 + i, y: 64, z: (i % 7) - 3 } });
  const t0 = performance.now();
  for (let k = 0; k < 10; k++) vision.scan();
  const ms = (performance.now() - t0) / 10;
  console.log(`  平均每次扫描 ${ms.toFixed(1)} ms`);
  assert.ok(ms < 200);
});

// ---- observeBlocks 边界：脚下/头顶不再免视线，必须真实进入视锥且无遮挡
test('observeBlocks：视锥外的脚下与头顶竖列不返回精确视觉', () => {
  const adapter = new FakeAdapter();
  // 用窄视锥单独验证“没有接触豁免”：默认 96° 平视时正头顶本来就在视野里
  const vision = new Vision(adapter, { range: 64, hFov: 120, vFov: 60, cols: 40, rows: 24, bandCols: 0, bandRows: 0, hearRadius: 10 });
  assert.deepEqual(vision.observeBlocks([{ x: 0, y: 63, z: 0 }, { x: 0, y: 66, z: 0 }]), []);
});

test('observeBlocks：真正低头看支撑、抬头看净空都返回事实', () => {
  const { adapter, vision } = setup();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.yaw = Math.PI;
  adapter.pitch = -1.2;
  assert.equal(vision.observeBlocks([{ x: 0, y: 63, z: 0 }])[0]?.name, 'grass_block');
  adapter.pitch = 1.1;
  assert.equal(vision.observeBlocks([{ x: 0, y: 66, z: 0 }])[0]?.name, 'air');
});

test('observeBlocks：转头能看见的支撑被贴身的脚格挡住时仍不返回', () => {
  const { adapter, vision } = setup();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.yaw = Math.PI;
  adapter.pitch = -1.2;
  adapter.blocks.push({ name: 'stone', pos: { x: 0, y: 64, z: 0 } }); // 脚格塞入石头，挡住脚下支撑
  assert.deepEqual(vision.observeBlocks([{ x: 0, y: 63, z: 0 }]), []);
});

test('observeBlocks：blockStateAt 缺失时名称可见但状态不完整', () => {
  const { adapter, vision } = setup();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.yaw = -Math.PI / 2;
  adapter.pitch = 0;
  adapter.blocks.push({ name: 'stone', pos: { x: 2, y: 64, z: 0 } });
  const gameAdapter: GameAdapter = adapter;
  gameAdapter.blockStateAt = () => null;
  const out = vision.observeBlocks([{ x: 2, y: 64, z: 0 }]);
  assert.equal(out[0]?.name, 'stone');
  assert.equal(out[0]?.stateComplete, false);
});
