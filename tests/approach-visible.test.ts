import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoxelMap } from 'curio-minecraft-3d-memory';
import type { EntityInfo, MoveOpts, MoveTarget, Vec3Like } from '../src/adapter/types.ts';
import type { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import type { FailureCode, Senses, SkillCtx, SkillResult } from '../src/skills/types.ts';
import { navigationOutcome } from '../src/skills/movement/approach-visible.ts';
import { approachVisible } from '../src/skills/movement/index.ts';
import type { LandSearchResult } from '../src/spatial/land-search.ts';
import { SKILLS } from '../src/skills/index.ts';
import type { FakeAdapter } from './fake-adapter.ts';
import { FakeAdapter as Fake } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const WORLD = 'fake-world', DIM = 'overworld', SESSION = 'fake-session';
let sequence = 0;

type Cell = { x: number; y: number; z: number };
type TargetArg =
  | { pos: Cell }
  | { block: Cell }
  | { entity: { id?: number; name?: string } };
type Overrides = {
  radius?: number;
  allowed?: ('walk' | 'step' | 'drop')[];
  historical?: boolean;
  maxSteps?: number;
  allowUnknownCorridor?: boolean;
};

function fillState(map: VoxelMap, name: string, properties: Record<string, string>, cells: Cell[]) {
  for (const pos of cells) {
    sequence += 1;
    map.observe({
      worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: Date.now(), sequence,
      source: 'vision', evidence: 'seen', stateComplete: true, state: { name, properties }, pos,
    });
  }
}

/** 一张共享地图的每个格子只写一次；同一格重复观察不同状态会被库标记为 conflict/STALE。 */
function worldMap(layers: { name: string; properties?: Record<string, string>; cells: Cell[] }[]) {
  const map = new VoxelMap(WORLD, { validityWindowMs: 60_000 });
  for (const layer of layers) fillState(map, layer.name, layer.properties ?? {}, layer.cells);
  return map;
}

function airCells(maxX: number, zs: readonly number[] = [-1, 0, 1]): Cell[] {
  const cells: Cell[] = [];
  for (let x = -1; x <= maxX; x++) for (let y = 64; y <= 66; y++) for (const z of zs) cells.push({ x, y, z });
  return cells;
}

function floorCells(maxX: number, zs: readonly number[] = [0]): Cell[] {
  const cells: Cell[] = [];
  for (let x = -1; x <= maxX; x++) for (const z of zs) cells.push({ x, y: 63, z });
  return cells;
}

const exceptCells = (cells: Cell[], skipped: Cell[]) => cells.filter((cell) => !skipped.some((skip) => skip.x === cell.x && skip.y === cell.y && skip.z === cell.z));

function flatMap(maxX = 5) {
  return worldMap([
    { name: 'minecraft:air', cells: airCells(maxX) },
    { name: 'minecraft:grass_block', cells: floorCells(maxX) },
  ]);
}

/** 只有 z=0 一条已观察走廊；floorMaxX 控制地板观察到哪一格。相邻行没有证据，未知不能被当成可走。 */
function corridorMap(maxX: number, floorMaxX: number) {
  return worldMap([
    { name: 'minecraft:air', cells: airCells(maxX, [0]) },
    { name: 'minecraft:grass_block', cells: floorCells(floorMaxX) },
  ]);
}

/** z=0 近侧被地图证据挡死、z=-1 侧已观察的窄巷：用来比较“最近但走不通”和“稍远但可走”。
 *  实际身体在 z=-1 站位的 AABB 会跨到 z=-2，所以那条列也要有观察证据；z=1 侧不用来绕行。 */
function laneMap() {
  return worldMap([
    // 地图与适配器都要有同一条真实障碍/目标事实：近侧墙、目标箱子本身。
    { name: 'minecraft:air', cells: exceptCells(airCells(4, [-2, -1, 0, 1]), [{ x: 1, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }]) },
    { name: 'minecraft:grass_block', cells: floorCells(4, [-2, -1, 0, 1]) },
    // 地图证据说这一格是墙；适配器仍说它是空气，用来验证“站位合法 ≠ 路线可走”。
    { name: 'minecraft:stone', cells: [{ x: 1, y: 64, z: 0 }] },
    { name: 'minecraft:chest', cells: [{ x: 2, y: 64, z: 0 }] },
  ]);
}

/** 地图里也记着目标方块（与适配器一致）；四格宽走廊允许从旁边绕过去。
 *  非格心身体的 AABB 会压到 z=-2 邻列，所以那条实际会被身体占用的列也要有合法观察证据。 */
function chestMap(maxX = 5, chests: Cell[] = [{ x: 2, y: 64, z: 0 }]) {
  return worldMap([
    { name: 'minecraft:air', cells: exceptCells(airCells(maxX, [-2, -1, 0, 1]), chests) },
    { name: 'minecraft:grass_block', cells: floorCells(maxX, [-2, -1, 0, 1]) },
    { name: 'minecraft:chest', cells: chests },
  ]);
}

function fakeSpatial(map: VoxelMap) {
  return {
    worldId: WORLD,
    session: { voxel: map, history: { worldId: WORLD, getFragment: () => null, fragments: () => ({ items: [], total: 0 }) } },
    closing: false, paused: false, observationAdmitted: true,
    capabilities: () => ({
      owner: 'host_composed', contract: 'memory-host-contract/2',
      library: {}, host: { execute: { walk: true, groundedArrival: true, invalidation: true, cancellation: true } },
      effective: { execute: { walk: true, groundedArrival: true, invalidation: true, cancellation: true } },
      overclaims: [],
    }),
  } as unknown as SharedSpatialSession;
}

function context(adapter: FakeAdapter, map: VoxelMap, senses?: Partial<Senses>): SkillCtx {
  adapter.worldId = WORLD;
  adapter.sessionId = SESSION;
  adapter.dim = DIM;
  return { ...makeCtx(adapter, { senses }), spatial: fakeSpatial(map) };
}

function setup(map: VoxelMap, pos: Vec3Like = { x: 0.3, y: 64, z: 0.2 }, senses?: Partial<Senses>) {
  const adapter = new Fake();
  adapter.pos = { ...pos };
  return { adapter, ctx: context(adapter, map, senses) };
}

const call = (ctx: SkillCtx, target: TargetArg, overrides: Overrides = {}): Promise<SkillResult> => {
  const validated = approachVisible.validate({ target, radius: 32, allowed: ['walk', 'step'], historical: true, ...overrides }, ctx.adapter);
  if (!validated.ok) throw new Error(validated.error);
  return approachVisible.run(ctx, validated.args);
};

const moveCount = (adapter: FakeAdapter) => adapter.actions.filter((action) => action.startsWith('moveTo:')).length;
const assertNoTerrainChange = (adapter: FakeAdapter) => {
  assert.ok(!adapter.actions.some((action) => /^dig:|^place:/.test(action)), `不应挖/放：${adapter.actions.join(',')}`);
};

class MovingCowWorld extends Fake {
  moved = false;
  override async moveTo(target: MoveTarget, opts: MoveOpts) {
    await super.moveTo(target, opts);
    if (!this.moved) {
      this.moved = true;
      this.entities = this.entities.map((entity) => entity.id === 7 ? { ...entity, pos: { ...entity.pos, x: entity.pos.x + 6 } } : entity);
    }
  }
}

class VanishChestWorld extends Fake {
  vanished = false;
  override async moveTo(target: MoveTarget, opts: MoveOpts) {
    await super.moveTo(target, opts);
    if (!this.vanished) {
      this.vanished = true;
      this.blocks = this.blocks.filter((block) => !(block.pos.x === 2 && block.pos.y === 64 && block.pos.z === 0));
      this.removed.add('2,64,0');
    }
  }
}

class BlockingWorld extends Fake {
  override async moveTo(_target: MoveTarget, opts: MoveOpts) {
    this.actions.push('moveTo:xyz');
    await new Promise<void>((_resolve, reject) => {
      const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortedError' }));
      if (opts.signal.aborted) return abort();
      opts.signal.addEventListener('abort', abort, { once: true });
    });
  }
}

test('approach_visible 已注册，且校验 target 三选一与方块整数坐标', () => {
  const w = new Fake();
  assert.equal(SKILLS.approach_visible, approachVisible);
  assert.equal(approachVisible.validate({ target: { pos: { x: 1, y: 64, z: 0 } } }, w).ok, true);
  assert.equal(approachVisible.validate({ target: { block: { x: 1, y: 64, z: 0 } } }, w).ok, true);
  assert.equal(approachVisible.validate({ target: { block: { x: 1.5, y: 64, z: 0 } } }, w).ok, false);
  assert.equal(approachVisible.validate({ target: { entity: { name: 'cow' } } }, w).ok, true);
  assert.equal(approachVisible.validate({ target: {} }, w).ok, false);
  assert.equal(approachVisible.validate({ target: { pos: { x: 0, y: 64, z: 0 }, block: { x: 1, y: 64, z: 0 } } }, w).ok, false);
  assert.equal(approachVisible.validate({ target: { pos: { x: 0, y: 64, z: 0 } }, maxSteps: 0 }, w).ok, false);
  assert.equal(approachVisible.validate({ target: { pos: { x: 0, y: 64, z: 0 } }, radius: 65 }, w).ok, false, '局部范围上限是 64，视觉范围只能再调低');
  for (const request of [
    { target: { pos: { x: 0, y: 64, z: 0 } }, allowDig: false },
    { target: { pos: { x: 0, y: 64, z: 0 } }, avoid: [] },
    { target: { pos: { x: 0, y: 64, z: 0 } }, extra: undefined },
    { target: { pos: { x: 0, y: 64, z: 0 } }, backend: 'pathfinder' },
  ]) assert.equal(approachVisible.validate(request, w).ok, false, JSON.stringify(request));
  assert.equal(approachVisible.validate({ target: { pos: { x: 0, y: 64, z: 0 } }, make: false }, w).ok, true, '通用 make 不应被当作未知参数');
});

test('approach_visible 的校验对自己的规范化输出幂等（Arbiter 执行前会再校验一次）', () => {
  const w = new Fake();
  for (const target of [
    { pos: { x: 1, y: 64, z: 0 } },
    { block: { x: 1, y: 64, z: 0 } },
    { entity: { id: 7, name: 'cow' } },
  ]) {
    const once = approachVisible.validate({ target, radius: 16 }, w);
    assert.equal(once.ok, true, JSON.stringify(target));
    if (!once.ok) continue;
    const twice = approachVisible.validate(once.args, w);
    assert.equal(twice.ok, true, `规范化输出应能再次通过校验：${JSON.stringify(once.args)}`);
    assert.deepEqual(twice.ok ? twice.args?.target : null, once.args?.target);
  }
});

test('approach_visible 从非格心起点接近一个位置，返回 ARRIVED 与实际位移', async (t) => {
  const { adapter, ctx } = setup(flatMap());
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { pos: { x: 3.5, y: 64, z: 0.5 } }, { maxSteps: 8 });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.outcome, 'ARRIVED');
  assert.deepEqual(r.data?.originalTarget, { kind: 'position', pos: { x: 3.5, y: 64, z: 0.5 } });
  assert.equal(Math.floor(adapter.pos.x), 3);
  assert.ok((r.data?.displacement as number) > 2);
  assert.equal((r.data?.interaction as { kind: string }).kind, 'position');
  assertNoTerrainChange(adapter);
});

