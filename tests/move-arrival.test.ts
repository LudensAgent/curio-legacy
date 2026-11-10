import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { test } from 'node:test';
import { VoxelMap } from 'curio-minecraft-3d-memory';
import type { MoveOpts, MoveTarget, NavigationDelegate, Vec3Like } from '../src/adapter/types.ts';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { runSkill, type Skill } from '../src/skills/types.ts';
import { AbortedError } from '../src/util.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const WORLD = 'fake-world', DIM = 'overworld', SESSION = 'fake-session';
let sequence = 0;

function observe(map: VoxelMap, name: string, cells: Vec3Like[]) {
  for (const pos of cells) {
    sequence += 1;
    map.observe({
      worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: Date.now() + sequence, sequence,
      source: 'vision', evidence: 'seen', stateComplete: true,
      state: { name, properties: {} }, pos,
    });
  }
}

function flatMap(maxX: number) {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  const air: Vec3Like[] = [], floor: Vec3Like[] = [];
  for (let x = 0; x <= maxX; x++) {
    air.push({ x, y: 64, z: 0 }, { x, y: 65, z: 0 });
    floor.push({ x, y: 63, z: 0 });
  }
  observe(map, 'minecraft:air', air);
  observe(map, 'minecraft:stone', floor);
  return map;
}

function fakeSpatial(map: VoxelMap) {
  return {
    worldId: WORLD,
    session: { voxel: map, history: { worldId: WORLD, getFragment: () => null, fragments: () => ({ items: [], total: 0 }) } },
    closing: false, paused: false, observationAdmitted: true,
    capabilities: () => ({
      owner: 'host_composed', contract: 'memory-host-contract/1',
      library: { execute: { walk: true } }, host: {},
      effective: { execute: { walk: true, groundedArrival: true, invalidation: true, cancellation: true } },
      overclaims: [],
    }),
  } as unknown as SharedSpatialSession;
}

/** 把 withNavigation 真正接进 moveTo 的测试适配器：非本地目标必须走绑定的委托。 */
class DelegatingAdapter extends FakeAdapter {
  private navigation = new AsyncLocalStorage<NavigationDelegate>();
  feetCalls = 0;
  withNavigation<T>(delegate: NavigationDelegate, run: () => Promise<T>): Promise<T> {
    return this.navigation.run(delegate, run);
  }
  protected currentDelegate(): NavigationDelegate | undefined {
    return this.navigation.getStore();
  }
  override async moveTo(target: MoveTarget, opts: MoveOpts) {
    if (target.kind === 'feet') this.feetCalls += 1;
    const delegate = this.currentDelegate();
    if (delegate !== undefined && target.kind !== 'feet' && target.kind !== 'ladder') return delegate.navigate(target, opts);
    return super.moveTo(target, opts);
  }
}

const moveSkill = (target: MoveTarget, opts: Partial<MoveOpts> = {}): Skill => ({
  name: 'test_move', description: '', argsDoc: '', timeoutMs: 8000, movement: true,
  validate: () => ({ ok: true, args: { target, opts } }),
  async run(ctx) {
    await ctx.adapter.moveTo(target, { signal: ctx.signal, timeoutMs: Math.min(6000, ctx.deadline - Date.now()), ...opts });
    return { status: 'succeeded', summary: 'moved' };
  },
});

test('runSkill 在任务生命周期内绑定导航委托：技能与嵌套技能的非本地 moveTo 都走委托', async (t) => {
  const map = flatMap(6);
  const adapter = new DelegatingAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = { ...makeCtx(adapter), spatial: fakeSpatial(map) };
  t.after(() => ctx.memory.close());

  const inner = moveSkill({ kind: 'near', pos: { x: 3.5, y: 64, z: 0.5 }, range: 1 });
  const outer: Skill = {
    name: 'test_outer', description: '', argsDoc: '', timeoutMs: 8000, movement: true,
    validate: () => ({ ok: true, args: {} }),
    async run(skillCtx) {
      return runSkill(skillCtx, inner, {});
    },
  };
  const result = await runSkill(ctx, outer, {});
  assert.equal(result.status, 'succeeded', result.summary);
  assert.ok(adapter.feetCalls > 0, '嵌套技能内部仍由导航委托逐段调用 feet 身体控制');
  // 原 GoalNear 语义：任意节点在目标节点 (3,64,0) 的 3D 半径 1 内都算到达。
  const node = { x: Math.floor(adapter.pos.x), y: Math.floor(adapter.pos.y), z: Math.floor(adapter.pos.z) };
  assert.ok(Math.hypot(node.x - 3, node.y - 64, node.z - 0) <= 1 + 1e-9, `实测节点不在 near 半径内：${JSON.stringify(adapter.pos)}`);
  assert.ok(adapter.pos.x > 0, '身体必须真的移动过');
});

test('精确 xyz 的分数 x/z 表示所在方块列，y 是精确脚高；不走连续 feet 语义', async (t) => {
  const map = flatMap(4);
  const adapter = new DelegatingAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = { ...makeCtx(adapter), spatial: fakeSpatial(map) };
  t.after(() => ctx.memory.close());

  const result = await runSkill(ctx, moveSkill({ kind: 'xyz', x: 2.5, y: 64, z: 0.5 }), {});
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(Math.floor(adapter.pos.x), 2);
  assert.equal(Math.floor(adapter.pos.z), 0);
  assert.ok(Math.abs(adapter.pos.y - 64) <= 0.02);
});

test('已满足的 near 目标先按实测身体结算，不需要 VoxelMap 或路线探针', async (t) => {
  const adapter = new DelegatingAdapter();
  adapter.pos = { x: 1.5, y: 64, z: 0.5 };
  const ctx = makeCtx(adapter);
  t.after(() => ctx.memory.close());

  const result = await runSkill(ctx, moveSkill({ kind: 'near', pos: { x: 1.5, y: 64, z: 0.5 }, range: 1 }), {});
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(adapter.feetCalls, 0, '已满足时不应再发起任何身体移动');
});

