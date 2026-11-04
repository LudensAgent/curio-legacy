import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExecutableMove } from 'curio-minecraft-3d-memory';
import { WALK_GAZE_PITCH, WalkMoveExecutor } from '../src/adapter/walk-route.ts';
import { Vision } from '../src/perception/vision.ts';
import { FakeAdapter } from './fake-adapter.ts';

/**
 * 移除同列接触 FOV 豁免后的回归：移动中的身体必须真正向下看，才能让所委托路线的
 * 支撑（身体下方/前方）进入视锥，成为合法视觉证据。脚底读出的支撑不能当视觉证据。
 *
 * 这里用真实 Vision（FakeAdapter 的场景光学 + 真实 FOV/遮挡检查）证明：
 *   - 水平朝向（pitch=0）看不到同列/近处路径支撑，向下的移动朝向（pitch=WALK_GAZE_PITCH）能看到；
 *   - 目标在身后/视锥外时保持未知，即使向下看也不可见；
 *   - 可见支撑被拆除后，向下朝向观测到的是空气（可见变化证据）。
 *
 * 这证明的是「真实视觉证据」这一层：移动朝向确实让支撑进入视锥、拆除确实能被看见。
 * 未在此测试中把动态拆除接入完整闭环（runWalkRoute 到达前释放控制）——那需要 package
 * 与独占 Bot 窗口的 live W4；本测试只提供真实 Vision 视线证据，不声称动态 W4 已满足。
 */

/** 平坦场景：支撑层 y=-1 是 grass_block（y<-1 是 stone），身体脚高 y=0、眼高 1.62。 */
function scene() {
  const adapter = new FakeAdapter();
  adapter.groundY = -1;
  adapter.pos = { x: 0.5, y: 0, z: 0.5 };
  adapter.yaw = -Math.PI / 2; // 面朝 +X
  adapter.pitch = 0;
  const vision = new Vision(adapter);
  return { adapter, vision };
}

const supportAhead = { x: 1, y: -1, z: 0 }; // 前方路径支撑
const supportUnder = { x: 0, y: -1, z: 0 }; // 同列脚下支撑

test('WalkMoveExecutor.move 每段恰好一次低头朝向，且保持目标 yaw，并使真实 Vision 看到支撑', async () => {
  const { adapter, vision } = scene();
  const looks: { yaw: number; pitch: number }[] = [];
  const entity = { position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true, isInWater: false };
  const body = {
    setControlState() {},
    clearControlStates() {},
    // 身体桥的 look 真正更新实际适配器朝向：真实 Vision 读到的是执行器实际执行的转头。
    look(yaw: number, pitch: number) {
      looks.push({ yaw, pitch });
      adapter.yaw = yaw;
      adapter.pitch = pitch;
    },
    entity,
  };
  // 执行前水平朝向（scene 默认 pitch=0）看不到支撑：证明是执行器执行的转头让支撑进入视锥。
  assert.deepEqual(vision.observeBlocks([supportAhead]).map((b) => b.name), [], '执行前水平朝向看不到前方支撑');
  // 首个物理帧交付后立即中止父任务，避免无关的 400 帧空转；以真实的 cancelled 收尾，不伪造成功。
  const parent = new AbortController();
  const tick = () => {
    parent.abort();
    return Promise.resolve(entity);
  };
  const executor = new WalkMoveExecutor(body, tick, parent.signal, () => 0);
  const request: ExecutableMove = { executionId: 'e1', worldId: 'w', dim: 'd', sessionId: 's', from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 0, z: 0 }, deadlineMs: 1000, timeoutMs: 100, signal: new AbortController().signal };
  const result = await executor.move(request);
  assert.equal(result.failure?.kind, 'cancelled', '父任务中止应返回 cancelled，而非伪造到达');
  assert.equal(looks.length, 1, '每段应恰好一次转头');
  assert.equal(looks[0]!.pitch, WALK_GAZE_PITCH, '移动朝向必须向下看支撑，而不是水平 pitch=0');
  assert.ok(Math.abs(looks[0]!.yaw - Math.atan2(-1, 0)) < 1e-9, '目标 yaw 不得被俯仰改动');
  // 执行器实际执行的向下转头，应让真实 Vision 真正看到前方支撑。
  const seen = vision.observeBlocks([supportAhead]).map((b) => b.name);
  assert.ok(seen.includes('grass_block'), `执行器执行的低头应让真实 Vision 看到前方支撑：${JSON.stringify(seen)}`);
});

test('水平朝向看不到路线支撑，向下移动朝向能看到；背后的目标保持未知', () => {
  const { adapter, vision } = scene();
  adapter.pitch = 0;
  const level = vision.observeBlocks([supportAhead, supportUnder]).map((b) => `${b.pos.x},${b.pos.y},${b.pos.z}:${b.name}`);
  assert.deepEqual(level, [], `pitch=0 时下方支撑不在视锥内（实际 ${JSON.stringify(level)}）`);

  adapter.pitch = WALK_GAZE_PITCH;
  const down = vision.observeBlocks([supportAhead, supportUnder]).map((b) => `${b.pos.x},${b.pos.y},${b.pos.z}:${b.name}`);
  assert.ok(down.includes('1,-1,0:grass_block'), `向下看应看到前方支撑：${JSON.stringify(down)}`);
  assert.ok(down.includes('0,-1,0:grass_block'), `向下看应看到同列脚下支撑：${JSON.stringify(down)}`);

  adapter.yaw = Math.PI / 2; // 转身 180°，目标支撑落在视锥之外
  adapter.pitch = WALK_GAZE_PITCH;
  const behind = vision.observeBlocks([supportAhead]).map((b) => b.name);
  assert.deepEqual(behind, [], '目标在身后时即使向下看也不可见，保持未知');
});

test('可见支撑被拆除后，向下移动朝向观测到空气（可见变化证据）', () => {
  const { adapter, vision } = scene();
  adapter.pitch = WALK_GAZE_PITCH;
  const before = vision.observeBlocks([supportAhead]).map((b) => b.name);
  assert.ok(before.includes('grass_block'), `拆除前向下看应看到支撑：${JSON.stringify(before)}`);

  adapter.removed.add('1,-1,0'); // 物理夹具拆除该支撑，FakeAdapter.nameAt 返回 air
  const after = vision.observeBlocks([supportAhead]).map((b) => b.name);
  assert.ok(after.includes('air'), `拆除后向下看应看到空气：${JSON.stringify(after)}`);
});
