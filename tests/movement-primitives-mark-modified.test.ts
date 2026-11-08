/**
 * C-CLEAN-01d（D-070 B3）：`mine_cell`/`place_cell`/`place_support`/`pillar_one`/`excavate_run`
 * 只在确认效果后才经共享会话 `markModified(dim, pos, actionId)` 记自身动作修改。
 *
 * - 正例只标记真实变化的那一格（挖空/放下/形成支撑/垫脚块所在格/开挖复核为空气的格）；
 * - 未执行、失败、未确认的动作 0 次写入；
 * - 能力 `markModified=false` 时不调用库、不回退，动作本身仍按实测结果成功；
 * - 写入是 `modified`，不是 `traversed`。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { BlockObservation, Vec3Like } from '../src/adapter/types.ts';
import { excavateRun, mineCell, pillarOne, placeCell, placeSupport } from '../src/skills/movement/index.ts';
import type { HostCapabilityReport } from '../src/spatial/capabilities.ts';
import { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx, observeAllBlocks } from './survival-helpers.ts';

const WORLD = 'mark-modified-world', DIM = 'overworld', SESSION = 'mark-modified-session';
const ACTION = 'mark-modified-task';

/** 真实共享会话：观测一层平坦地表（支撑 y=63，脚位 y=64），与 FakeAdapter 的默认地面一致。 */
async function openSession() {
  const dir = mkdtempSync(join(tmpdir(), 'mark-modified-'));
  const spatial = await SharedSpatialSession.open({ worldId: WORLD, databasePath: join(dir, 'memory.db') });
  spatial.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });
  const observedAt = Date.now();
  let sequence = 0;
  const cells: BlockObservation[] = [];
  for (let x = -1; x <= 4; x++) for (let z = -2; z <= 2; z++) for (let y = 59; y <= 65; y++) {
    cells.push({
      name: y <= 63 ? 'minecraft:stone' : 'minecraft:air',
      properties: {}, worldId: WORLD, sessionId: SESSION, dimension: DIM,
      source: 'vision', stateComplete: true, observedAt, observationId: ++sequence,
      pos: { x, y, z },
    });
  }
  spatial.observe(cells);
  return { spatial, dir };
}

async function closeSession(spatial: SharedSpatialSession, dir: string) {
  const shutdown = await spatial.shutdown();
  assert.equal(shutdown.close?.completed, true);
  rmSync(dir, { recursive: true, force: true });
}

const history = (spatial: SharedSpatialSession, pos: Vec3Like) => spatial.session.voxel.historyAt(DIM, pos.x, pos.y, pos.z);

/** 只统计非默认的历史位：正例应恰好命中被改的那一格。 */
function changedCells(spatial: SharedSpatialSession) {
  const out: string[] = [];
  for (let x = -1; x <= 4; x++) for (let z = -2; z <= 2; z++) for (let y = 59; y <= 65; y++) {
    const h = history(spatial, { x, y, z });
    if (h.modified || h.traversed) out.push(`${x},${y},${z}:${h.modified ? 'm' : ''}${h.traversed ? 't' : ''}`);
  }
  return out;
}

function flatWorld() {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.worldId = WORLD;
  w.sessionId = SESSION;
  w.dim = DIM;
  return w;
}

test('mine_cell 确认挖空后只把目标格记成自身修改，不是站位', async () => {
  const { spatial, dir } = await openSession();
  try {
    const w = flatWorld();
    w.blocks.push({ name: 'stone', pos: { x: 1, y: 64, z: 0 } });
    const ctx = { ...makeCtx(w, { senses: { observeBlocks: observeAllBlocks(w) } }), spatial, taskId: ACTION };
    const r = await mineCell.run(ctx, { at: [1, 0, 0], facing: 'E' });
    assert.equal(r.status, 'succeeded', r.summary);
    assert.deepEqual(changedCells(spatial), ['1,64,0:m'], '只标记被挖空的那一格，且是 modified 而非 traversed');
  } finally {
    await closeSession(spatial, dir);
  }
});