test('approach_visible 接近一个方块旁的合法站位，区分实测到达与交互距离', async (t) => {
  const map = flatMap();
  const { adapter, ctx } = setup(map);
  adapter.blocks.push({ name: 'chest', pos: { x: 2, y: 64, z: 0 } });
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { block: { x: 2, y: 64, z: 0 } }, { maxSteps: 8 });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.outcome, 'ARRIVED');
  assert.deepEqual((r.data?.originalTarget as { kind: string }).kind, 'block');
  const pos = adapter.pos;
  assert.ok(Math.hypot(pos.x - 2.5, pos.z - 0.5) <= 1.8, `应停在方块旁：${JSON.stringify(pos)}`);
  const interaction = r.data?.interaction as { kind: string; inReach: boolean; reach: number };
  assert.equal(interaction.kind, 'block');
  assert.equal(interaction.inReach, true);
  assert.ok(interaction.reach <= 2.5);
  assert.ok(Array.isArray(r.data?.candidates) && (r.data?.candidates as unknown[]).length > 1, '应比较多个候选站位');
  assertNoTerrainChange(adapter);
});

test('approach_visible 接近一个已看见的实体，使用其脚下支撑的相邻站位', async (t) => {
  const map = flatMap();
  const { adapter, ctx } = setup(map);
  adapter.entities.push({ id: 7, name: 'cow', kind: 'passive', pos: { x: 2.5, y: 64, z: 0.5 } } as EntityInfo);
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { entity: { id: 7 } }, { maxSteps: 8 });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.outcome, 'ARRIVED');
  assert.equal((r.data?.entity as EntityInfo | undefined)?.id, 7);
  assert.ok(Math.hypot(adapter.pos.x - 2.5, adapter.pos.z - 0.5) <= 2.5);
  assert.equal((r.data?.interaction as { kind: string }).kind, 'entity');
});

test('approach_visible 对移动中的实体返回 PARTIAL，不追改目标', async (t) => {
  const map = flatMap();
  const adapter = new MovingCowWorld();
  adapter.pos = { x: 0.3, y: 64, z: 0.2 };
  adapter.entities.push({ id: 7, name: 'cow', kind: 'passive', pos: { x: 2.5, y: 64, z: 0.5 } } as EntityInfo);
  const ctx = context(adapter, map);
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { entity: { id: 7 } });
  assert.equal(r.status, 'failed', r.summary);
  assert.equal(r.data?.outcome, 'PARTIAL');
  assert.equal(r.data?.stop, 'NOT_CONFIRMED');
  assert.deepEqual(r.data?.originalTarget, { kind: 'entity', id: 7 });
  const interaction = r.data?.interaction as { inReach: boolean; reach: number };
  assert.equal(interaction.inReach, false);
  assert.ok(interaction.reach > 3);
  assert.equal((r.data?.entityBefore as EntityInfo).pos.x, 2.5);
  assert.equal((r.data?.entity as EntityInfo).pos.x, 8.5);
});

test('approach_visible 排除双箱的另一半，不把结构格当站位', async (t) => {
  const map = chestMap(5, [{ x: 1, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }]);
  const { adapter, ctx } = setup(map);
  adapter.blocks.push({ name: 'chest', pos: { x: 1, y: 64, z: 0 } }, { name: 'chest', pos: { x: 2, y: 64, z: 0 } });
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { block: { x: 2, y: 64, z: 0 } });
  assert.equal(r.status, 'succeeded', `${r.summary}；data=${JSON.stringify(r.data)}`);
  assert.equal(r.data?.outcome, 'ARRIVED', JSON.stringify(r.data));
  const rejected = r.data?.rejected as { cell: Cell; status: string }[];
  assert.ok(rejected.some((entry) => entry.status === 'STRUCTURE' && entry.cell.x === 1 && entry.cell.z === 0), JSON.stringify(rejected));
  const stance = r.data?.resolvedStance as Vec3Like;
  assert.ok(!(Math.floor(stance.x) === 1 && Math.floor(stance.z) === 0), `不应站在另一格箱子：${JSON.stringify(stance)}`);
});

test('approach_visible 使用真实半砖支撑（y=63.5）并验证身体净空', async (t) => {
  const map = worldMap([
    { name: 'minecraft:air', cells: exceptCells(airCells(5), [{ x: 2, y: 64, z: 0 }]) },
    // 实际起点偏心：身体在 (1.3,63.5,0.2) 的 AABB 会压进 z=-1 的相邻列，
    // 因此相邻列必须是同一种底面半砖（顶面 63.5）；整块草方块会在 y=63.5..64 与身体真实相交。
    { name: 'minecraft:grass_block', cells: exceptCells(floorCells(5, [-1, 0]), [{ x: 1, y: 63, z: 0 }, { x: 1, y: 63, z: -1 }]) },
    { name: 'minecraft:stone_slab', properties: { type: 'bottom' }, cells: [{ x: 1, y: 63, z: 0 }, { x: 1, y: 63, z: -1 }] },
    // 地图里的目标箱子与适配器一致，不让搜索把目标格当成空气通道。
    { name: 'minecraft:chest', cells: [{ x: 2, y: 64, z: 0 }] },
  ]);
  const { adapter, ctx } = setup(map);
  adapter.blocks.push(
    { name: 'stone_slab', pos: { x: 1, y: 63, z: 0 } },
    { name: 'stone_slab', pos: { x: 1, y: 63, z: -1 } },
    { name: 'chest', pos: { x: 2, y: 64, z: 0 } },
  );
  adapter.blockProperties.set('1,63,0', { type: 'bottom' });
  adapter.blockProperties.set('1,63,-1', { type: 'bottom' });
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { block: { x: 2, y: 64, z: 0 } }, { allowed: ['walk', 'step', 'drop'] });
  assert.equal(r.status, 'succeeded', `${r.summary}；data=${JSON.stringify(r.data)}`);
  assert.equal(r.data?.outcome, 'ARRIVED', JSON.stringify(r.data));
  const stance = r.data?.resolvedStance as Vec3Like;
  assert.equal(stance.x, 1.5, `应选半砖站位；data=${JSON.stringify(r.data)}`);
  assert.equal(stance.y, 63.5, `应选半砖站位；data=${JSON.stringify(r.data)}`);
  assert.equal(adapter.pos.y, 63.5, `实测脚高；data=${JSON.stringify(r.data)}`);
  assert.equal((r.data?.interaction as { inReach: boolean }).inReach, true, JSON.stringify(r.data));
});

