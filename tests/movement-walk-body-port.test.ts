import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  WalkRouteExecutor,
  VoxelMap,
  type BodySample,
  type CollisionShapeProvider,
  type ExecutableMove,
} from 'curio-minecraft-3d-memory';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { createWalkBodyPort } from '../src/skills/movement/walk.ts';
import { planRoute, walkPath, clearRouteRecords } from '../src/skills/movement/index.ts';
import type { WalkBody, WalkTick } from '../src/adapter/walk-route.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const WORLD = 'fake-world', DIM = 'overworld', SESSION = 'fake-session';

/** 只暴露前向控制/朝向/实测实体的身体桥；没有挖/放/寻路入口。 */
function recordingBody() {
  const controls: string[] = [];
  const looks: { yaw: number; pitch: number }[] = [];
  const entity = {
    position: { x: 0.5, y: 64, z: 0.5 },
    velocity: { x: 0, y: 0, z: 0 },
    onGround: true,
    isInWater: false,
  };
  const body: WalkBody = {
    setControlState(name: string, value: boolean) { controls.push(`${name}:${value}`); },
    clearControlStates() { controls.push('clear'); },
    look(yaw: number, pitch: number) { looks.push({ yaw, pitch }); },
    entity,
  };
  return { controls, looks, entity, body };
}

/** 稳定的物理帧源：每 2ms 交付一次当前实体；取消时返回 null。 */
const ticking = (entity: WalkBody['entity']): WalkTick => (signal) => new Promise((resolve) => {
  if (signal.aborted) { resolve(null); return; }
  const timer = setTimeout(() => resolve({
    position: { ...entity.position },
    velocity: { ...entity.velocity },
    onGround: entity.onGround,
    isInWater: entity.isInWater,
  }), 2);
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve(null); }, { once: true });
});

const request = (executionId: string, overrides: Partial<ExecutableMove> = {}): ExecutableMove => ({
  executionId,
  worldId: WORLD,
  dim: DIM,
  sessionId: SESSION,
  from: { x: 0.5, y: 64, z: 0.5 },
  to: { x: 1.5, y: 64, z: 0.5 },
  deadlineMs: Date.now() + 5000,
  timeoutMs: 60,
  signal: new AbortController().signal,
  ...overrides,
});

const lifecycle = () => ({
  worldId: WORLD, dim: DIM, sessionId: SESSION, alive: true, connected: true, observationReady: true,
});

test('单步 to 原样交给身体桥：执行身份/序号关联，且没有挖/放入口', async () => {
  const { controls, looks, entity, body } = recordingBody();
  let sequence = 0;
  const port = createWalkBodyPort({
    body,
    tick: ticking(entity),
    signal: new AbortController().signal,
    now: Date.now,
    lifecycle,
    onLifecycleBroken: () => { throw new Error('unexpected lifecycle break'); },
    onFrame: (frame, executionId): BodySample => ({
      worldId: WORLD, dim: DIM, sessionId: SESSION, executionId,
      pos: { ...frame.position }, velocity: { ...frame.velocity }, observedAt: Date.now(),
      sequence: ++sequence, alive: true, connected: true, observationReady: true,
      onGround: frame.onGround, inWater: frame.isInWater,
    }),
  });

  const move = request('exec_rt_body');
  const untouched = { ...move.to };
  const result = await port.move(move);

  assert.equal(result.sample?.executionId, 'exec_rt_body', '样本沿用库的稳定执行身份');
  assert.ok(Number.isSafeInteger(result.sample?.sequence) && result.sample!.sequence > 0, '序号必须是严格正整数');
  assert.deepEqual(move.to, untouched, '端口不得改写单步目标');
  assert.deepEqual(result.sample?.pos, entity.position, '样本来自真实物理帧');
  // look 的 yaw 由 from→to 直接决定（+X 步为 -π/2）；改写 to 会让朝向变化。
  assert.equal(looks.length, 1);
  assert.ok(Math.abs(looks[0]!.yaw - Math.atan2(-(move.to.x - move.from.x), -(move.to.z - move.from.z))) < 1e-9);
  assert.ok(controls.includes('forward:true'), '按前进键');
  assert.deepEqual(Object.keys(port).sort(), ['move', 'stop'], '身体端口只有单步 move 与定向 stop');
  assert.equal(Object.getOwnPropertyNames(body).sort().join(','), 'clearControlStates,entity,look,setControlState', '没有挖/放/寻路面');
});

