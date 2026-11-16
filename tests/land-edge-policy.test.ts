import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  LandSearchPolicyCell,
  LandSearchPolicyDecision,
  LandSearchPolicyEdge,
  LandSearchPolicyRead,
} from 'curio-minecraft-3d-memory/navigation';
import { EDGE_STANCE_COST, hostLandEdgePolicy, isConstructionFixablePolicyRejection, isDangerousBlock, isFirePolicyRejection, LAVA_EDGE_COST, policyRemedy } from '../src/spatial/land-edge-policy.ts';

type Hazard = LandSearchPolicyEdge['hazards'][number];
type CellEntry = readonly [x: number, y: number, z: number, cell: LandSearchPolicyCell];

const at = (x: number, y: number, z: number) => ({ x, y, z });
const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
const recorded = (name: string, stateComplete = true): LandSearchPolicyCell => ({
  kind: 'recorded', state: { name, properties: {} }, stateComplete,
});
const unknownCell: LandSearchPolicyCell = { kind: 'unknown' };
const unavailableCell: LandSearchPolicyCell = { kind: 'unavailable' };
const hazard = (kind: Hazard['kind']): Hazard => ({ kind, pos: at(0, 64, 0), basis: 'observed', detail: `${kind} test fact` });
const edgeAt = (to: { x: number; y: number; z: number }, overrides: Partial<LandSearchPolicyEdge> = {}): LandSearchPolicyEdge => ({
  kind: 'walk', from: at(0, 64, 0), to, baseCost: 1, hazards: [], evidenceMode: 'current', ...overrides,
});

/**
 * Bounded fake reader: a policy that over-reads fails instead of silently passing.
 * Unless an entry overrides it, the cell under each destination's feet centre (`supports`) is recorded stone.
 */
function fakeReader(entries: readonly CellEntry[] = [], maxReads = 64, supports: readonly { x: number; y: number; z: number }[] = DEFAULT_SUPPORTS) {
  const cells = new Map([
    ...supports.map((to) => [key(Math.floor(to.x), Math.round(to.y) - 1, Math.floor(to.z)), recorded('stone')] as const),
    ...entries.map(([x, y, z, cell]) => [key(x, y, z), cell] as const),
  ]);
  const reads: { x: number; y: number; z: number }[] = [];
  const read: LandSearchPolicyRead = {
    cell(x, y, z) {
      if (reads.length >= maxReads) throw new Error(`policy exceeded ${maxReads} reads`);
      reads.push(at(x, y, z));
      return cells.get(key(x, y, z)) ?? unknownCell;
    },
  };
  return { read, reads };
}

const allowedCost = (decision: LandSearchPolicyDecision): number => {
  if (!decision.allow) assert.fail(`expected the policy to allow the edge: ${decision.reason}`);
  return decision.extraCost ?? 0;
};

const rejectionReason = (decision: LandSearchPolicyDecision): string => {
  if (decision.allow) assert.fail('expected the policy to reject the edge');
  return decision.reason;
};

const DANGEROUS = ['lava', 'fire', 'soul_fire', 'magma_block', 'campfire', 'soul_campfire', 'cactus', 'sweet_berry_bush', 'powder_snow', 'cobweb', 'pointed_dripstone'] as const;
const HORIZONTAL = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
const DEFAULT_SUPPORTS = [at(0.5, 64, 0.5), at(-0.3, 63.95, -2.2)];

test('danger set: bare and minecraft: names only, no unrelated matches', () => {
  for (const name of DANGEROUS) {
    assert.equal(isDangerousBlock(name), true, name);
    assert.equal(isDangerousBlock(`minecraft:${name}`), true, `minecraft:${name}`);
  }
  for (const name of ['', 'air', 'stone', 'water', 'lava_block', 'nether_lava', 'mod:lava', 'minecraft:lava_block', 'minecraft:minecraft:lava', 'FIRE']) {
    assert.equal(isDangerousBlock(name), false, name);
  }
  assert.equal(LAVA_EDGE_COST, 3);
});