test('approach_visible 拒绝头顶被占的站位，改用其他合法站位', async (t) => {
  const map = worldMap([
    // 平地绕行到 z=-1 的实际身体 AABB 会压到 z=-2；那条列也要有真实可走的观察证据。
    { name: 'minecraft:air', cells: exceptCells(airCells(5, [-2, -1, 0, 1]), [{ x: 1, y: 65, z: 0 }, { x: 2, y: 64, z: 0 }]) },
    { name: 'minecraft:grass_block', cells: exceptCells(floorCells(5, [-2, -1, 0, 1]), [{ x: 1, y: 63, z: 0 }]) },
    { name: 'minecraft:stone_slab', properties: { type: 'bottom' }, cells: [{ x: 1, y: 63, z: 0 }] },
    { name: 'minecraft:stone', cells: [{ x: 1, y: 65, z: 0 }] },
    { name: 'minecraft:chest', cells: [{ x: 2, y: 64, z: 0 }] },
  ]);
  const { adapter, ctx } = setup(map);
  adapter.blocks.push(
    { name: 'stone_slab', pos: { x: 1, y: 63, z: 0 } },
    { name: 'stone', pos: { x: 1, y: 65, z: 0 } },
    { name: 'chest', pos: { x: 2, y: 64, z: 0 } },
  );
  adapter.blockProperties.set('1,63,0', { type: 'bottom' });
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { block: { x: 2, y: 64, z: 0 } }, { allowed: ['walk', 'step', 'drop'] });
  assert.equal(r.status, 'succeeded', `${r.summary}；data=${JSON.stringify(r.data)}`);
  assert.equal(r.data?.outcome, 'ARRIVED', JSON.stringify(r.data));
  const rejected = r.data?.rejected as { cell: Cell; status: string; reason: string }[];
  assert.ok(rejected.some((entry) => entry.cell.x === 1 && entry.cell.z === 0 && entry.status === 'UNSUPPORTED' && /身体空间/.test(entry.reason)), JSON.stringify(rejected));
  const stance = r.data?.resolvedStance as Vec3Like;
  assert.notEqual(stance.y, 63.5);
  assert.ok(Math.abs(stance.x - 1.5) > 0.01 || Math.abs(stance.z - 0.5) > 0.01, JSON.stringify(stance));
});

test('approach_visible 缺少支撑时返回 UNSUPPORTED，且不移动', async (t) => {
  const map = flatMap();
  const { adapter, ctx } = setup(map);
  adapter.blocks.push({ name: 'chest', pos: { x: 2, y: 66, z: 0 } });
  const before = { ...adapter.pos };
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { block: { x: 2, y: 66, z: 0 } });
  assert.equal(r.status, 'failed', r.summary);
  assert.equal(r.data?.outcome, 'UNSUPPORTED');
  assert.equal((r.data?.rejectedCounts as Record<string, number>).UNSUPPORTED, 24);
  assert.deepEqual(adapter.pos, before);
});

test('approach_visible 在证据未观察时返回 UNKNOWN，不把未知当可达', async (t) => {
  const map = corridorMap(3, 0);
  const { adapter, ctx } = setup(map);
  adapter.blocks.push({ name: 'chest', pos: { x: 2, y: 64, z: 0 } });
  const before = { ...adapter.pos };
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { block: { x: 2, y: 64, z: 0 } });
  assert.equal(r.status, 'failed', r.summary);
  assert.equal(r.data?.outcome, 'UNKNOWN');
  assert.equal(r.data?.evidenceState, 'UNKNOWN');
  assert.ok((r.data?.evidence as { unknown: number }).unknown > 0);
  assert.deepEqual(adapter.pos, before);
});

test('approach_visible 区分 STALE 与 UNKNOWN，并保留边界计数', async (t) => {
  const map = flatMap();
  // 只有自身动作效果未确认（pending_effect）才是陈旧；时间与会话不使证据老化。
  for (const pos of [...airCells(5), ...floorCells(5)]) map.invalidatePendingEffect(DIM, pos);
  const { adapter, ctx } = setup(map);
  adapter.blocks.push({ name: 'chest', pos: { x: 2, y: 64, z: 0 } });
  const before = { ...adapter.pos };
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { block: { x: 2, y: 64, z: 0 } }, { historical: false });
  assert.equal(r.status, 'failed', r.summary);
  assert.equal(r.data?.outcome, 'UNKNOWN');
  assert.equal(r.data?.evidenceState, 'STALE');
  assert.ok((r.data?.evidence as { stale: number }).stale > 0);
  assert.deepEqual(adapter.pos, before);
});

test('approach_visible 执行超过 16 段的普通近距离路线，不按默认 16 段截断', async (t) => {
  const map = corridorMap(25, 25);
  const { adapter, ctx } = setup(map, { x: 0.5, y: 64, z: 0.5 }, { effectiveRange: () => 64 });
  adapter.blocks.push({ name: 'chest', pos: { x: 22, y: 64, z: 0 } });
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { block: { x: 22, y: 64, z: 0 } });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.outcome, 'ARRIVED');
  const navigation = r.data?.navigation as { executed: number };
  assert.ok(navigation.executed > 16, `实际执行 ${navigation.executed} 段`);
  assert.ok((r.data?.budget as { maxSteps: number }).maxSteps > 16);
  assert.equal(Math.floor(adapter.pos.x), 21);
});

test('approach_visible 只执行已确认前缀并在边界停住，返回 PARTIAL', async (t) => {
  const map = corridorMap(9, 4);
  const { adapter, ctx } = setup(map, { x: 0.5, y: 64, z: 0.5 }, { effectiveRange: () => 64 });
  adapter.blocks.push({ name: 'chest', pos: { x: 8, y: 64, z: 0 } });
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { block: { x: 8, y: 64, z: 0 } });
  assert.equal(r.status, 'failed', r.summary);
  assert.equal(r.data?.outcome, 'PARTIAL');
  assert.equal(r.data?.stop, 'UNKNOWN');
  assert.equal(r.data?.evidenceState, 'UNKNOWN');
  assert.ok((r.data?.evidence as { unknown: number }).unknown > 0);
  assert.ok((r.data?.confirmedSegments as number) >= 1);
  assert.equal(Math.floor(adapter.pos.x), 4);
  assert.deepEqual(r.data?.originalTarget, { kind: 'block', pos: { x: 8, y: 64, z: 0 } });
  assert.equal((r.data?.prefix as { endpoint: Vec3Like }).endpoint.x, 4.5);
  assertNoTerrainChange(adapter);
});

test('approach_visible 用有界局部观察补足 VoxelMap 证据，不要求先走过去', async (t) => {
  const map = corridorMap(9, 6);
  const adapter = new Fake();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.blocks.push({ name: 'chest', pos: { x: 8, y: 64, z: 0 } });
  assert.equal(map.cellAt(DIM, 7, 63, 0).observed, false, '观察前应缺少目标站位下方支撑证据');
  const ctx = context(adapter, map, {
    effectiveRange: () => 64,
    // 模拟 Vision：只返回看得见的目标附近方块，并把合法观察写回同一张共享 VoxelMap。
    observeBlocks: (positions) => {
      const seen = positions
        .map((pos) => {
          const name = adapter.blockAt(pos);
          return name === null ? null : {
            pos: { ...pos }, name, properties: adapter.blockStateAt?.(pos)?.properties ?? {},
            worldId: WORLD, sessionId: SESSION, dimension: DIM, observationId: 1, observedAt: Date.now(), source: 'vision' as const, stateComplete: true,
          };
        })
        .filter((block): block is NonNullable<typeof block> => block !== null);
      for (const block of seen) {
        sequence += 1;
        map.observe({
          worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: block.observedAt, sequence,
          source: 'vision', evidence: 'seen', stateComplete: true,
          state: { name: block.name, properties: Object.fromEntries(Object.entries(block.properties).map(([key, value]) => [key, String(value)])) }, pos: block.pos,
        });
      }
      return seen;
    },
  });
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { block: { x: 8, y: 64, z: 0 } });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.outcome, 'ARRIVED');
  const observation = r.data?.evidence as { localObservation: { attempted: boolean; acquired: number; missingBefore: number } };
  assert.equal(observation.localObservation.attempted, true);
  assert.ok(observation.localObservation.missingBefore > 0);
  assert.ok(observation.localObservation.acquired > 0);
  const local = r.data?.evidence as { localObservation: { requested: number; newObservedCells: number } };
  assert.ok(local.localObservation.requested <= 33, `有界观察只应覆盖目标附近：${local.localObservation.requested}`);
  assert.ok(local.localObservation.newObservedCells > 0, '观察应真正写进共享 VoxelMap');
  assert.equal(map.cellAt(DIM, 7, 63, 0).observed, true, '观察应写回共享 VoxelMap');
  assert.equal((r.data?.resolvedStance as Vec3Like).x, 7.5);
});