test('旧 executionId 的 stop 不清理新段控制，新段 stop 仍能释放', async () => {
  const { controls, entity, body } = recordingBody();
  let sequence = 0;
  const port = createWalkBodyPort({
    body,
    tick: ticking(entity),
    signal: new AbortController().signal,
    now: Date.now,
    lifecycle,
    onLifecycleBroken: () => { throw new Error('unexpected lifecycle break'); },
    onFrame: (frame, executionId): BodySample => ({
      worldId: WORLD, dim: DIM, sessionId: SESSION, executionId,
      pos: { ...frame.position }, velocity: { ...frame.velocity }, observedAt: Date.now(),
      sequence: ++sequence, alive: true, connected: true, observationReady: true,
      onGround: frame.onGround, inWater: frame.isInWater,
    }),
  });

  const first = new AbortController();
  controls.length = 0;
  const firstMove = port.move(request('exec_old', { signal: first.signal, timeoutMs: 5000 }));
  while (!controls.includes('forward:true')) await new Promise((r) => setImmediate(r));
  const releasedBefore = controls.filter((entry) => entry === 'forward:false').length;
  port.stop('exec_other');
  assert.equal(controls.filter((entry) => entry === 'forward:false').length, releasedBefore, '旧 ID 的 stop 不得松开当前段');
  first.abort();
  await firstMove;

  const second = new AbortController();
  controls.length = 0;
  const secondMove = port.move(request('exec_new', { signal: second.signal, timeoutMs: 5000 }));
  while (!controls.includes('forward:true')) await new Promise((r) => setImmediate(r));
  const before = controls.join(',');
  port.stop('exec_old');
  assert.equal(controls.join(','), before, '更旧段的迟到 stop 不得影响新段');
  port.stop('exec_new');
  assert.ok(controls.includes('forward:false'), '所属段的 stop 必须释放控制');
  second.abort();
  await secondMove;
});

test('move 结果的样本保持最后一帧的序号，不重新编号以掩盖重放', async () => {
  const { entity, body } = recordingBody();
  let sequence = 0;
  const frames: BodySample[] = [];
  const port = createWalkBodyPort({
    body,
    tick: ticking(entity),
    signal: new AbortController().signal,
    now: Date.now,
    lifecycle,
    onLifecycleBroken: () => { throw new Error('unexpected lifecycle break'); },
    onFrame: (frame, executionId): BodySample => {
      const sample: BodySample = {
        worldId: WORLD, dim: DIM, sessionId: SESSION, executionId,
        pos: { ...frame.position }, velocity: { ...frame.velocity }, observedAt: Date.now(),
        sequence: ++sequence, alive: true, connected: true, observationReady: true,
        onGround: frame.onGround, inWater: frame.isInWater,
      };
      frames.push(sample);
      return sample;
    },
  });

  const first = await port.move(request('exec_rt_seq'));
  assert.equal(first.sample?.sequence, frames.at(-1)?.sequence, '返回的是最后一帧样本本身，不是新序号');
  assert.equal(first.sample, frames.at(-1), '同一测量重投保持同一身份');

  const second = await port.move(request('exec_rt_seq'));
  assert.ok((second.sample?.sequence ?? 0) > (first.sample?.sequence ?? 0), '后续段序号严格递增');
});

test('重放/降序/旧执行身份的样本都不推进执行，新序号样本才被接受', () => {
  const emptyProvider: CollisionShapeProvider = {
    version: 'test-empty',
    resolve: () => ({ kind: 'shape', shape: { boxes: [], supportFaces: [] } }),
  };
  const start = { x: 0.5, y: 64, z: 0.5 };
  const target = { x: 1.5, y: 64, z: 0.5 };
  const { body } = recordingBody();
  let sequence = 0;
  const port = createWalkBodyPort({
    body,
    tick: ticking(body.entity),
    signal: new AbortController().signal,
    now: Date.now,
    lifecycle,
    onLifecycleBroken: () => { throw new Error('unexpected lifecycle break'); },
    onFrame: (frame, executionId): BodySample => ({
      worldId: WORLD, dim: DIM, sessionId: SESSION, executionId,
      pos: { ...frame.position }, velocity: { ...frame.velocity }, observedAt: Date.now(),
      sequence: ++sequence, alive: true, connected: true, observationReady: true,
      onGround: frame.onGround, inWater: frame.isInWater,
    }),
  });
  const executor = new WalkRouteExecutor(new VoxelMap('world', { validityWindowMs: 60_000 }), port);
  const started = executor.start({
    worldId: 'world', dim: 'overworld', sessionId: 's1', mode: 'walk',
    body: { feet: { ...start }, width: 0.6, height: 1.8, pose: 'standing' },
    points: [{ ...start }, { ...target }], arrival: { kind: 'exact' },
    shapeProvider: emptyProvider, deadlineMs: Date.now() + 10_000, timeoutMs: 1000,
  });
  const t0 = Date.now();
  const sample = (pos: typeof start, seq: number, observedAt: number, executionId = started.delegationId): BodySample => ({
    worldId: 'world', dim: 'overworld', sessionId: 's1', executionId,
    pos: { ...pos }, velocity: { x: 0, y: 0, z: 0 }, observedAt,
    sequence: seq, alive: true, connected: true, observationReady: true, onGround: true, inWater: false,
  });

  executor.onSample(sample(start, 5, t0));
  assert.deepEqual(executor.status()?.lastPosition, start);

  // 同一序号的终点样本是重放：不得更新已测位置，也不得推进/到达。
  executor.onSample(sample(target, 5, t0 + 1));
  assert.equal(executor.status()?.result, null);
  assert.deepEqual(executor.status()?.lastPosition, start);

  // 降序样本同样被拒绝。
  executor.onSample(sample(target, 4, t0 + 2));
  assert.equal(executor.status()?.result, null);
  assert.deepEqual(executor.status()?.lastPosition, start);

  // 旧执行身份的样本不得成为本执行的证据。
  executor.onSample(sample(target, 6, t0 + 3, 'exec_previous'));
  assert.equal(executor.status()?.result, null);
  assert.deepEqual(executor.status()?.lastPosition, start);

  // 新序号的样本才会被接受；没有活动 move 时偏离起点按库的 deviation 终止。
  executor.onSample(sample(target, 6, t0 + 4));
  const finish = executor.status();
  assert.deepEqual(finish?.lastPosition, target, '新序号样本被接受');
  assert.equal(finish?.result?.problem?.kind, 'deviation');
  assert.equal(finish?.nextPointIndex, 1, '仍停在同一个未确认段');
});