test('non-fall hazards are rejected before any read; fall alone is allowed', () => {
  for (const kind of ['water_contact', 'submersion', 'lava_contact', 'current', 'bubble_column'] as const) {
    const reader = fakeReader();
    const reason = rejectionReason(hostLandEdgePolicy.evaluate(edgeAt(at(0.5, 64, 0.5), { hazards: [hazard('fall'), hazard(kind)] }), reader.read));
    assert.match(reason, new RegExp(kind));
    assert.doesNotMatch(reason, /BLOCKED/);
    assert.equal(reader.reads.length, 0);
  }
  const reader = fakeReader();
  const decision = hostLandEdgePolicy.evaluate(edgeAt(at(0.5, 64, 0.5), { hazards: [hazard('fall')] }), reader.read);
  assert.equal(allowedCost(decision), 0);
  assert.ok(reader.reads.length <= 64, `每条边读取 ${reader.reads.length} 次，不超过库的每边上限`);
});

test('recorded dangerous destination feet/head/support cells reject the edge', () => {
  const to = at(0.5, 64, 0.5);

  const feetReader = fakeReader([[0, 64, 0, recorded('minecraft:lava')]]);
  const feetReason = rejectionReason(hostLandEdgePolicy.evaluate(edgeAt(to), feetReader.read));
  assert.match(feetReason, /minecraft:lava/);
  assert.match(feetReason, /feet/);
  assert.doesNotMatch(feetReason, /BLOCKED/);
  assert.equal(feetReader.reads.length, 1);

  const headReader = fakeReader([[0, 65, 0, recorded('magma_block')]]);
  const headReason = rejectionReason(hostLandEdgePolicy.evaluate(edgeAt(to), headReader.read));
  assert.match(headReason, /magma_block/);
  assert.match(headReason, /head/);
  assert.equal(headReader.reads.length, 2);

  const supportReader = fakeReader([[0, 63, 0, recorded('sweet_berry_bush')]]);
  const supportReason = rejectionReason(hostLandEdgePolicy.evaluate(edgeAt(to), supportReader.read));
  assert.match(supportReason, /sweet_berry_bush/);
  assert.match(supportReason, /support/);
  assert.equal(supportReader.reads.length, 3);
});

test('incomplete recorded names still reject or price by their known name', () => {
  const feetReader = fakeReader([[0, 64, 0, recorded('minecraft:lava', false)]]);
  assert.match(rejectionReason(hostLandEdgePolicy.evaluate(edgeAt(at(0.5, 64, 0.5)), feetReader.read)), /minecraft:lava/);

  const neighborReader = fakeReader([[1, 63, 0, recorded('lava', false)]]);
  const decision = hostLandEdgePolicy.evaluate(edgeAt(at(0.5, 64, 0.5)), neighborReader.read);
  assert.equal(allowedCost(decision), LAVA_EDGE_COST);
});

test('unknown or unavailable destination facts do not invent a dangerous name', () => {
  for (const cell of [unknownCell, unavailableCell]) {
    const reader = fakeReader([[0, 64, 0, cell]]);
    const decision = hostLandEdgePolicy.evaluate(edgeAt(at(0.5, 64, 0.5)), reader.read);
    assert.equal(allowedCost(decision), 0);
  }
});

test('fractional and negative destinations address the floored legacy cell', () => {
  const to = at(-0.3, 63.95, -2.2);
  const reader = fakeReader([[-1, 64, -3, recorded('cobweb')]]);
  const reason = rejectionReason(hostLandEdgePolicy.evaluate(edgeAt(to), reader.read));
  assert.match(reason, /cobweb/);
  assert.deepEqual(reader.reads[0], at(-1, 64, -3));

  const allowed = fakeReader();
  assert.equal(allowedCost(hostLandEdgePolicy.evaluate(edgeAt(to), allowed.read)), 0);
  assert.equal(allowed.reads[0]?.x, -1);
  assert.equal(allowed.reads[0]?.y, 64);
  assert.equal(allowed.reads[0]?.z, -3);
});