test('approach_visible 在目标方块消失时返回 INVALIDATED，保留实测站位', async (t) => {
  const map = flatMap();
  const adapter = new VanishChestWorld();
  adapter.pos = { x: 0.3, y: 64, z: 0.2 };
  adapter.blocks.push({ name: 'chest', pos: { x: 2, y: 64, z: 0 } });
  const ctx = context(adapter, map);
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { block: { x: 2, y: 64, z: 0 } });
  assert.equal(r.status, 'failed', r.summary);
  assert.equal(r.data?.outcome, 'INVALIDATED');
  assert.equal(r.data?.stop, 'INVALIDATED');
  assert.equal(r.data?.targetNow, 'air');
  assert.ok((r.data?.displacement as number) > 0);
  assert.equal(Math.floor(adapter.pos.x), 1);
});

test('approach_visible 不把“区块已加载”当成已观察目标', async (t) => {
  const map = worldMap([
    { name: 'minecraft:air', cells: exceptCells(airCells(5), [{ x: 2, y: 64, z: 0 }]) },
    { name: 'minecraft:grass_block', cells: floorCells(5) },
  ]);
  const adapter = new Fake();
  adapter.pos = { x: 0.3, y: 64, z: 0.2 };
  adapter.blocks.push({ name: 'chest', pos: { x: 2, y: 64, z: 0 } });
  const ctx = context(adapter, map, { observeBlocks: () => [] });
  const before = { ...adapter.pos };
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { block: { x: 2, y: 64, z: 0 } });
  assert.equal(r.status, 'failed', r.summary);
  assert.equal(r.data?.outcome, 'UNKNOWN');
  assert.equal(r.data?.evidenceSource, 'unobserved');
  assert.deepEqual(adapter.pos, before);
});

test('approach_visible 在开始前已取消时返回 cancelled 且不移动', async (t) => {
  const { adapter, ctx } = setup(flatMap());
  const controller = new AbortController();
  controller.abort();
  ctx.signal = controller.signal;
  const before = { ...adapter.pos };
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { block: { x: 2, y: 64, z: 0 } });
  assert.equal(r.status, 'cancelled', r.summary);
  assert.equal(r.data?.outcome, 'CANCELLED');
  assert.deepEqual(adapter.pos, before);
});

test('approach_visible 在父取消时中断执行并保留实测事实', async (t) => {
  const map = flatMap();
  const adapter = new BlockingWorld();
  adapter.pos = { x: 0.3, y: 64, z: 0.2 };
  adapter.blocks.push({ name: 'chest', pos: { x: 2, y: 64, z: 0 } });
  const ctx = context(adapter, map);
  const controller = new AbortController();
  ctx.signal = controller.signal;
  const timer = setTimeout(() => controller.abort(), 30);
  t.after(() => { clearTimeout(timer); ctx.memory.close(); });
  const r = await call(ctx, { block: { x: 2, y: 64, z: 0 } });
  assert.equal(r.status, 'cancelled', r.summary);
  assert.equal(r.data?.outcome, 'CANCELLED');
  assert.deepEqual(r.data?.originalTarget, { kind: 'block', pos: { x: 2, y: 64, z: 0 } });
  assert.ok(r.data?.position !== undefined);
});

test('approach_visible 在父期限耗尽时返回 TIMEOUT 且不移动', async (t) => {
  const { adapter, ctx } = setup(flatMap());
  ctx.deadline = Date.now() - 1;
  const before = { ...adapter.pos };
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { block: { x: 2, y: 64, z: 0 } });
  assert.equal(r.status, 'failed', r.summary);
  assert.equal(r.failureCode, 'TIMEOUT');
  assert.equal(r.data?.outcome, 'TIMEOUT');
  assert.deepEqual(adapter.pos, before);
});

test('approach_visible 比较候选路线，不先执行最近但走不通的站位', async (t) => {
  const map = laneMap();
  const { adapter, ctx } = setup(map);
  adapter.blocks.push({ name: 'chest', pos: { x: 2, y: 64, z: 0 } });
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { block: { x: 2, y: 64, z: 0 } });
  assert.equal(r.status, 'succeeded', `${r.summary}；data=${JSON.stringify(r.data)}`);
  assert.equal(r.data?.outcome, 'ARRIVED', JSON.stringify(r.data));
  assert.equal(r.data?.routeMode, 'current', JSON.stringify(r.data));
  const stance = r.data?.resolvedStance as Vec3Like;
  assert.notDeepEqual({ x: Math.floor(stance.x), y: Math.floor(stance.y), z: Math.floor(stance.z) }, { x: 1, y: 64, z: 0 });
  const candidates = r.data?.candidates as { cell: Cell; mode: string; stance: Vec3Like }[];
  const near = candidates.find((entry) => entry.cell.x === 1 && entry.cell.z === 0);
  assert.ok(near !== undefined, JSON.stringify(candidates));
  assert.notEqual(near.mode, 'current');
  assert.notDeepEqual(near.stance, stance);
  // 只执行选中的那一条路线（2 段），不因最近候选失败而多走一轮。
  assert.equal(moveCount(adapter), 2, adapter.actions.join(','));
  assertNoTerrainChange(adapter);
});

/** 到达后把 id=7 的牛移走，并在原地放一只同名的 id=12；不能把目标悄悄换成 12。 */
class SwapCowWorld extends Fake {
  swapped = false;
  override async moveTo(target: MoveTarget, opts: MoveOpts) {
    await super.moveTo(target, opts);
    if (!this.swapped) {
      this.swapped = true;
      this.entities = this.entities.map((entity) => entity.id === 7 ? { ...entity, pos: { ...entity.pos, x: entity.pos.x + 6 } } : entity);
      this.entities.push({ id: 12, name: 'cow', kind: 'passive', pos: { x: 2.5, y: 64, z: 0.5 } } as EntityInfo);
    }
  }
}

test('approach_visible 按名字选实体，并按 id 保留同一目标', async (t) => {
  const map = flatMap();
  const { adapter, ctx } = setup(map);
  adapter.entities.push({ id: 7, name: 'cow', kind: 'passive', pos: { x: 2.5, y: 64, z: 0.5 } } as EntityInfo);
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { entity: { name: 'cow' } });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.outcome, 'ARRIVED');
  assert.equal((r.data?.entity as EntityInfo).id, 7);
});

test('approach_visible 不把 heard 实体当作初始接近目标', async (t) => {
  const map = flatMap();
  const adapter = new Fake();
  adapter.pos = { x: 0.3, y: 64, z: 0.2 };
  adapter.entities.push({ id: 7, name: 'cow', kind: 'passive', pos: { x: 2.5, y: 64, z: 0.5 } } as EntityInfo);
  const ctx = context(adapter, map, {
    perceivedEntities: (radius) => adapter.nearbyEntities(radius).map((entity) => ({ ...entity, perception: 'heard' as const })),
  });
  const before = { ...adapter.pos };
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { entity: { id: 7 } });
  assert.equal(r.status, 'failed', r.summary);
  assert.equal(r.data?.outcome, 'UNKNOWN');
  assert.deepEqual(adapter.pos, before);
});