// ---- 端到端：宿主身体端口 + 库 walkPath ----

function flatMap(nameAt: (x: number, y: number, z: number) => string) {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  let sequence = 0;
  const now = Date.now();
  for (let x = -1; x <= 5; x++) for (let z = -1; z <= 4; z++) for (let y = 63; y <= 65; y++) {
    map.observe({
      worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: now, sequence: ++sequence,
      source: 'vision', evidence: 'seen', stateComplete: true,
      state: { name: nameAt(x, y, z), properties: {} }, pos: { x, y, z },
    });
  }
  return map;
}

function fakeSpatial(map: VoxelMap) {
  return {
    worldId: WORLD,
    session: {
      voxel: map,
      history: { worldId: WORLD, getFragment: () => null, fragments: () => ({ items: [], total: 0 }) },
    },
    closing: false, paused: false, observationAdmitted: true,
    attach: () => ({}),
    detach: () => {},
  } as unknown as SharedSpatialSession;
}

/** 端到端步行夹具：按住 forward 时沿当前朝向每帧走一小步。 */
class WalkingAdapter extends FakeAdapter {
  control: Record<string, boolean> = {};
  walkEntity = {
    position: { x: 0.5, y: 64, z: 0.5 }, velocity: { x: 0, y: 0, z: 0 }, onGround: true, isInWater: false,
  };
  walkBody() {
    return {
      setControlState: (name: string, value: boolean) => { this.control[name] = value; },
      clearControlStates: () => { for (const k of Object.keys(this.control)) this.control[k] = false; },
      look: (yaw: number, pitch: number) => { this.yaw = yaw; this.pitch = pitch; },
      entity: this.walkEntity,
    };
  }
  walkTick() {
    return (signal: AbortSignal) => new Promise<typeof this.walkEntity | null>((resolve) => {
      const timer = setTimeout(() => {
        if (signal.aborted) { resolve(null); return; }
        if (this.control.forward || this.control.back) {
          const speed = this.control.sneak ? 0.01 : 0.02;
          const dir = (this.control.forward ? 1 : 0) - (this.control.back ? 1 : 0);
          const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
          this.pos = { ...this.pos, x: this.pos.x + fx * dir * speed, z: this.pos.z + fz * dir * speed };
          this.walkEntity.position = { ...this.pos };
        }
        resolve({
          position: { ...this.walkEntity.position },
          velocity: { ...this.walkEntity.velocity },
          onGround: true,
          isInWater: false,
        });
      }, 5);
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve(null); }, { once: true });
    });
  }
}

function walkingAdapter() {
  const w = new WalkingAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.worldId = WORLD;
  w.sessionId = SESSION;
  w.dim = DIM;
  return w;
}

test('端到端：库签发执行身份，宿主身体端口只走单步且不做任何施工', async (t) => {
  const w = walkingAdapter();
  const ctx = { ...makeCtx(w), spatial: fakeSpatial(flatMap((_x, y) => y === 63 ? 'stone' : 'air')) };
  t.after(() => ctx.memory.close());
  clearRouteRecords();

  const planned = await planRoute.run(ctx, { to: { x: 2.5, y: 64, z: 0.5 }, mode: 'walk', source: 'search', arrival: { kind: 'exact' } });
  assert.equal(planned.status, 'succeeded', planned.summary);
  const routeId = String(planned.data?.routeId);

  const result = await walkPath.run(ctx, { routeId });
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(result.data?.outcome, 'ARRIVED');
  assert.equal(result.data?.executionId, `exec_${routeId}`, '宿主样本与库的执行身份一致');
  assert.equal(result.data?.confirmed, true);
  assert.deepEqual(result.data?.consumption, { placed: [] }, '没有挖/放/搭柱');
  assert.deepEqual(w.actions, [], '不调用任何挖/放/攻击动作');
  assert.equal(w.control.forward, false, '结束时松键');
  assert.ok(Math.abs(w.pos.x - 2.5) <= 0.13, `实际位置 x=${w.pos.x}`);
});
