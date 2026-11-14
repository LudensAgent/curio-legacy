import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { VoxelDirectoryEntry } from 'curio-minecraft-3d-memory';
import { planRetention, type RetentionPlanInput } from '../src/spatial/retention.ts';

const WORLD = 'w';
const DIM = 'overworld';

const entry = (
  cx: number,
  sy: number,
  overrides: Partial<Omit<VoxelDirectoryEntry, 'key'>> = {},
  dim = DIM,
): VoxelDirectoryEntry => {
  const seq = overrides.seq ?? cx * 10 + sy;
  return {
    key: { worldId: WORLD, dim, cx, cz: 0, sy },
    seq,
    bytes: overrides.bytes ?? 100,
    observedCells: overrides.observedCells ?? 100,
    paletteEntries: overrides.paletteEntries ?? 5,
    revision: overrides.revision ?? seq,
  };
};

const input = (entries: readonly VoxelDirectoryEntry[], overrides: Partial<RetentionPlanInput> = {}): RetentionPlanInput => ({
  worldId: WORLD,
  entries,
  totals: {
    sections: entries.length,
    observedCells: entries.reduce((sum, e) => sum + e.observedCells, 0),
    paletteEntries: entries.reduce((sum, e) => sum + e.paletteEntries, 0),
    bytes: entries.reduce((sum, e) => sum + e.bytes, 0),
    maxSeq: Math.max(-1, ...entries.map((e) => e.seq)),
  },
  limits: { maxVoxelSections: 10, maxObservedCells: 1000, maxPaletteEntries: 100, maxBytes: 10_000 },
  anchors: [],
  trigger: 0.8,
  target: 0.5,
  maxSectionsPerPass: 8,
  maxObservedCellsPerPass: 200_000,
  keepHalo: 1,
  ...overrides,
});

test('水位以下不裁剪', () => {
  const plan = planRetention(input([entry(0, 0, { observedCells: 100 })]));
  assert.deepEqual(plan.keys, []);
  assert.equal(plan.reason, 'below_trigger');
});

test('按列选择：最老的列先忘，同龄时先忘观测格多的列', () => {
  const plan = planRetention(input([
    entry(0, 0, { seq: 1, observedCells: 100 }),
    entry(1, 0, { seq: 2, observedCells: 900 }),
    entry(2, 0, { seq: 3, observedCells: 100 }),
  ]));
  assert.equal(plan.reason, 'planned');
  assert.deepEqual(plan.columns.map((c) => c.cx), [0, 1], '先老列 0，再释放量大的列 1');
  assert.equal(plan.keys.length, 2);
  assert.equal(plan.projected.observedCells, 100, '压到目标以内即停');

  const tied = planRetention(input([
    entry(0, 0, { seq: 1, observedCells: 100 }),
    entry(1, 0, { seq: 1, observedCells: 900 }),
  ]));
  assert.deepEqual(tied.columns.map((c) => c.cx), [1], '同龄先删观测格多的列');
});

test('chunk 列整列删除：列内只要有一个保留 Section 就整列不动', () => {
  const plan = planRetention(input(
    [entry(0, 0, { observedCells: 900 }), entry(0, 1, { observedCells: 100 }), entry(2, 0, { observedCells: 900 })],
    { anchors: [{ dim: DIM, pos: { x: 1, y: 20, z: 1 } }] },
  ));
  assert.deepEqual(plan.columns.map((c) => c.cx), [2], '列 0 含锚点 Section，整列排除');
  assert.deepEqual(plan.keys.map((k) => k.cx), [2]);
});

test('hard 锚点保留 halo；精确锚点只保留所在 Section', () => {
  const withHalo = planRetention(input([entry(1, 0, { observedCells: 900 })], {
    anchors: [{ dim: DIM, pos: { x: 0, y: 0, z: 0 }, halo: true }],
    keepHalo: 1,
  }));
  assert.equal(withHalo.keepSections, 1, 'halo 覆盖相邻列');
  assert.deepEqual(withHalo.keys, []);

  const precise = planRetention(input([entry(1, 0, { observedCells: 900 })], {
    anchors: [{ dim: DIM, pos: { x: 0, y: 0, z: 0 } }],
  }));
  assert.equal(precise.keepSections, 0);
  assert.deepEqual(precise.keys.map((k) => k.cx), [1]);
});

test('热点 chunk 与运行时保护 key 都不删', () => {
  const hot = planRetention(input([entry(1, 0, { observedCells: 900 })], {
    hotChunks: [{ dim: DIM, cx: 1, cz: 0 }],
  }));
  assert.deepEqual(hot.keys, []);
  assert.equal(hot.reason, 'keep_exceeds_target', '保留的热点本身已超过目标，如实报告');

  const protectedKey = planRetention(input([entry(1, 0, { observedCells: 900 })], {
    protectedKeys: [{ worldId: WORLD, dim: DIM, cx: 1, cz: 0, sy: 0 }],
  }));
  assert.deepEqual(protectedKey.keys, []);
});

test('单轮预算：列放不进预算时停下并报告剩余水位', () => {
  const plan = planRetention(input(
    [entry(0, 0, { observedCells: 500 }), entry(0, 1, { observedCells: 500 }), entry(1, 0, { observedCells: 500 })],
    { maxSectionsPerPass: 2, target: 0.2 },
  ));
  assert.equal(plan.reason, 'max_sections_per_pass');
  assert.equal(plan.keys.length, 2, '只放得下一列');
  assert.ok(plan.projected.observedCells > 200, '仍未回到目标，下一次 checkpoint 后再删');
});