test('approach_visible 位置请求允许半砖脚高差在到达容差内', async (t) => {
  const map = worldMap([
    { name: 'minecraft:air', cells: exceptCells(airCells(5), [{ x: 2, y: 64, z: 0 }]) },
    // 实际起点偏心：身体在 (1.3,63.5,0.2) 的 AABB 会压进 z=-1 的相邻列，
    // 因此相邻列必须是同一种底面半砖（顶面 63.5）；整块草方块会在 y=63.5..64 与身体真实相交。
    { name: 'minecraft:grass_block', cells: exceptCells(floorCells(5, [-1, 0]), [{ x: 1, y: 63, z: 0 }, { x: 1, y: 63, z: -1 }]) },
    { name: 'minecraft:stone_slab', properties: { type: 'bottom' }, cells: [{ x: 1, y: 63, z: 0 }, { x: 1, y: 63, z: -1 }] },
    // 地图里的目标箱子与适配器一致，不让搜索把目标格当成空气通道。
    { name: 'minecraft:chest', cells: [{ x: 2, y: 64, z: 0 }] },
  ]);
  const { adapter, ctx } = setup(map);
  adapter.blocks.push({ name: 'stone_slab', pos: { x: 1, y: 63, z: 0 } }, { name: 'stone_slab', pos: { x: 1, y: 63, z: -1 } });
  adapter.blockProperties.set('1,63,0', { type: 'bottom' });
  adapter.blockProperties.set('1,63,-1', { type: 'bottom' });
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { pos: { x: 1.5, y: 64, z: 0.5 } }, { allowed: ['walk', 'step', 'drop'] });
  assert.equal(r.status, 'succeeded', `${r.summary}；data=${JSON.stringify(r.data)}`);
  assert.equal(r.data?.outcome, 'ARRIVED', JSON.stringify(r.data));
  assert.equal(adapter.pos.y, 63.5, JSON.stringify(r.data));
  const offset = (r.data?.interaction as { requestedOffset: { vertical: number } }).requestedOffset;
  assert.equal(offset.vertical, 0.5);
});

test('approach_visible 不会把目标实体换成另一只同名实体', async (t) => {
  const map = flatMap();
  const adapter = new SwapCowWorld();
  adapter.pos = { x: 0.3, y: 64, z: 0.2 };
  adapter.entities.push({ id: 7, name: 'cow', kind: 'passive', pos: { x: 2.5, y: 64, z: 0.5 } } as EntityInfo);
  const ctx = context(adapter, map);
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { entity: { id: 7, name: 'cow' } });
  assert.equal(r.status, 'failed', r.summary);
  assert.equal(r.data?.outcome, 'PARTIAL');
  assert.equal((r.data?.entity as EntityInfo).id, 7);
  assert.equal((r.data?.entity as EntityInfo).pos.x, 8.5);
});

test('approach_visible 不把 heard 实体当成已确认到达', async (t) => {
  const map = flatMap();
  const adapter = new MovingCowWorld();
  adapter.pos = { x: 0.3, y: 64, z: 0.2 };
  adapter.entities.push({ id: 7, name: 'cow', kind: 'passive', pos: { x: 2.5, y: 64, z: 0.5 } } as EntityInfo);
  const ctx = context(adapter, map, {
    perceivedEntities: (radius) => adapter.nearbyEntities(radius)
      .map((entity) => ({ ...entity, perception: entity.id === 7 && adapter.moved ? 'heard' as const : 'seen' as const })),
  });
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { entity: { id: 7 } });
  assert.equal(r.status, 'failed', r.summary);
  assert.equal(r.data?.outcome, 'INVALIDATED');
  assert.equal(r.data?.stop, 'INVALIDATED');
});

test('approach_visible 遵守调用方 maxSteps，截断时返回 PARTIAL/BUDGET_EXCEEDED 并保留原目标', async (t) => {
  const { adapter, ctx } = setup(flatMap());
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { pos: { x: 3.5, y: 64, z: 0.5 } }, { maxSteps: 1 });
  assert.equal(r.status, 'failed', r.summary);
  assert.equal(r.data?.outcome, 'PARTIAL');
  assert.equal(r.data?.stop, 'BUDGET_EXCEEDED');
  assert.equal(r.failureCode, 'EFFECT_NOT_CONFIRMED');
  assert.equal(Math.floor(adapter.pos.x), 1);
  assert.deepEqual(r.data?.originalTarget, { kind: 'position', pos: { x: 3.5, y: 64, z: 0.5 } });
});

test('approach_visible 把 position 的近似 y 解析成同列真实脚高', async (t) => {
  const { adapter, ctx } = setup(flatMap());
  t.after(() => ctx.memory.close());
  // 3,63,0 是草方块格；真正站立的脚高是 64。请求点允许近似，解析结果要如实回报。
  const r = await call(ctx, { pos: { x: 3, y: 63, z: 0 } });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.outcome, 'ARRIVED');
  assert.deepEqual(r.data?.resolvedStance, { x: 3.5, y: 64, z: 0.5 });
  const offset = (r.data?.interaction as { requestedOffset: { vertical: number } }).requestedOffset;
  assert.equal(offset.vertical, 1);
});

test('approach_visible 视觉范围不可用时回退 12 格，而不是默认 32', async (t) => {
  const map = corridorMap(21, 21);
  const { adapter, ctx } = setup(map, { x: 0.5, y: 64, z: 0.5 });
  adapter.blocks.push({ name: 'chest', pos: { x: 20, y: 64, z: 0 } });
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { block: { x: 20, y: 64, z: 0 } });
  assert.equal(r.status, 'failed', r.summary);
  assert.equal(r.data?.outcome, 'UNSUPPORTED');
  assert.deepEqual(r.data?.visualRange, { value: 12, source: 'fallback' });
});

test('approach_visible 拒绝岩浆/传送门站位，返回可区分的拒绝种类', async (t) => {
  const map = flatMap();
  const { adapter, ctx } = setup(map);
  const around: Cell[] = [];
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) around.push({ x: 2 + dx, y: 64, z: dz });
  adapter.blocks.push({ name: 'chest', pos: { x: 2, y: 64, z: 0 } }, ...around.map((pos) => ({ name: 'lava', pos })));
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { block: { x: 2, y: 64, z: 0 } });
  assert.equal(r.status, 'failed', r.summary);
  assert.equal(r.data?.outcome, 'UNSUPPORTED');
  assert.ok((r.data?.rejectedKinds as Record<string, number>).HAZARD >= 8, JSON.stringify(r.data?.rejectedKinds));
});

test('approach_visible 拒绝传送门站位，不进入其他维度', async (t) => {
  const map = flatMap();
  const { adapter, ctx } = setup(map);
  const around: Cell[] = [];
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) around.push({ x: 2 + dx, y: 64, z: dz });
  adapter.blocks.push({ name: 'chest', pos: { x: 2, y: 64, z: 0 } }, ...around.map((pos) => ({ name: 'nether_portal', pos })));
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { block: { x: 2, y: 64, z: 0 } });
  assert.equal(r.status, 'failed', r.summary);
  assert.equal(r.data?.outcome, 'UNSUPPORTED');
  assert.ok((r.data?.rejectedKinds as Record<string, number>).PORTAL >= 8, JSON.stringify(r.data?.rejectedKinds));
});

test('approach_visible 接受 VoxelMap 里已观察、当前不在视野内的目标', async (t) => {
  const map = chestMap(5);
  const { adapter, ctx } = setup(map);
  adapter.blocks.push({ name: 'chest', pos: { x: 2, y: 64, z: 0 } });
  const ctx2 = { ...ctx, senses: { ...ctx.senses, observeBlocks: () => [] } };
  t.after(() => ctx.memory.close());
  const r = await call(ctx2, { block: { x: 2, y: 64, z: 0 } });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.outcome, 'ARRIVED');
  const evidence = r.data?.evidence as { target: { source: string; freshness?: string } };
  assert.equal(evidence.target.source, 'voxel');
  assert.equal(evidence.target.freshness, 'FRESH');
});

test('approach_visible 用历史体素候选路线，但过期当前证据在动作前阻止执行', async (t) => {
  const map = chestMap(5);
  // 自身动作效果未确认的格子是陈旧当前证据；历史体素仍保留原观测内容。
  for (const pos of [...airCells(5, [-2, -1, 0, 1]), ...floorCells(5, [-2, -1, 0, 1])]) map.invalidatePendingEffect(DIM, pos);
  const { adapter, ctx } = setup(map);
  adapter.blocks.push({ name: 'chest', pos: { x: 2, y: 64, z: 0 } });
  const before = { ...adapter.pos };
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { block: { x: 2, y: 64, z: 0 } });
  assert.equal(r.status, 'failed', r.summary);
  assert.equal(r.data?.outcome, 'UNKNOWN');
  assert.equal(r.data?.searchEvidenceMode, 'historical', '候选来源仍是历史体素');
  assert.equal((r.data?.navigation as { evidenceMode: string }).evidenceMode, 'current', '执行器先报告当前位置的过期证据');
  assert.deepEqual(adapter.pos, before, 'STALE 当前证据不启动身体');
  const candidates = (r.data?.candidates ?? []) as {
    mode: string;
    executableSteps?: number;
    verification?: { verdict: string; openPrefix: number; checked: number; total: number; complete: boolean };
  }[];
  const historical = candidates.find((candidate) => candidate.mode === 'historical');
  assert.ok(historical?.verification, '历史候选必须附当前证据复验事实');
  assert.equal(historical.verification.openPrefix, 0, '过期证据下当前 OPEN 前缀为 0');
  assert.equal(historical.verification.checked, historical.verification.total, '小地图复验应完成全部段');
  assert.equal(historical.verification.complete, true);
});