test('mine_cell 失败或未执行时 0 次写入', async () => {
  const { spatial, dir } = await openSession();
  try {
    const w = flatWorld();
    w.blocks.push({ name: 'stone', pos: { x: 1, y: 64, z: 0 } });
    // 目标看不见：未执行挖掘。
    const blind = { ...makeCtx(w, { senses: { observeBlocks: () => [] } }), spatial, taskId: ACTION };
    assert.equal((await mineCell.run(blind, { at: [1, 0, 0], facing: 'E' })).status, 'failed');
    // 挖后复核不是空气：EFFECT_NOT_CONFIRMED。
    w.blocks = w.blocks.filter((b) => b.pos.x !== 1 || b.pos.y !== 64);
    w.removed.add('1,64,0');
    const backfill = new (class extends FakeAdapter {
      override async dig(pos: Vec3Like, signal: AbortSignal) {
        const r = await super.dig(pos, signal);
        this.blocks.push({ name: 'sand', pos: { ...pos } });
        this.removed.delete('1,64,0');
        return r;
      }
    })();
    Object.assign(backfill, { pos: { x: 0.5, y: 64, z: 0.5 }, worldId: WORLD, sessionId: SESSION, dim: DIM });
    backfill.blocks.push({ name: 'stone', pos: { x: 1, y: 64, z: 0 } });
    const filled = { ...makeCtx(backfill, { senses: { observeBlocks: observeAllBlocks(backfill) } }), spatial, taskId: ACTION };
    const r = await mineCell.run(filled, { at: [1, 0, 0], facing: 'E' });
    assert.equal(r.status, 'failed');
    assert.equal(r.failureCode, 'EFFECT_NOT_CONFIRMED');
    assert.deepEqual(changedCells(spatial), [], '未执行与未确认的动作都不得写 markModified');
  } finally {
    await closeSession(spatial, dir);
  }
});

test('place_cell 确认放下后标记目标格', async () => {
  const { spatial, dir } = await openSession();
  try {
    const w = flatWorld();
    w.inv.set('cobblestone', 2);
    const ctx = { ...makeCtx(w), spatial, taskId: ACTION };
    const r = await placeCell.run(ctx, { at: [1, 0, 0], facing: 'E', item: 'cobblestone' });
    assert.equal(r.status, 'succeeded', r.summary);
    assert.deepEqual(changedCells(spatial), ['1,64,0:m']);
  } finally {
    await closeSession(spatial, dir);
  }
});

test('place_cell 已有同名方块的空操作不写', async () => {
  const { spatial, dir } = await openSession();
  try {
    const w = flatWorld();
    w.blocks.push({ name: 'cobblestone', pos: { x: 1, y: 64, z: 0 } });
    const ctx = { ...makeCtx(w), spatial, taskId: ACTION };
    const r = await placeCell.run(ctx, { at: [1, 0, 0], facing: 'E', item: 'cobblestone' });
    assert.equal(r.status, 'succeeded', r.summary);
    assert.equal((r.data as { noop?: boolean } | undefined)?.noop, true);
    assert.deepEqual(changedCells(spatial), []);
  } finally {
    await closeSession(spatial, dir);
  }
});

test('place_cell 实际出现的材料与请求不符时 0 次写入', async () => {
  const { spatial, dir } = await openSession();
  try {
    // 适配器回执成功，但目标格实际出现的是别的方块：EFFECT_NOT_CONFIRMED 之前不得记修改。
    const w = new (class extends FakeAdapter {
      override async placeBlockAt(pos: Vec3Like, itemNames: string[], signal: AbortSignal) {
        const r = await super.placeBlockAt(pos, itemNames, signal);
        if (!r.ok) return r;
        this.blocks = this.blocks.filter((b) => !(b.pos.x === pos.x && b.pos.y === pos.y && b.pos.z === pos.z));
        this.blocks.push({ name: 'dirt', pos: { ...pos } });
        return r;
      }
    })();
    Object.assign(w, { pos: { x: 0.5, y: 64, z: 0.5 }, worldId: WORLD, sessionId: SESSION, dim: DIM });
    w.inv.set('cobblestone', 1);
    const ctx = { ...makeCtx(w), spatial, taskId: ACTION };
    const r = await placeCell.run(ctx, { at: [1, 0, 0], facing: 'E', item: 'cobblestone' });
    assert.equal(r.status, 'failed');
    assert.equal(r.failureCode, 'EFFECT_NOT_CONFIRMED');
    assert.deepEqual(changedCells(spatial), []);
  } finally {
    await closeSession(spatial, dir);
  }
});