for (const [dx, dz] of HORIZONTAL) {
  for (const dy of [0, -1]) {
    const height = dy === 0 ? 'foot' : 'support';
    test(`lava at ${height} neighbor (${dx},${dz}) adds ${LAVA_EDGE_COST}`, () => {
      const name = dy === 0 ? 'lava' : 'minecraft:lava';
      const reader = fakeReader([[dx, 64 + dy, dz, recorded(name)]]);
      const decision = hostLandEdgePolicy.evaluate(edgeAt(at(0.5, 64, 0.5)), reader.read);
      assert.equal(allowedCost(decision), LAVA_EDGE_COST);
      assert.ok(reader.reads.length <= 64, `每条边读取 ${reader.reads.length} 次，不超过库的每边上限`);
    });
  }
}

test('each recorded lava neighbor is counted, with a finite surcharge for a sole edge', () => {
  const entries = HORIZONTAL.flatMap(([dx, dz]) => [0, -1].map((dy): CellEntry => [
    dx, 64 + dy, dz, recorded(dy === 0 ? 'lava' : 'minecraft:lava'),
  ]));
  const reader = fakeReader(entries);
  const decision = hostLandEdgePolicy.evaluate(edgeAt(at(0.5, 64, 0.5)), reader.read);
  assert.equal(allowedCost(decision), HORIZONTAL.length * 2 * LAVA_EDGE_COST);
  assert.ok(reader.reads.length <= 64, `每条边读取 ${reader.reads.length} 次，不超过库的每边上限`);
});

test('non-lava, unknown and unavailable neighbors add no surcharge', () => {
  const reader = fakeReader([
    [1, 64, 0, recorded('water')],
    [-1, 64, 0, recorded('magma_block')],
    [0, 64, 1, unknownCell],
    [0, 64, -1, unavailableCell],
    [1, 63, 0, recorded('minecraft:stone')],
    [-1, 63, 0, recorded('minecraft:fire')],
    [0, 63, 1, recorded('lava_block')],
    [0, 63, -1, unavailableCell],
  ]);
  assert.equal(allowedCost(hostLandEdgePolicy.evaluate(edgeAt(at(0.5, 64, 0.5)), reader.read)), 0);
});

test('current and remembered evidence modes use the same recorded-name policy', () => {
  const entries: CellEntry[] = [
    [1, 64, 0, recorded('lava')],
    [0, 63, 1, recorded('minecraft:lava', false)],
  ];
  const currentReader = fakeReader(entries);
  const rememberedReader = fakeReader(entries);
  const current = hostLandEdgePolicy.evaluate(edgeAt(at(0.5, 64, 0.5), { evidenceMode: 'current' }), currentReader.read);
  const remembered = hostLandEdgePolicy.evaluate(edgeAt(at(0.5, 64, 0.5), { evidenceMode: 'remembered' }), rememberedReader.read);
  assert.equal(allowedCost(current), 2 * LAVA_EDGE_COST);
  assert.deepEqual(remembered, current);
});

test('evaluation does not mutate the edge or its positions', () => {
  const from = Object.freeze(at(0, 64, 0));
  const to = Object.freeze(at(-0.3, 63.95, -2.2));
  const hazards = Object.freeze([Object.freeze(hazard('fall'))]);
  const edge = Object.freeze<LandSearchPolicyEdge>({
    kind: 'walk', from, to, baseCost: 1, hazards, evidenceMode: 'remembered',
  });
  const before = JSON.stringify(edge);
  // 落点身体脚面覆盖到 (0,64,-3)：那一格的岩浆会碰到身体，按扫掠危险拒绝，而不是只加价。
  const reader = fakeReader([[0, 64, -3, recorded('minecraft:lava')]]);
  assert.match(rejectionReason(hostLandEdgePolicy.evaluate(edge, reader.read)), /swept body/);
  assert.equal(JSON.stringify(edge), before);
  assert.deepEqual(to, at(-0.3, 63.95, -2.2));
  assert.deepEqual(from, at(0, 64, 0));
});