test('approach_visible 在已知 BLOCKED 边界前停下，返回 BLOCKED 而不是 UNKNOWN', async (t) => {
  const wall: Cell[] = [{ x: 1, y: 64, z: 0 }, { x: 1, y: 65, z: 0 }];
  const map = worldMap([
    { name: 'minecraft:air', cells: exceptCells(airCells(4), wall) },
    { name: 'minecraft:grass_block', cells: floorCells(4) },
    { name: 'minecraft:stone', cells: wall },
    { name: 'minecraft:chest', cells: [{ x: 3, y: 64, z: 0 }] },
  ]);
  const { adapter, ctx } = setup(map, { x: 0.5, y: 64, z: 0.5 });
  adapter.blocks.push(...wall.map((pos) => ({ name: 'stone', pos })), { name: 'chest', pos: { x: 3, y: 64, z: 0 } });
  const before = { ...adapter.pos };
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { block: { x: 3, y: 64, z: 0 } });
  assert.equal(r.status, 'failed', r.summary);
  // 停下前会先绕向尚未试过的前沿点再看；不穿过墙，不把绕行说成到达。
  assert.ok(r.data?.outcome === 'BLOCKED' || r.data?.outcome === 'PARTIAL', String(r.data?.outcome));
  assert.ok(Math.floor(adapter.pos.x) <= Math.floor(before.x) + 2, '没有穿过墙');
});

test('approach_visible 不把地图解析出的不同落脚点当成已验证站位', async (t) => {
  const map = worldMap([
    { name: 'minecraft:air', cells: airCells(5) },
    { name: 'minecraft:grass_block', cells: floorCells(5) },
  ]);
  const { adapter, ctx } = setup(map);
  // 现场是半砖（脚高 63.5），地图还记着整块（脚高 64）：路线目标是不同的脚高。
  adapter.blocks.push({ name: 'stone_slab', pos: { x: 1, y: 63, z: 0 } });
  adapter.blockProperties.set('1,63,0', { type: 'bottom' });
  const before = { ...adapter.pos };
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { pos: { x: 1.5, y: 64, z: 0.5 } });
  assert.equal(r.status, 'failed', r.summary);
  assert.equal(r.data?.outcome, 'UNKNOWN');
  assert.ok((r.data?.candidates as { targetMismatch?: boolean }[]).some((candidate) => candidate.targetMismatch === true), JSON.stringify(r.data?.candidates));
  assert.deepEqual(adapter.pos, before);
});

test('approach_visible 证据已新鲜时不做额外局部观察', async (t) => {
  const map = chestMap(5);
  const { adapter, ctx } = setup(map);
  adapter.blocks.push({ name: 'chest', pos: { x: 2, y: 64, z: 0 } });
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { block: { x: 2, y: 64, z: 0 } });
  assert.equal(r.status, 'succeeded', r.summary);
  const local = (r.data?.evidence as { localObservation: { attempted: boolean; requested: number } }).localObservation;
  assert.equal(local.attempted, false);
  assert.ok(local.requested > 0);
});

/** 模拟“现场读不到尚未观察的格”：只有被合法观察过的格才返回 blockstate。 */
class BlindWorld extends Fake {
  revealed = new Set<string>();
  override blockAt(pos: Vec3Like): string {
    // FakeAdapter 的返回类型比 GameAdapter 窄；这里故意模拟“现场读不到未观察格”，
    // 技能按 null → UNKNOWN 处理，不能把未知当空气。
    return this.revealed.has(`${pos.x},${pos.y},${pos.z}`) ? super.blockAt(pos) : (null as unknown as string);
  }
}

function observeIntoMap(adapter: BlindWorld, map: VoxelMap) {
  return (positions: Vec3Like[]) => {
    const seen = positions.map((pos) => {
      adapter.revealed.add(`${pos.x},${pos.y},${pos.z}`);
      const raw = adapter.nameAt(pos.x, pos.y, pos.z);
      const name = raw.includes(':') ? raw : `minecraft:${raw}`;
      const properties = adapter.blockStateAt?.(pos)?.properties ?? {};
      return {
        pos: { ...pos }, name, properties, worldId: WORLD, sessionId: SESSION, dimension: DIM,
        observationId: 1, observedAt: Date.now(), source: 'vision' as const, stateComplete: true,
      };
    });
    for (const block of seen) {
      sequence += 1;
      map.observe({
        worldId: WORLD, dim: DIM, sessionId: SESSION, observedAt: block.observedAt, sequence,
        source: 'vision', evidence: 'seen', stateComplete: true,
        state: { name: block.name, properties: Object.fromEntries(Object.entries(block.properties).map(([key, value]) => [key, String(value)])) },
        pos: block.pos,
      });
    }
    return seen;
  };
}

test('approach_visible 未知候选先补观察，不会在观察前因没有可用站位提前退出', async (t) => {
  const map = worldMap([
    { name: 'minecraft:air', cells: airCells(0) },
    { name: 'minecraft:grass_block', cells: floorCells(0) },
    { name: 'minecraft:chest', cells: [{ x: 2, y: 64, z: 0 }] },
  ]);
  const adapter = new BlindWorld();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.blocks.push({ name: 'chest', pos: { x: 2, y: 64, z: 0 } });
  // 身体只知道脚下和紧邻一圈；目标周边的候选站位要等观察才可读。
  for (let z = -1; z <= 1; z++) for (let y = 63; y <= 66; y++) adapter.revealed.add(`0,${y},${z}`);
  const ctx = context(adapter, map, { observeBlocks: observeIntoMap(adapter, map) });
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { block: { x: 2, y: 64, z: 0 } });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.outcome, 'ARRIVED');
  const stanceObservation = (r.data?.evidence as { stanceObservation: { attempted: boolean; requested: number; acquired: number } }).stanceObservation;
  assert.equal(stanceObservation.attempted, true);
  assert.ok(stanceObservation.requested > 0);
  assert.ok(stanceObservation.acquired > 0);
  assertNoTerrainChange(adapter);
});

test('approach_visible 观察后仍未知的候选返回 UNKNOWN，并如实报告观察次数', async (t) => {
  const map = worldMap([
    { name: 'minecraft:air', cells: airCells(0) },
    { name: 'minecraft:grass_block', cells: floorCells(0) },
    { name: 'minecraft:chest', cells: [{ x: 2, y: 64, z: 0 }] },
  ]);
  const adapter = new BlindWorld();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.blocks.push({ name: 'chest', pos: { x: 2, y: 64, z: 0 } });
  for (let z = -1; z <= 1; z++) for (let y = 63; y <= 66; y++) adapter.revealed.add(`0,${y},${z}`);
  const ctx = context(adapter, map, { observeBlocks: () => [] });
  const before = { ...adapter.pos };
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { block: { x: 2, y: 64, z: 0 } });
  assert.equal(r.status, 'failed', r.summary);
  assert.equal(r.data?.outcome, 'UNKNOWN');
  const stanceObservation = r.data?.stanceObservation as { attempted: boolean; acquired: number };
  assert.equal(stanceObservation.attempted, true);
  assert.equal(stanceObservation.acquired, 0);
  assert.ok((r.data?.rejectedKinds as Record<string, number>).UNKNOWN > 0);
  assert.deepEqual(adapter.pos, before);
});