test('委托返回但身体没有实测到位时不得当成到达', async (t) => {
  const map = flatMap(6);
  class StationaryFeetAdapter extends DelegatingAdapter {
    override async moveTo(target: MoveTarget, opts: MoveOpts) {
      if (target.kind === 'feet') { this.feetCalls += 1; this.actions.push('moveTo:feet:stationary'); return; }
      const delegate = this.currentDelegate();
      if (delegate !== undefined) return delegate.navigate(target, opts);
      return super.moveTo(target, opts);
    }
  }
  const adapter = new StationaryFeetAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = { ...makeCtx(adapter), spatial: fakeSpatial(map) };
  t.after(() => ctx.memory.close());

  const result = await runSkill(ctx, moveSkill({ kind: 'near', pos: { x: 4.5, y: 64, z: 0.5 }, range: 1 }), {});
  assert.notEqual(result.status, 'succeeded', result.summary);
  assert.ok(!result.summary.includes('moved'), '不能把委托/动作回执当成实测到达');
  assert.equal(Math.floor(adapter.pos.x), 0, '身体实际没有移动');
});

test('取消在委托前传播：不发起任何身体移动', async (t) => {
  const map = flatMap(4);
  const adapter = new DelegatingAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  const controller = new AbortController();
  controller.abort();
  const ctx = { ...makeCtx(adapter), spatial: fakeSpatial(map), signal: controller.signal };
  t.after(() => ctx.memory.close());

  await assert.rejects(runSkill(ctx, moveSkill({ kind: 'near', pos: { x: 3.5, y: 64, z: 0.5 }, range: 1 }), {}), { name: 'AbortedError' });
  assert.equal(adapter.feetCalls, 0, '取消后不应派发 feet 动作');
});

test('follow_entity 只使用合法感知，不读适配器原始实体表；按当前实体位置验收', async (t) => {
  const map = flatMap(8);
  class FencedAdapter extends DelegatingAdapter {
    nearbyCalls = 0;
    override nearbyEntities(): never {
      this.nearbyCalls += 1;
      throw new Error('NO_XRAY');
    }
  }
  const adapter = new FencedAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  const entity = { id: 42, name: 'cow', kind: 'passive' as const, pos: { x: 4.5, y: 64, z: 0.5 }, dist: 4, height: 1.4 };
  const ctx = { ...makeCtx(adapter, { senses: { perceivedEntities: () => [entity] } }), spatial: fakeSpatial(map) };
  t.after(() => ctx.memory.close());

  const result = await runSkill(ctx, moveSkill({ kind: 'follow_entity', entityId: 42, range: 1 }), {});
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(adapter.nearbyCalls, 0, '实时调度禁止 nearbyEntities；follow 必须走 ctx.senses');
  const node = Math.floor(adapter.pos.x);
  assert.ok(Math.hypot(node - 4, Math.floor(adapter.pos.y) - 64, Math.floor(adapter.pos.z) - 0) <= 1 + 1e-9, `实测节点不在实体半径内：${JSON.stringify(adapter.pos)}`);
});

test('follow_entity 取消后不把旧实体位置当成到达', async (t) => {
  const map = flatMap(10);
  const controller = new AbortController();
  class AbortingFollowAdapter extends DelegatingAdapter {
    override nearbyEntities(): never { throw new Error('NO_XRAY'); }
    override async moveTo(target: MoveTarget, opts: MoveOpts) {
      if (target.kind === 'feet') {
        this.feetCalls += 1;
        setTimeout(() => controller.abort(), 20);
        await new Promise((resolve) => setTimeout(resolve, 40));
        return super.moveTo(target, { ...opts, signal: controller.signal });
      }
      return super.moveTo(target, opts);
    }
  }
  const adapter = new AbortingFollowAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  const entity = { id: 7, name: 'cow', kind: 'passive' as const, pos: { x: 8.5, y: 64, z: 0.5 }, dist: 8, height: 1.4 };
  const ctx = { ...makeCtx(adapter, { senses: { perceivedEntities: () => [entity] } }), spatial: fakeSpatial(map), signal: controller.signal };
  t.after(() => ctx.memory.close());

  await assert.rejects(runSkill(ctx, moveSkill({ kind: 'follow_entity', entityId: 7, range: 1 }), {}), { name: 'AbortedError' });
  assert.equal(adapter.pos.x, 0.5, '取消后不得声称已到旧实体位置');
});

test('取消在委托途中传播：保留取消语义且不追加后续动作', async (t) => {
  const map = flatMap(6);
  const controller = new AbortController();
  class AbortingAdapter extends DelegatingAdapter {
    override async moveTo(target: MoveTarget, opts: MoveOpts) {
      if (target.kind === 'feet') {
        setTimeout(() => controller.abort(), 20);
        await new Promise((resolve) => setTimeout(resolve, 40));
        return super.moveTo(target, { ...opts, signal: controller.signal });
      }
      return super.moveTo(target, opts);
    }
  }
  const adapter = new AbortingAdapter();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = { ...makeCtx(adapter), spatial: fakeSpatial(map), signal: controller.signal };
  t.after(() => ctx.memory.close());

  await assert.rejects(runSkill(ctx, moveSkill({ kind: 'near', pos: { x: 5.5, y: 64, z: 0.5 }, range: 1 }), {}), (error: Error) => error.name === 'AbortedError' || error.message.includes('cancel'));
  const afterAbort = adapter.feetCalls;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(adapter.feetCalls, afterAbort, '取消后不得再派发新的身体动作');
});