test('reader errors propagate unchanged', () => {
  let calls = 0;
  const read: LandSearchPolicyRead = {
    cell() {
      calls += 1;
      if (calls === 3) throw new Error('reader exploded');
      return unknownCell;
    },
  };
  assert.throws(() => hostLandEdgePolicy.evaluate(edgeAt(at(0.5, 64, 0.5)), read), /reader exploded/);
  assert.equal(calls, 3);
});

test('permitted edge stays within the per-edge read bound (swept body, support and lava neighbors)', () => {
  const reader = fakeReader([], 64);
  assert.equal(allowedCost(hostLandEdgePolicy.evaluate(edgeAt(at(0.5, 64, 0.5)), reader.read)), 0);
  assert.ok(reader.reads.length <= 64, `每条边读取 ${reader.reads.length} 次，不超过库的每边上限`);
  const expected = [
    key(0, 64, 0), key(0, 65, 0), key(0, 63, 0),
    ...HORIZONTAL.flatMap(([dx, dz]) => [64, 63].map((y) => key(dx, y, dz))),
  ].sort();
  const read = new Set(reader.reads.map(({ x, y, z }) => key(x, y, z)));
  assert.ok(expected.every((cell) => read.has(cell)), '落点脚/头/支撑与岩浆邻格都被读取');
});

test('桥头擦边：邻列有已记录支撑时允许并加价；无支撑才交回观察/拒绝', () => {
  // 复现：桥面圆石到 x=94 为止，路线保留起点偏移走到 x=95.29，身体只压住 x=94 那列 0.01 格。
  const to = at(95.29, 70, -39.55);
  const edge = edgeAt(to, { from: at(94.29, 70, -39.55) });
  const edgeOnly = fakeReader([[94, 69, -40, recorded('cobblestone')]], 64, []);
  assert.equal(allowedCost(hostLandEdgePolicy.evaluate(edge, edgeOnly.read)), EDGE_STANCE_COST, '压住邻列边缘有已记录支撑：允许，但加价');
  const centred = fakeReader([[95, 69, -40, recorded('cobblestone')]], 64, []);
  assert.equal(allowedCost(hostLandEdgePolicy.evaluate(edge, centred.read)), 0);
  const centreAir = fakeReader([[94, 69, -40, recorded('cobblestone')], [95, 69, -40, recorded('air')]], 64, []);
  assert.equal(allowedCost(hostLandEdgePolicy.evaluate(edge, centreAir.read)), EDGE_STANCE_COST, '中心是空气但邻列有支撑：按边缘站姿允许');
  const unknownBelow = fakeReader([], 64, []);
  const stillDeferred = hostLandEdgePolicy.evaluate(edge, unknownBelow.read);
  assert.equal(stillDeferred.allow, false);
  assert.equal(stillDeferred.observe, true);
  const unavailableBelow = fakeReader([[95, 69, -40, unavailableCell]], 64, []);
  assert.match(rejectionReason(hostLandEdgePolicy.evaluate(edge, unavailableBelow.read)), /no observed support/);
  // 分数脚高（站在下半砖上）：支撑就是脚所在那一格。
  const slab = fakeReader([[95, 69, -40, { kind: 'recorded', state: { name: 'stone_slab', properties: { type: 'bottom' } }, stateComplete: true }]], 64, []);
  assert.equal(allowedCost(hostLandEdgePolicy.evaluate(edgeAt(at(95.5, 69.5, -39.5), { from: at(94.5, 69.5, -39.5) }), slab.read)), 0);
});