test('place_support 形成可站立支撑后标记支撑格', async () => {
  const { spatial, dir } = await openSession();
  try {
    const w = flatWorld();
    w.removed.add('1,63,0');
    w.inv.set('cobblestone', 1);
    const ctx = { ...makeCtx(w), spatial, taskId: ACTION };
    const r = await placeSupport.run(ctx, { at: [1, -1, 0], facing: 'E', item: 'cobblestone' });
    assert.equal(r.status, 'succeeded', r.summary);
    assert.deepEqual(changedCells(spatial), ['1,63,0:m']);
  } finally {
    await closeSession(spatial, dir);
  }
});

test('place_support 没有材料时不放置、0 次写入', async () => {
  const { spatial, dir } = await openSession();
  try {
    const w = flatWorld();
    w.removed.add('1,63,0');
    // 没有材料：MISSING_MATERIALS，未放置。
    const ctx = { ...makeCtx(w), spatial, taskId: ACTION };
    const r = await placeSupport.run(ctx, { at: [1, -1, 0], facing: 'E', item: 'cobblestone' });
    assert.equal(r.status, 'failed');
    assert.deepEqual(changedCells(spatial), []);
  } finally {
    await closeSession(spatial, dir);
  }
});

test('place_support 放置回执成功但目标格仍不可站时 0 次写入', async () => {
  const { spatial, dir } = await openSession();
  try {
    // 回执 ok 但目标格始终是空气：verify() 不成立，不能把回执当效果确认。
    const w = new (class extends FakeAdapter {
      override async placeBlockAt(_pos: Vec3Like, _itemNames: string[], _signal: AbortSignal) {
        return { ok: true };
      }
    })();
    Object.assign(w, { pos: { x: 0.5, y: 64, z: 0.5 }, worldId: WORLD, sessionId: SESSION, dim: DIM });
    w.removed.add('1,63,0');
    w.inv.set('cobblestone', 1);
    const ctx = { ...makeCtx(w), spatial, taskId: ACTION };
    const r = await placeSupport.run(ctx, { at: [1, -1, 0], facing: 'E', item: 'cobblestone' });
    assert.equal(r.status, 'failed');
    assert.deepEqual(changedCells(spatial), []);
  } finally {
    await closeSession(spatial, dir);
  }
});

test('pillar_one 确认垫高后标记原脚所在的垫脚块', async () => {
  const { spatial, dir } = await openSession();
  try {
    const w = flatWorld();
    w.pos = { x: 0.5, y: 60, z: 0.5 };
    w.removed.add('0,60,0');
    w.removed.add('0,61,0');
    w.removed.add('0,62,0');
    w.inv.set('cobblestone', 2);
    const ctx = { ...makeCtx(w), spatial, taskId: ACTION };
    const r = await pillarOne.run(ctx, {});
    assert.equal(r.status, 'succeeded', r.summary);
    assert.deepEqual(changedCells(spatial), ['0,60,0:m'], '垫脚块在原脚的格子；站位提升不写成 modified');
  } finally {
    await closeSession(spatial, dir);
  }
});

test('pillar_one 站高但脚下没有可站立支撑时 0 次写入', async () => {
  const { spatial, dir } = await openSession();
  try {
    // 回执 ok 且人升了一格，但垫脚块实际不存在：没有实测支撑，EFFECT_NOT_CONFIRMED。
    const w = new (class extends FakeAdapter {
      override async pillarUp(itemNames: string[], _signal: AbortSignal) {
        const f = { x: Math.floor(this.pos.x), y: Math.floor(this.pos.y), z: Math.floor(this.pos.z) };
        const item = itemNames.find((n) => (this.inv.get(n) ?? 0) > 0);
        if (!item) return { ok: false, reason: 'NO_ITEM' };
        this.pos = { ...this.pos, y: f.y + 1 };
        return { ok: true, y: f.y + 1 };
      }
    })();
    Object.assign(w, { pos: { x: 0.5, y: 60, z: 0.5 }, worldId: WORLD, sessionId: SESSION, dim: DIM });
    w.removed.add('0,60,0');
    w.removed.add('0,61,0');
    w.removed.add('0,62,0');
    w.inv.set('cobblestone', 1);
    const ctx = { ...makeCtx(w), spatial, taskId: ACTION };
    const r = await pillarOne.run(ctx, {});
    assert.equal(r.status, 'failed');
    assert.equal(r.failureCode, 'EFFECT_NOT_CONFIRMED');
    assert.deepEqual(changedCells(spatial), []);
  } finally {
    await closeSession(spatial, dir);
  }
});

