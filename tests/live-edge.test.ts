import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveEdgeStatus, liveTurnStatus } from '../src/skills/movement/live-edge.ts';
import { FakeAdapter } from './fake-adapter.ts';

const from = { x: 0.5, y: 64, z: 0.5 };
const to = { x: 1.5, y: 64, z: 0.5 };

test('实时边确认：已加载的开阔地面可走', () => {
  const adapter = new FakeAdapter();
  adapter.pos = { ...from };
  assert.equal(liveEdgeStatus(adapter, from, to, 'walk').status, 'open');
});

test('实时边确认：从起点格列角落迈到下一格中心仍在库的 walk 包络内', () => {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.01, y: 64, z: 0.99 };
  const corner = { x: 0.01, y: 64, z: 0.99 };
  const next = { x: 1.5, y: 64, z: 0.5 };
  assert.ok(Math.hypot(next.x - corner.x, next.z - corner.z) > 1.5, '这个起点到下一格中心超过旧的 1.5 硬限');
  assert.equal(liveEdgeStatus(adapter, corner, next, 'walk').status, 'open');
});

test('实时边确认：看到方块占用身体扫掠格时阻挡', () => {
  const adapter = new FakeAdapter();
  adapter.pos = { ...from };
  adapter.blocks.push({ name: 'stone', pos: { x: 1, y: 64, z: 0 } });
  const result = liveEdgeStatus(adapter, from, to, 'walk');
  assert.equal(result.status, 'blocked', result.reason);
});

test('实时边确认：视线透明的玻璃/屏障仍按碰撞盒阻挡', () => {
  for (const name of ['glass', 'barrier']) {
    const adapter = new FakeAdapter();
    adapter.pos = { ...from };
    adapter.blocks.push({ name, pos: { x: 1, y: 64, z: 0 } });
    const result = liveEdgeStatus(adapter, from, to, 'walk');
    assert.equal(result.status, 'blocked', `${name}: ${result.reason}`);
    assert.deepEqual(result.cell, { x: 1, y: 64, z: 0 });
  }
});

test('实时边确认：火/水仍然拒绝，不会被即时确认放行', () => {
  const fire = new FakeAdapter();
  fire.pos = { ...from };
  fire.blocks.push({ name: 'fire', pos: { x: 1, y: 64, z: 0 } });
  assert.equal(liveEdgeStatus(fire, from, to, 'walk').status, 'blocked');

  const water = new FakeAdapter();
  water.pos = { ...from };
  water.blocks.push({ name: 'water', pos: { x: 1, y: 64, z: 0 } });
  assert.equal(liveEdgeStatus(water, from, to, 'walk').status, 'blocked');
  assert.equal(liveEdgeStatus(water, from, to, 'walk', { wade: true }).status, 'open');

  // 涉水落点脚下是水而不是可站立面：库对水位落点免除支撑要求，实时确认也要一致。
  const deep = new FakeAdapter();
  deep.pos = { ...from };
  deep.blocks.push({ name: 'water', pos: { x: 1, y: 64, z: 0 } });
  deep.removed.add('1,63,0');
  assert.equal(liveEdgeStatus(deep, from, to, 'walk', { wade: true }).status, 'open');
});

test('实时边确认：落点没有支撑时阻挡', () => {
  const adapter = new FakeAdapter();
  adapter.pos = { ...from };
  adapter.removed.add('1,63,0');
  const result = liveEdgeStatus(adapter, from, to, 'walk');
  assert.equal(result.status, 'blocked', result.reason);
});

test('实时边确认：区块/形状未加载时不当成可走', () => {
  class Unloaded extends FakeAdapter {
    override blockOptics() { return null; }
  }
  const adapter = new Unloaded();
  adapter.pos = { ...from };
  const result = liveEdgeStatus(adapter, from, to, 'walk');
  assert.equal(result.status, 'unknown', result.reason);
});

test('实时边确认：半砖支撑按真实顶面高度确认', () => {
  const adapter = new FakeAdapter();
  adapter.pos = { x: 0.5, y: 64.5, z: 0.5 };
  adapter.blocks.push({ name: 'oak_slab', pos: { x: 1, y: 64, z: 0 } });
  adapter.blockProperties.set('1,64,0', { type: 'bottom', waterlogged: false });
  assert.equal(liveEdgeStatus(adapter, { x: 0.5, y: 64.5, z: 0.5 }, { x: 1.5, y: 64.5, z: 0.5 }, 'walk').status, 'open');
});

test('实时边确认：台阶按“先抬升、再平移”的两段走廊确认', () => {
  const adapter = new FakeAdapter();
  adapter.pos = { ...from };
  // 目标列的台阶本身就是落点支撑，不应被误判成挡路的墙。
  adapter.blocks.push({ name: 'stone', pos: { x: 1, y: 64, z: 0 } });
  assert.equal(liveEdgeStatus(adapter, from, { x: 1.5, y: 65, z: 0.5 }, 'step').status, 'open');
  // 台阶上方被挡时仍拒绝。
  adapter.blocks.push({ name: 'stone', pos: { x: 1, y: 66, z: 0 } });
  assert.equal(liveEdgeStatus(adapter, from, { x: 1.5, y: 65, z: 0.5 }, 'step').status, 'blocked');
});

test('实时转弯净空：切角格空着才允许带速度转弯', () => {
  const adapter = new FakeAdapter();
  adapter.pos = { ...from };
  const a = { x: 0.5, y: 64, z: 0.5 }, b = { x: 1.5, y: 64, z: 0.5 }, c = { x: 1.5, y: 64, z: 1.5 };
  assert.equal(liveTurnStatus(adapter, a, b, c).status, 'open');

  adapter.blocks.push({ name: 'stone', pos: { x: 0, y: 65, z: 1 } });
  const blocked = liveTurnStatus(adapter, a, b, c);
  assert.equal(blocked.status, 'blocked', blocked.reason);

  // 原方向前方的超冲格被挡住时，保留速度会撞上去，也应回退为停车转弯。
  const overshoot = new FakeAdapter();
  overshoot.pos = { ...from };
  overshoot.blocks.push({ name: 'stone', pos: { x: 2, y: 65, z: 0 } });
  const hit = liveTurnStatus(overshoot, a, b, c);
  assert.equal(hit.status, 'blocked', hit.reason);
});

test('实时转弯净空：切角格缺支撑时仍回退为停车转弯', () => {
  const adapter = new FakeAdapter();
  adapter.pos = { ...from };
  adapter.removed.add('0,63,1');
  const result = liveTurnStatus(adapter, { x: 0.5, y: 64, z: 0.5 }, { x: 1.5, y: 64, z: 0.5 }, { x: 1.5, y: 64, z: 1.5 });
  assert.equal(result.status, 'blocked', result.reason);
});