test('边缘站姿下方是已记录的水时拒绝：连续行走滑过一点就会掉进去', () => {
  const to = at(95.29, 70, -39.55);
  const edge = edgeAt(to, { from: at(94.29, 70, -39.55) });
  // 中心列 (95,69,-40) 是空气，下面 y=68 是水；邻列 (94,69,-40) 有圆石支撑。
  const waterBelow = fakeReader([
    [94, 69, -40, recorded('cobblestone')],
    [95, 69, -40, recorded('air')],
    [95, 68, -40, recorded('water')],
  ], 64, []);
  const reason = rejectionReason(hostLandEdgePolicy.evaluate(edge, waterBelow.read));
  assert.match(reason, /unsupported feet-centre column drops into recorded water/);
  assert.equal(isConstructionFixablePolicyRejection(reason), true, 'place 可以补上脚底中心支撑');
  // 下面是干实地：仍按旧矿道/桥头的边缘站姿放行并加价。
  const dryBelow = fakeReader([
    [94, 69, -40, recorded('cobblestone')],
    [95, 69, -40, recorded('air')],
    [95, 68, -40, recorded('stone')],
  ], 64, []);
  assert.equal(allowedCost(hostLandEdgePolicy.evaluate(edge, dryBelow.read)), EDGE_STANCE_COST);
  // 下面是岩浆：按危险格拒绝，不是 place 能直接补的普通缺口。
  const lavaBelow = fakeReader([
    [94, 69, -40, recorded('cobblestone')],
    [95, 69, -40, recorded('air')],
    [95, 68, -40, recorded('lava')],
  ], 64, []);
  assert.match(rejectionReason(hostLandEdgePolicy.evaluate(edge, lavaBelow.read)), /dangerous block lava/);
});

test('跨缺口跳跃：超出不疾跑起跳能力的宽缺口不规划；落空会掉进火/岩浆的缺口不规划', () => {
  // 复现：从 (-73.39,69) 水平跳 3 格到 (-70.39,69)，缺口下方 3 格是火。
  const wide = edgeAt(at(-70.39, 69, -18.55), { kind: 'jump', from: at(-73.39, 69, -18.55) });
  const supports = [at(-70.39, 69, -18.55), at(-71.5, 69, -18.5)];
  assert.match(rejectionReason(hostLandEdgePolicy.evaluate(wide, fakeReader([], 64, supports).read)), /without sprinting/);
  const gap = edgeAt(at(-71.5, 69, -18.5), { kind: 'jump', from: at(-73.5, 69, -18.5) });
  const overFire = fakeReader([
    [-73, 68, -19, recorded('minecraft:air')], [-73, 67, -19, recorded('minecraft:air')], [-73, 66, -19, recorded('fire')],
  ], 128, supports);
  assert.match(rejectionReason(hostLandEdgePolicy.evaluate(gap, overFire.read)), /miss would land in recorded fire at \(-73,66,-19\)/);
  const overFloor = fakeReader([[-73, 68, -19, recorded('minecraft:air')], [-73, 67, -19, recorded('netherrack')], [-73, 66, -19, recorded('fire')]], 128, supports);
  assert.equal(allowedCost(hostLandEdgePolicy.evaluate(gap, overFloor.read)), 0, '缺口下先碰到实心地面，落空也落在地面上');
});

const remedy = (reason: string) => policyRemedy(reason, { fireClearable: true });

