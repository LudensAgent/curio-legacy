import assert from 'node:assert/strict';
import { test } from 'node:test';
import { passageRouteInspection } from '../src/memory/passages.ts';

const at = (x: number, y: number, z: number) => ({ x, y, z });
type Rec = { id: string; path: { x: number; y: number; z: number }[]; links?: { a: { x: number; y: number; z: number }; b: { x: number; y: number; z: number }; cut?: boolean; reverse?: boolean }[]; kind?: 'dug' | 'walked' | 'bridge'; deepestY?: number };
const rec = (id: string, path: Rec['path'], links?: Rec['links'], kind: Rec['kind'] = 'dug'): Rec => ({ id, path, ...(links ? { links } : {}), kind, deepestY: Math.min(...path.map((p) => p.y)) });

test('passageRouteInspection：多记录串联、每段 transition/evidence', () => {
  const a = rec('a', [at(0, 64, 0), at(1, 64, 0)], [{ a: at(0, 64, 0), b: at(1, 64, 0) }]);
  const b = rec('b', [at(1, 64, 0), at(2, 64, 0)], [{ a: at(1, 64, 0), b: at(2, 64, 0) }]);
  const result = passageRouteInspection([a, b], at(0, 64, 0), at(2, 64, 0), { near: 0.5, heal: false });
  assert.equal(result.status, 'route');
  assert.deepEqual(result.waypoints.map((p) => `${p.x},${p.y},${p.z}`), ['0,64,0', '1,64,0', '2,64,0']);
  assert.equal(result.legs.length, 2);
  assert.deepEqual(result.legs.map((leg) => leg.transitions), [['walk'], ['walk']]);
  assert.deepEqual(result.legs.map((leg) => leg.evidence), ['linked', 'linked']);
  assert.ok(result.legs.every((leg) => leg.reversible));
});

test('passageRouteInspection：纯垂直下坠正向可走、反向不可走', () => {
  const drop = rec('drop', [at(0, 59, 0), at(0, 57, 0)], [{ a: at(0, 59, 0), b: at(0, 57, 0) }]);
  const down = passageRouteInspection([drop], at(0, 59, 0), at(0, 57, 0), { near: 0.5 });
  assert.equal(down.status, 'route');
  assert.deepEqual(down.legs[0]?.transitions, ['drop']);
  assert.equal(down.legs[0]?.reversible, false);

  const up = passageRouteInspection([drop], at(0, 57, 0), at(0, 59, 0), { near: 0.5 });
  assert.equal(up.status, 'gap');
  assert.equal(up.reason, 'disconnected');
});

test('passageRouteInspection：reverse 证据让纯垂直落差可双向', () => {
  const drop = rec('drop', [at(0, 59, 0), at(0, 57, 0)], [{ a: at(0, 59, 0), b: at(0, 57, 0), reverse: true }]);
  const up = passageRouteInspection([drop], at(0, 57, 0), at(0, 59, 0), { near: 0.5 });
  assert.equal(up.status, 'route');
  assert.equal(up.legs[0]?.reversible, true);
});

test('passageRouteInspection：allowed 过滤在搜索时生效，并报告 disallowed_transition', () => {
  const drop = rec('drop', [at(0, 59, 0), at(0, 57, 0)], [{ a: at(0, 59, 0), b: at(0, 57, 0) }]);
  const blocked = passageRouteInspection([drop], at(0, 59, 0), at(0, 57, 0), { near: 0.5, allowed: ['walk', 'step'] });
  assert.equal(blocked.status, 'gap');
  assert.equal(blocked.reason, 'disallowed_transition');
  assert.deepEqual(blocked.rejectedLeg?.transitions, ['drop'], '被拒的 leg 事实要带回');
  assert.equal(blocked.rejectedLeg?.reversible, false);
  const allowed = passageRouteInspection([drop], at(0, 59, 0), at(0, 57, 0), { near: 0.5, allowed: ['walk', 'step', 'drop'] });
  assert.equal(allowed.status, 'route');
});

test('passageRouteInspection：多步 link 标 mixed；上爬只标 climb + mechanism unknown', () => {
  const mixed = rec('mixed', [at(0, 64, 0), at(1, 63, 0), at(1, 62, 0)], [{ a: at(0, 64, 0), b: at(1, 62, 0) }]);
  const multi = passageRouteInspection([mixed], at(0, 64, 0), at(1, 62, 0), { near: 0.5, allowed: ['walk', 'step', 'drop'] });
  assert.equal(multi.status, 'route');
  assert.deepEqual(multi.legs[0]?.transitions, ['step', 'drop']);
  assert.equal(multi.legs[0]?.mixed, true);

  const climb = rec('climb', [at(0, 62, 0), at(0, 64, 0)], [{ a: at(0, 62, 0), b: at(0, 64, 0) }]);
  const up = passageRouteInspection([climb], at(0, 62, 0), at(0, 64, 0), { near: 0.5, allowed: ['climb'] });
  assert.equal(up.status, 'route');
  assert.deepEqual(up.legs[0]?.transitions, ['climb']);
  assert.equal(up.legs[0]?.mechanism, 'unknown');
});

test('passageRouteInspection：heal 默认关闭不跨记录；显式开启才连并标 healed', () => {
  const a = rec('a', [at(0, 64, 0), at(1, 64, 0)]);
  const b = rec('b', [at(1.5, 64, 0), at(3, 64, 0)]);
  const closed = passageRouteInspection([a, b], at(0, 64, 0), at(3, 64, 0), { near: 0.5, heal: false });
  assert.equal(closed.status, 'gap');
  const healed = passageRouteInspection([a, b], at(0, 64, 0), at(3, 64, 0), { near: 0.5, heal: true, link: 1 });
  assert.equal(healed.status, 'route');
  assert.ok(healed.legs.some((leg) => leg.evidence === 'healed'));
});

test('passageRouteInspection：legacy 稀疏路径按 hop 连接并标 legacy；断连给最近可达点', () => {
  const sparse = rec('sparse', [at(0, 60, 0), at(0, 54, 0)]);
  const route = passageRouteInspection([sparse], at(0, 60, 0), at(0, 54, 0), { near: 0.5 });
  assert.equal(route.status, 'route');
  assert.deepEqual(route.legs[0]?.transitions, ['drop']);
  assert.equal(route.legs[0]?.evidence, 'legacy');

  const left = rec('left', [at(0, 64, 0), at(1, 64, 0)], [{ a: at(0, 64, 0), b: at(1, 64, 0) }]);
  const right = rec('right', [at(40, 64, 0), at(41, 64, 0)], [{ a: at(40, 64, 0), b: at(41, 64, 0) }]);
  const gap = passageRouteInspection([left, right], at(0, 64, 0), at(41, 64, 0), { near: 5, heal: false });
  assert.equal(gap.status, 'gap');
  assert.equal(gap.reason, 'disconnected');
  assert.deepEqual(gap.nearest, at(1, 64, 0));

  const empty = passageRouteInspection([], at(0, 64, 0), at(1, 64, 0), { near: 1 });
  assert.equal(empty.status, 'gap');
  assert.equal(empty.reason, 'empty');
});