test('approach_visible 位置请求在格边+半砖时按解析 stance 验收，不因 0.78 格偏移失败', async (t) => {
  const map = worldMap([
    { name: 'minecraft:air', cells: exceptCells(airCells(5), [{ x: 2, y: 64, z: 0 }]) },
    // 实际起点偏心：身体在 (1.3,63.5,0.2) 的 AABB 会压进 z=-1 的相邻列，
    // 因此相邻列必须是同一种底面半砖（顶面 63.5）；整块草方块会在 y=63.5..64 与身体真实相交。
    { name: 'minecraft:grass_block', cells: exceptCells(floorCells(5, [-1, 0]), [{ x: 1, y: 63, z: 0 }, { x: 1, y: 63, z: -1 }]) },
    { name: 'minecraft:stone_slab', properties: { type: 'bottom' }, cells: [{ x: 1, y: 63, z: 0 }, { x: 1, y: 63, z: -1 }] },
    // 地图里的目标箱子与适配器一致，不让搜索把目标格当成空气通道。
    { name: 'minecraft:chest', cells: [{ x: 2, y: 64, z: 0 }] },
  ]);
  const { adapter, ctx } = setup(map);
  adapter.blocks.push({ name: 'stone_slab', pos: { x: 1, y: 63, z: 0 } }, { name: 'stone_slab', pos: { x: 1, y: 63, z: -1 } });
  adapter.blockProperties.set('1,63,0', { type: 'bottom' });
  adapter.blockProperties.set('1,63,-1', { type: 'bottom' });
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { pos: { x: 1.9, y: 64, z: 0.9 } }, { allowed: ['walk', 'step', 'drop'] });
  assert.equal(r.status, 'succeeded', `${r.summary}；data=${JSON.stringify(r.data)}`);
  assert.equal(r.data?.outcome, 'ARRIVED', JSON.stringify(r.data));
  const stance = r.data?.resolvedStance as Vec3Like;
  assert.deepEqual(stance, { x: 1.5, y: 63.5, z: 0.5 }, JSON.stringify(r.data));
  const offset = (r.data?.interaction as { requestedOffset: { horizontal: number; vertical: number } }).requestedOffset;
  assert.ok(offset.horizontal > 0.5, JSON.stringify(offset));
  assert.equal(offset.vertical, 0.5);
});

/** 落在目标格边缘而不是格心的身体（move_step 只按脚格验收，仍应视为到达）。 */
class EdgeLandingWorld extends Fake {
  override async moveTo(target: MoveTarget, opts: MoveOpts) {
    if (target.kind === 'xyz') {
      this.actions.push('moveTo:xyz');
      this.pos = { x: target.x + 0.02, y: target.y, z: target.z + 0.02 };
      return;
    }
    return super.moveTo(target, opts);
  }
}

test('approach_visible 地图证据带 minecraft: 名字时仍能解析站位（只靠 VoxelMap）', async (t) => {
  const map = worldMap([
    { name: 'minecraft:air', cells: airCells(3) },
    { name: 'minecraft:grass_block', cells: exceptCells(floorCells(3), [{ x: 1, y: 63, z: 0 }]) },
    { name: 'minecraft:stone_slab', properties: { type: 'bottom' }, cells: [{ x: 1, y: 63, z: 0 }] },
  ]);
  const adapter = new BlindWorld();
  adapter.pos = { x: 1.5, y: 63.5, z: 0.5 };
  // 不提供 observeBlocks：现场读不到时只能靠 VoxelMap 的 FRESH 证据。
  const ctx = context(adapter, map, { observeBlocks: undefined, effectiveRange: () => 32 });
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { pos: { x: 1.9, y: 64, z: 0.9 } }, { allowed: ['walk', 'step', 'drop'] });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.outcome, 'ARRIVED');
  assert.equal((r.data?.resolvedStance as Vec3Like).y, 63.5);
  assert.equal((r.data?.evidence as { stanceGeometry: string }).stanceGeometry, 'live_adapter_blocks+fresh_voxel_fallback');
});

test('approach_visible 按解析 stance 验收落在格边的到达，不因测量位置远离请求点而失败', async (t) => {
  const map = flatMap();
  const adapter = new EdgeLandingWorld();
  adapter.pos = { x: 0.3, y: 64, z: 0.2 };
  const ctx = context(adapter, map);
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { pos: { x: 1.98, y: 64, z: 0.98 } });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.outcome, 'ARRIVED');
  const offset = (r.data?.interaction as { requestedOffset: { horizontal: number } }).requestedOffset;
  assert.ok(offset.horizontal > 0.75, JSON.stringify(offset));
  assert.deepEqual(r.data?.resolvedStance, { x: 1.5, y: 64, z: 0.5 });
});

/** 只让 x≥5 的远处现场读不到；观察到的走廊仍可读。 */
class PartialWorld extends Fake {
  override blockAt(pos: Vec3Like): string {
    return pos.x >= 5 ? (null as unknown as string) : super.blockAt(pos);
  }
}

test('approach_visible 终点站位未知时先执行可验证前缀并返回 PARTIAL', async (t) => {
  const map = corridorMap(9, 4);
  const adapter = new PartialWorld();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = context(adapter, map, { observeBlocks: undefined, effectiveRange: () => 64 });
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { pos: { x: 8.5, y: 64, z: 0.5 } });
  assert.equal(r.status, 'failed', r.summary);
  assert.equal(r.data?.outcome, 'PARTIAL');
  assert.equal(r.data?.stop, 'UNKNOWN');
  assert.equal(Math.floor(adapter.pos.x), 4);
  assert.deepEqual(r.data?.originalTarget, { kind: 'position', pos: { x: 8.5, y: 64, z: 0.5 } });
  assert.equal(r.data?.stanceValidated, false);
  assert.equal((r.data?.prefix as { endpoint: Vec3Like }).endpoint.x, 4.5);
});

/** 第一步走完后立刻触发父取消，验证前缀回退的取消语义。 */
class AbortInMoveWorld extends PartialWorld {
  controller?: AbortController;
  override async moveTo(target: MoveTarget, opts: MoveOpts) {
    await super.moveTo(target, opts);
    this.controller?.abort();
  }
}

test('approach_visible 前缀导航被取消时保持 cancelled 状态', async (t) => {
  const map = corridorMap(9, 4);
  const adapter = new AbortInMoveWorld();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = context(adapter, map, { observeBlocks: undefined, effectiveRange: () => 64 });
  const controller = new AbortController();
  ctx.signal = controller.signal;
  adapter.controller = controller;
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { pos: { x: 8.5, y: 64, z: 0.5 } });
  assert.equal(r.status, 'cancelled', r.summary);
  assert.equal(r.data?.outcome, 'CANCELLED');
});

test('approach_visible 目标脚下是岩浆时拒绝，不向前缀移动', async (t) => {
  const { adapter, ctx } = setup(flatMap());
  adapter.blocks.push({ name: 'lava', pos: { x: 3, y: 63, z: 0 } });
  const before = { ...adapter.pos };
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { pos: { x: 3.5, y: 64, z: 0.5 } });
  assert.equal(r.status, 'failed', r.summary);
  assert.equal(r.data?.outcome, 'UNSUPPORTED');
  assert.deepEqual(adapter.pos, before);
});

test('approach_visible 只接受扫描窗口内的近似脚高', async (t) => {
  const { adapter, ctx } = setup(flatMap());
  t.after(() => ctx.memory.close());
  // 真实脚高 64，请求 60 相差 4，超出 ±3 窗口；不能报到达，原目标保留。
  const r = await call(ctx, { pos: { x: 3, y: 60, z: 0 } });
  assert.notEqual(r.data?.outcome, 'ARRIVED');
  assert.deepEqual(r.data?.originalTarget, { kind: 'position', pos: { x: 3, y: 60, z: 0 } });
});

test('approach_visible 目标格被方块占据时不走前缀回退', async (t) => {
  const { adapter, ctx } = setup(flatMap());
  // 2 格高的柱子顶部仍在 ±3 窗口内，会解析成柱顶；用超过窗口的高墙验证基底阻挡。
  adapter.blocks.push(...[64, 65, 66, 67].map((y) => ({ name: 'stone', pos: { x: 3, y, z: 0 } })));
  const before = { ...adapter.pos };
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { pos: { x: 3.5, y: 64, z: 0.5 } });
  assert.equal(r.status, 'failed', r.summary);
  assert.equal(r.data?.outcome, 'UNSUPPORTED');
  assert.deepEqual(adapter.pos, before);
});