test('策略拒绝的可改项：只说哪种授权能改变这条边，任何授权都改不了也如实说', () => {
  const to = at(95.29, 70, -39.55);
  const edge = edgeAt(to, { from: at(94.29, 70, -39.55) });
  const remedyOf = (entries: readonly CellEntry[] = [], supports: readonly { x: number; y: number; z: number }[] = []) =>
    remedy(rejectionReason(hostLandEdgePolicy.evaluate(edge, fakeReader(entries, 64, supports).read)));

  const headWater = rejectionReason(hostLandEdgePolicy.evaluate(edge, fakeReader([[95, 71, -40, recorded('water')]], 64, []).read));
  assert.match(headWater, /destination head cell \(submersion\)/);
  assert.match(remedy(headWater), /swim:true 只放宽脚格水/);
  assert.match(remedy(headWater), /授权也改不了/);
  assert.match(remedy(headWater), /swim_path 的水面路线/);
  assert.match(remedy('host policy rejects geometric submersion hazard; only fall is allowed'), /淹头\/淹没/);

  assert.match(remedyOf([[95, 70, -40, recorded('water')]]), /swim:true 会让这条边变成涉水边/);

  const wet = hostLandEdgePolicy.evaluate(edgeAt(to, { hazards: [hazard('water_contact')] }), fakeReader().read);
  assert.match(remedy(rejectionReason(wet)), /water_contact 这类边要 swim:true 才允许/);
  assert.match(remedy('host policy rejects geometric water_contact, lava_contact hazard; only fall is allowed'), /只放宽 water_contact，lava_contact 仍拒绝/);
  assert.doesNotMatch(remedy('host policy rejects geometric lava_contact hazard; only fall, water_contact is allowed'), /swim:true/,
    '允许列表里的 water_contact 不算这条边的可改项');

  assert.match(remedyOf([[95, 69, -40, unavailableCell]]), /只有 place 能补/);

  const wide = edgeAt(at(-70.39, 69, -18.55), { kind: 'jump', from: at(-73.39, 69, -18.55) });
  const wideReason = rejectionReason(hostLandEdgePolicy.evaluate(wide, fakeReader([], 64, [at(-70.39, 69, -18.55), at(-71.5, 69, -18.5)]).read));
  assert.match(remedy(wideReason), /place 能搭桥缩短缺口/);

  assert.match(remedyOf([[95, 69, -40, recorded('minecraft:fire')]]), /place 会把方块直接放在火的位置上/);
  assert.match(remedy('host policy rejects a gap jump whose miss would land in recorded fire at (-73,66,-19)'), /不会改变这条 jump/);
  assert.match(remedy('host policy rejects recorded dangerous block fire at the destination feet cell'), /宿主会顺手打灭，不需要为此加 dig\/place 授权/);
  assert.equal(isFirePolicyRejection('host policy rejects recorded dangerous block minecraft:soul_fire at the destination feet cell'), true);
  assert.equal(isFirePolicyRejection('host policy rejects recorded dangerous block fire at the destination feet cell'), true);
  assert.equal(isFirePolicyRejection('host policy rejects recorded dangerous block campfire at the destination feet cell'), false);

  assert.match(remedyOf([[95, 69, -40, recorded('lava')]]), /本次委托的授权不会改变这条边/);
  assert.match(remedyOf([[95, 69, -40, recorded('campfire')]]), /危险格（岩浆等）/);
  assert.match(remedy('host policy rejects geometric current hazard; only fall is allowed'), /危险格（岩浆等）/);
  assert.match(remedy('host policy rejects recorded dangerous block minecraft:lava at the destination support cell'), /危险格（岩浆等）/);
  assert.match(policyRemedy('host policy rejects recorded dangerous block fire at the destination feet cell', { fireClearable: false }), /没有开路授权，宿主不会打灭/);
  assert.equal(remedy('some future host policy reason'), '', '未知原因不猜');
});

test('策略拒绝分类：缺中心支撑/宽缺口可由授权 place 修，危险格与未授权涉水仍交回', () => {
  const to = at(95.29, 70, -39.55);
  const edge = edgeAt(to, { from: at(94.29, 70, -39.55) });
  const unavailableBelow = fakeReader([[95, 69, -40, unavailableCell]], 64, []);
  assert.equal(isConstructionFixablePolicyRejection(rejectionReason(hostLandEdgePolicy.evaluate(edge, unavailableBelow.read))), true);

  const wide = edgeAt(at(-70.39, 69, -18.55), { kind: 'jump', from: at(-73.39, 69, -18.55) });
  const supports = [at(-70.39, 69, -18.55), at(-71.5, 69, -18.5)];
  assert.equal(isConstructionFixablePolicyRejection(rejectionReason(hostLandEdgePolicy.evaluate(wide, fakeReader([], 64, supports).read))), true);

  const lava = fakeReader([[95, 70, -40, recorded('minecraft:lava')]], 64, []);
  assert.equal(isConstructionFixablePolicyRejection(rejectionReason(hostLandEdgePolicy.evaluate(edge, lava.read))), false);
  const water = fakeReader([[95, 70, -40, recorded('minecraft:water')]], 64, []);
  assert.equal(isConstructionFixablePolicyRejection(rejectionReason(hostLandEdgePolicy.evaluate(edge, water.read))), false);
  assert.equal(isConstructionFixablePolicyRejection('host policy rejects geometric lava hazard; only fall is allowed'), false);
});
