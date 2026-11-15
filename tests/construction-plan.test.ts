import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GameAdapter } from '../src/adapter/types.ts';
import { planConstruction } from '../src/building/plan.ts';
import { normalizeSpec } from '../src/building/spec.ts';
import { InstantBuildWorld } from './survival-helpers.ts';

const k = (p: number[]) => p.join(',');

test('建造顺序：简单 spec 给出阶段、脚手架与材料', () => {
  const w = new InstantBuildWorld();
  const plan = planConstruction(w, { spec: normalizeSpec({ name: '石屋', width: 7, depth: 7, height: 3, roof: 'gable' }) });
  assert.equal(plan.mode, 'spec');
  assert.ok(plan.phases?.some((p) => p.phase === 'foundation'));
  assert.ok(plan.phases?.some((p) => p.phase === 'roof'));
  assert.ok((plan.temporary?.length ?? 0) > 0, 'house 应给脚手架');
  assert.ok((plan.materials?.cobblestone ?? 0) > 0);
  assert.ok((plan.temporaryMaterials?.cobblestone ?? 0) > 0);
  assert.deepEqual(w.actions, [], '规划只读，不产生身体动作');
});

test('建造顺序：下界门框先下后上，顶排先垫临时角块；placed 支撑一定更早出现', () => {
  const w = new InstantBuildWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  const origin = { x: 0, y: 64, z: 0 };
  const frame = ([[1, 0], [2, 0], ...[1, 2, 3].flatMap((y) => [[0, y], [3, y]]), [1, 4], [2, 4]] as [number, number][])
    .map(([u, y]) => ({ pos: { x: origin.x + u, y: origin.y + y, z: origin.z }, name: 'obsidian' }));
  const interior = [1, 2, 3].flatMap((y) => [1, 2].map((x) => ({ x, y: origin.y + y, z: 0 })));
  const plan = planConstruction(w, { cells: frame, keepClear: interior });
  assert.deepEqual(plan.warnings, [], JSON.stringify(plan.warnings));
  const flat = plan.order.flatMap((l) => l.cells);
  assert.equal(flat.length, 10);
  const ys = plan.order.map((l) => l.y);
  assert.deepEqual(ys, [...ys].sort((a, b) => a - b), '按层从下往上');
  const top = plan.order.find((l) => l.y === 68)!;
  assert.equal(top.cells.length, 2);
  assert.ok(plan.temporary.some((t) => t.pos[1] === 68), '顶排需要同层临时支撑');
  assert.ok(top.cells.every((c) => c.support !== 'none'));
  const earlier = new Set<string>();
  for (const cell of flat) {
    if (cell.support === 'placed') {
      const [x, y, z] = cell.pos;
      assert.ok([[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
        .some(([dx, dy, dz]) => earlier.has(k([x + dx, y + dy, z + dz]))), `placed 支撑 (${cell.pos}) 应已出现在更早的 order 里`);
    }
    earlier.add(k(cell.pos));
  }
  for (const t of plan.temporary) assert.ok(!interior.some((p) => k([p.x, p.y, p.z]) === k(t.pos)), `临时支撑不能占用 keepClear：${t.pos}`);
});

test('建造顺序：悬空屋顶先垫柱；离地太远则报缺口', () => {
  const w = new InstantBuildWorld();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  const roof = [[0, 0], [1, 0], [2, 0]].map(([x, z]) => ({ pos: { x, y: 67, z }, name: 'cobblestone' }));
  const plan = planConstruction(w, { cells: roof });
  assert.ok(plan.temporary.some((t) => t.pos[1] >= 64 && t.pos[1] <= 66), '屋顶下应有临时柱');
  assert.ok(plan.order.flatMap((l) => l.cells).every((c) => c.support !== 'none'));

  const floating = planConstruction(w, { cells: [{ pos: { x: 0, y: 80, z: 0 }, name: 'obsidian' }], maxSupport: 2 });
  assert.ok(floating.warnings.length > 0);
  assert.equal(floating.order[0]!.cells[0]!.support, 'none');
});

test('建造顺序：一面被 keepClear 挡住时换另一面垫柱，不放弃', () => {
  const w = new InstantBuildWorld();
  const plan = planConstruction(w, {
    cells: [{ pos: { x: 0, y: 67, z: 0 }, name: 'cobblestone' }],
    keepClear: [{ x: 1, y: 65, z: 0 }],
  });
  assert.deepEqual(plan.warnings, [], JSON.stringify(plan.warnings));
  assert.ok(plan.temporary.some((t) => t.pos[0] === -1), `应在 -x 面垫柱，实际 ${JSON.stringify(plan.temporary)}`);
});

test('建造顺序：放不上的格不算贴面，邻近格不能标成 placed', () => {
  const w = new InstantBuildWorld();
  const plan = planConstruction(w, {
    cells: [{ pos: { x: 0, y: 80, z: 0 }, name: 'obsidian' }, { pos: { x: 1, y: 80, z: 0 }, name: 'obsidian' }],
    maxSupport: 2,
  });
  assert.ok(plan.order[0]!.cells.every((c) => c.support !== 'placed'));
  assert.equal(plan.order[0]!.cells.length, 2);
  assert.equal(plan.warnings.length, 2);
});

test('建造顺序：未加载/看不清的格按 unknown 处理，不当作空气或实心面', () => {
  const nowhere = { blockAt: () => null } as unknown as GameAdapter;
  const plan = planConstruction(nowhere, { cells: [{ pos: { x: 0, y: 80, z: 0 }, name: 'cobblestone' }] });
  assert.deepEqual(plan.temporary, []);
  assert.equal(plan.order[0]!.cells[0]!.support, 'unknown');
  assert.match(plan.warnings.join('；'), /未加载|看不清/);
});