test('保留集本身占满目标时如实报告，不删事实/基地所在列', () => {
  const plan = planRetention(input(
    [entry(0, 0, { observedCells: 400 }), entry(1, 0, { observedCells: 400 }), entry(2, 0, { observedCells: 400 })],
    { anchors: [
      { dim: DIM, pos: { x: 0, y: 0, z: 0 } },
      { dim: DIM, pos: { x: 16, y: 0, z: 0 } },
    ], maxSectionsPerPass: 8 },
  ));
  assert.equal(plan.reason, 'keep_exceeds_target');
  assert.deepEqual(plan.keys.map((k) => k.cx), [2], '只删不在保留集里的列');
  assert.equal(plan.keepSections, 2);
});

test('palette 或 bytes 单独超过水位也会触发裁剪', () => {
  const palette = planRetention(input([
    entry(0, 0, { observedCells: 10, paletteEntries: 60, bytes: 10 }),
    entry(1, 0, { observedCells: 10, paletteEntries: 30, bytes: 10 }),
  ], { limits: { maxVoxelSections: 10, maxObservedCells: 1000, maxPaletteEntries: 100, maxBytes: 10_000 } }));
  assert.equal(palette.reason, 'planned');
  assert.deepEqual(palette.columns.map((c) => c.cx), [0]);
  assert.ok(palette.projected.paletteEntries <= 50);

  const bytes = planRetention(input([
    entry(0, 0, { observedCells: 10, bytes: 600 }),
    entry(1, 0, { observedCells: 10, bytes: 300 }),
  ], { limits: { maxVoxelSections: 10, maxObservedCells: 1000, maxPaletteEntries: 100, maxBytes: 1000 } }));
  assert.equal(bytes.reason, 'planned');
  assert.deepEqual(bytes.columns.map((c) => c.cx), [0]);
  assert.ok(bytes.projected.bytes <= 500);
});

test('目录条目缺页导致没有可删列时如实报告 no_eligible_columns', () => {
  const plan = planRetention(input([], {
    totals: { sections: 9, observedCells: 900, paletteEntries: 50, bytes: 9000, maxSeq: 20 },
  }));
  assert.deepEqual(plan.keys, []);
  assert.equal(plan.reason, 'no_eligible_columns');
});

test('单轮预算只够列的一部分时按 seq 从老到新截断到 Section 粒度', () => {
  const plan = planRetention(input(
    [entry(0, 0, { seq: 2, observedCells: 400 }), entry(0, 1, { seq: 1, observedCells: 400 }), entry(1, 0, { seq: 3, observedCells: 400 })],
    { maxSectionsPerPass: 1 },
  ));
  assert.equal(plan.reason, 'max_sections_per_pass');
  assert.equal(plan.keys.length, 1);
  assert.deepEqual(plan.keys[0], { worldId: WORLD, dim: DIM, cx: 0, cz: 0, sy: 1 }, '同列按 seq 老的先删');
});

test('单轮观测格预算也会限制一次裁剪', () => {
  const plan = planRetention(input(
    [entry(0, 0, { observedCells: 400 }), entry(1, 0, { observedCells: 400 }), entry(2, 0, { observedCells: 400 })],
    { maxObservedCellsPerPass: 500 },
  ));
  assert.equal(plan.reason, 'max_sections_per_pass');
  assert.equal(plan.keys.length, 1, '只够一个 400 格的列');
  assert.ok(plan.projected.observedCells > 500);
});

test('恰好达到水位也触发裁剪', () => {
  // sections 8 / max 10 = 0.8? 用 cells：400/500 = 0.8，刚好是 trigger。
  const plan = planRetention(input([
    entry(0, 0, { observedCells: 200 }),
    entry(1, 0, { observedCells: 200 }),
  ], { limits: { maxVoxelSections: 10, maxObservedCells: 500, maxPaletteEntries: 100, maxBytes: 10_000 } }));
  assert.notEqual(plan.reason, 'below_trigger', '等于 80% 水位也要裁剪');
});

test('严格前缀：更老的格放不进预算就停，不跳过它去删更小的新格', () => {
  const plan = planRetention(input(
    [entry(0, 0, { seq: 1, observedCells: 400 }), entry(0, 1, { seq: 2, observedCells: 50 })],
    { limits: { maxVoxelSections: 10, maxObservedCells: 400, maxPaletteEntries: 100, maxBytes: 10_000 }, maxObservedCellsPerPass: 100 },
  ));
  assert.deepEqual(plan.keys, [], '老格 400 格放不进 100 格预算，直接停');
  assert.equal(plan.reason, 'max_sections_per_pass');
});

test('计划的投影覆盖四项容量，且 keys 来自整列', () => {
  const plan = planRetention(input([
    entry(0, 0, { observedCells: 600, bytes: 600, paletteEntries: 60 }),
    entry(0, 1, { observedCells: 300, bytes: 300, paletteEntries: 30 }),
    entry(1, 0, { observedCells: 300, bytes: 300, paletteEntries: 30 }),
  ]));
  assert.equal(plan.keys.length, 2, '列 0 的 2 个 Section 一起删');
  assert.ok(plan.projected.observedCells <= 500);
  assert.ok(plan.projected.paletteEntries <= 50);
  assert.ok(plan.projected.bytes <= 5000);
});