test('excavate_run 每个复核为空气的格都标记', async () => {
  const { spatial, dir } = await openSession();
  try {
    const w = new (class extends FakeAdapter {
      digs: Vec3Like[] = [];
      override async dig(pos: Vec3Like, signal: AbortSignal) {
        this.digs.push({ ...pos });
        return super.dig(pos, signal);
      }
    })();
    Object.assign(w, { pos: { x: 0.5, y: 64, z: 0.5 }, worldId: WORLD, sessionId: SESSION, dim: DIM });
    w.inv.set('iron_pickaxe', 1);
    const ctx = { ...makeCtx(w, { deadlineMs: 30000 }), spatial, taskId: ACTION };
    const result = await excavateRun.run(ctx, { mode: 'stairs', direction: 'east', steps: 1 });
    assert.equal(result.status, 'succeeded', result.summary);
    assert.ok(w.digs.length > 0, 'stairs 应至少挖空一格');
    // 标记集合必须正好是每次 dig 后复核为空气的格，不含站位或相邻格。
    assert.deepEqual(
      changedCells(spatial).sort(),
      w.digs.map((p) => `${p.x},${p.y},${p.z}:m`).sort(),
      '标记的格必须正是实际挖空并复核为空气的格',
    );
  } finally {
    await closeSession(spatial, dir);
  }
});

test('excavate_run 挖后复核不是空气（被回填）时 0 次写入', async () => {
  const { spatial, dir } = await openSession();
  try {
    let digs = 0;
    // 第一次挖掘后被落下的方块回填：目标格不是空气，只能停下，不能记成已确认修改。
    const w = new (class extends FakeAdapter {
      override async dig(pos: Vec3Like, signal: AbortSignal) {
        const r = await super.dig(pos, signal);
        if (++digs === 1) {
          this.blocks.push({ name: 'sand', pos: { ...pos } });
          this.removed.delete(`${pos.x},${pos.y},${pos.z}`);
        }
        return r;
      }
    })();
    Object.assign(w, { pos: { x: 0.5, y: 64, z: 0.5 }, worldId: WORLD, sessionId: SESSION, dim: DIM });
    w.inv.set('iron_pickaxe', 1);
    const ctx = { ...makeCtx(w, { deadlineMs: 30000 }), spatial, taskId: ACTION };
    const result = await excavateRun.run(ctx, { mode: 'stairs', direction: 'east', steps: 1 });
    assert.equal(result.status, 'failed', result.summary);
    assert.equal(result.failureCode, 'EFFECT_NOT_CONFIRMED');
    assert.deepEqual(changedCells(spatial), [], '未确认的挖掘不得写入 markModified');
  } finally {
    await closeSession(spatial, dir);
  }
});

test('能力 markModified=false：不调用库、不回退，动作本身仍按实测成功', async () => {
  const { spatial, dir } = await openSession();
  try {
    const real = spatial.session.voxel.markModified.bind(spatial.session.voxel);
    let calls = 0;
    spatial.session.voxel.markModified = (...args: Parameters<typeof real>) => { calls += 1; return real(...args); };
    const recorded = spatial.capabilities();
    (spatial as unknown as { capabilityReport: HostCapabilityReport }).capabilityReport = {
      ...recorded, library: { ...recorded.library, memory: { ...recorded.library.memory, markModified: false } },
    };

    const w = flatWorld();
    w.blocks.push({ name: 'stone', pos: { x: 1, y: 64, z: 0 } });
    const ctx = { ...makeCtx(w, { senses: { observeBlocks: observeAllBlocks(w) } }), spatial, taskId: ACTION };
    const r = await mineCell.run(ctx, { at: [1, 0, 0], facing: 'E' });
    assert.equal(r.status, 'succeeded', '记忆写入门禁失败不得把真实动作报成失败');
    assert.equal(calls, 0, '能力 false 时不得触达库写入');
    assert.equal(spatial.lastCapabilityRejection()?.kind, 'capability_unavailable', '拒绝可见，但由调用方决定是否关心');
    assert.deepEqual(changedCells(spatial), []);

    (spatial as unknown as { capabilityReport: HostCapabilityReport }).capabilityReport = recorded;
  } finally {
    await closeSession(spatial, dir);
  }
});