test('approach_visible 位置目标先观察未知列，再解析可站立面', async (t) => {
  const map = worldMap([
    { name: 'minecraft:air', cells: airCells(0) },
    { name: 'minecraft:grass_block', cells: floorCells(0) },
  ]);
  const adapter = new BlindWorld();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.blocks.push({ name: 'stone_slab', pos: { x: 1, y: 63, z: 0 } });
  adapter.blockProperties.set('1,63,0', { type: 'bottom' });
  for (let z = -1; z <= 1; z++) for (let y = 63; y <= 66; y++) adapter.revealed.add(`0,${y},${z}`);
  const ctx = context(adapter, map, { observeBlocks: observeIntoMap(adapter, map), effectiveRange: () => 32 });
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { pos: { x: 1.9, y: 64, z: 0.9 } }, { allowed: ['walk', 'step', 'drop'] });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.outcome, 'ARRIVED');
  assert.equal((r.data?.resolvedStance as Vec3Like).y, 63.5);
  const stanceObservation = (r.data?.evidence as { stanceObservation: { attempted: boolean; acquired: number } }).stanceObservation;
  assert.equal(stanceObservation.attempted, true);
  assert.ok(stanceObservation.acquired > 0);
});

test('approach_visible 拒绝超过累计位移预算的绕行路线', async (t) => {
  // 起点与目标直线距离 4 格，但只有一条 32 段的蛇形已观察通道；超出局部接近的位移预算。
  const floor: Cell[] = [];
  const air: Cell[] = [];
  const add = (x: number, z: number) => {
    floor.push({ x, y: 63, z });
    for (let y = 64; y <= 66; y++) air.push({ x, y, z });
  };
  for (let x = 0; x >= -6; x--) add(x, 0);
  for (let z = 1; z <= 6; z++) add(-6, z);
  for (let x = -5; x <= 6; x++) add(x, 6);
  for (let z = 5; z >= 0; z--) add(6, z);
  add(5, 0);
  add(4, 0);
  const map = worldMap([
    { name: 'minecraft:air', cells: exceptCells(air, [{ x: 3, y: 64, z: 0 }]) },
    { name: 'minecraft:grass_block', cells: floor },
    { name: 'minecraft:chest', cells: [{ x: 3, y: 64, z: 0 }] },
  ]);
  // 这条通道只以 VoxelMap 里的记录为证据；BlindWorld 的现场读数全部未知，
  // 不让 FakeAdapter 的通用草地凭空造出七个无关候选站位。
  const adapter = new BlindWorld();
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  adapter.blocks.push({ name: 'chest', pos: { x: 3, y: 64, z: 0 } });
  const ctx = context(adapter, map, { observeBlocks: undefined, effectiveRange: () => 32 });
  const before = { ...adapter.pos };
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { block: { x: 3, y: 64, z: 0 } });
  assert.equal(r.status, 'failed', `${r.summary}；data=${JSON.stringify(r.data)}`);
  assert.equal(r.data?.outcome, 'BUDGET_EXCEEDED', JSON.stringify(r.data));
  assert.equal(r.data?.stop, 'BUDGET_EXCEEDED', JSON.stringify(r.data));
  const budget = r.data?.budget as {
    plannedDistance: number; distanceLimit: number;
    executableTransitions: number; travelLimit: number; plannedTransitions: number;
  };
  // 必须是因为真实已找到的 32 段路线超出累计位移预算，而不是所有候选都耗尽搜索时间。
  assert.equal(r.data?.routeMode, 'current', JSON.stringify(r.data));
  assert.deepEqual(r.data?.resolvedStance, { x: 4.5, y: 64, z: 0.5 }, JSON.stringify(r.data));
  assert.equal(budget.plannedTransitions, 32, JSON.stringify(budget));
  assert.ok(budget.plannedDistance > budget.distanceLimit, JSON.stringify(budget));
  assert.ok(budget.executableTransitions > budget.travelLimit, JSON.stringify(budget));
  assert.deepEqual(adapter.pos, before);
});

test('approach_visible 半径外目标返回 UNSUPPORTED，且不移动', async (t) => {
  const map = flatMap();
  const { adapter, ctx } = setup(map);
  adapter.blocks.push({ name: 'chest', pos: { x: 40, y: 64, z: 0 } });
  const before = { ...adapter.pos };
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { block: { x: 40, y: 64, z: 0 } }, { allowed: ['walk'] });
  assert.equal(r.status, 'failed');
  assert.equal(r.data?.outcome, 'UNSUPPORTED');
  assert.deepEqual(adapter.pos, before);
});

test('approach_visible 空气方块目标按能力缺口拒绝', async (t) => {
  const map = flatMap();
  const { ctx } = setup(map);
  t.after(() => ctx.memory.close());
  const r = await call(ctx, { block: { x: 2, y: 64, z: 0 } }, { allowed: ['walk'] });
  assert.equal(r.status, 'failed');
  assert.equal(r.data?.outcome, 'UNSUPPORTED');
});

const causeOf = (
  data: Record<string, unknown>, searchStatus: LandSearchResult['status'] = 'FOUND', failureCode?: FailureCode,
) => navigationOutcome({
  status: 'failed', summary: 'cause test', data,
  ...(failureCode === undefined ? {} : { failureCode }),
}, searchStatus).cause;

test('navigationOutcome 以最终 stop.reason 优先，较早的搜索终态不覆盖真实阻挡', () => {
  // 严格搜索 INSUFFICIENT_EVIDENCE 后，历史/实际执行发现 BLOCKED：最终原因必须保留 BLOCKED。
  assert.equal(causeOf({
    stop: { reason: 'BLOCKED' }, searchStatus: 'INSUFFICIENT_EVIDENCE', blockerAhead: { status: 'BLOCKED' },
  }), 'BLOCKED');
  assert.equal(causeOf({
    stop: { reason: 'BLOCKED' }, searchStatus: 'INSUFFICIENT_EVIDENCE', blockerAhead: { status: 'UNSUPPORTED' },
  }), 'UNSUPPORTED');
  assert.equal(causeOf({ stop: { reason: 'PHYSICAL_FAILURE' }, searchStatus: 'FOUND' }), 'NOT_CONFIRMED');
});

test('navigationOutcome 的精确失效/不支持/证据不足不被通用 no_route 覆盖', () => {
  const segment = { invalidation: 'no_route' };
  assert.equal(causeOf({ stop: { reason: 'ROUTE_INVALIDATED' }, searchStatus: 'INVALIDATED', segment }), 'INVALIDATED');
  assert.equal(causeOf({ stop: { reason: 'TARGET_UNRESOLVED' }, searchStatus: 'UNSUPPORTED', segment }), 'UNSUPPORTED');
  assert.equal(causeOf({ stop: { reason: 'UNKNOWN_BOUNDARY' }, searchStatus: 'INSUFFICIENT_EVIDENCE', segment }), 'UNKNOWN');
  assert.equal(causeOf({ stop: { reason: 'BUDGET_EXHAUSTED' }, searchStatus: 'BUDGET_EXHAUSTED', segment }), 'BUDGET_EXCEEDED');
  // 没有最终 stop.reason 时，仍按精确 searchStatus 区分，最后才用兼容 stopCode。
  assert.equal(causeOf({ searchStatus: 'INVALIDATED', segment }), 'INVALIDATED');
  assert.equal(causeOf({ searchStatus: 'INSUFFICIENT_EVIDENCE', segment }), 'UNKNOWN');
  assert.equal(causeOf({ searchStatus: 'NO_PATH_IN_MEMORY', segment }), 'NO_PATH');
});

test('navigationOutcome 把 max_steps 预算报为 BUDGET_EXCEEDED，不因先前搜索 FOUND 误报 TIMEOUT', () => {
  assert.equal(causeOf({ stop: { reason: 'BUDGET_EXHAUSTED' }, searchStatus: 'FOUND', executed: 2 }, 'FOUND'), 'BUDGET_EXCEEDED');
  assert.equal(causeOf({ stop: { reason: 'TIMEOUT' }, searchStatus: 'FOUND' }, 'FOUND'), 'TIMEOUT');
  assert.equal(causeOf({ stop: { reason: 'CANCELLED' }, searchStatus: 'FOUND' }), 'CANCELLED');
});

test('navigationOutcome 不为裸 no_route/FOUND 制造 NO_PATH 或 BLOCKED', () => {
  // 没有精确最终 stop.reason、搜索仍为 FOUND、也没有已观测 blocker 时，通用兼容字段不证明无路。
  assert.equal(causeOf({ searchStatus: 'FOUND', segment: { invalidation: 'no_route' } }, 'FOUND'), 'UNKNOWN');
  assert.equal(causeOf({ segment: { invalidation: 'no_route' } }, 'FOUND'), 'UNKNOWN');
  assert.equal(causeOf({ searchStatus: 'FOUND' }, 'FOUND', 'PATH_NOT_FOUND'), 'UNKNOWN');
  // 真实已知边界仍然可以报 BLOCKED。
  assert.equal(causeOf({ blockerAhead: { status: 'BLOCKED' }, segment: { invalidation: 'no_route' } }, 'FOUND'), 'BLOCKED');
});
