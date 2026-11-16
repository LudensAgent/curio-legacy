import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Attention } from '../src/mind/attention.ts';
import { Mind } from '../src/mind/mind.ts';

test('同一趟换过多个方向、最远点没推进时给事实提醒；只提醒一次', (t) => {
  const now = 1_700_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const mind = Object.create(Mind.prototype) as any;
  const at = (minutes: number) => now - minutes * 60_000;
  const leg = {
    id: 'leg_test', dim: 'the_nether', worldId: 'w', startedAt: at(30), lastSampleAt: now,
    frontier: [at(12)], farthest: { x: 0, y: 64, z: 0, dist: 85 },
    farthestByDirection: {
      E: { x: 30, y: 64, z: 0, dist: 30, at: at(2) },
      W: { x: -30, y: 64, z: 0, dist: 30, at: at(3) },
      N: { x: 0, y: 64, z: -30, dist: 30, at: at(4) },
    },
    explores: [],
  };
  mind.d = { excursions: { current: () => leg }, adapter: { state: () => ({ dim: 'the_nether', worldId: 'w' }) } };
  mind.attention = new Attention();
  mind.safe = (fn: () => unknown) => fn();
  mind.noteCircling({ dim: 'the_nether', worldId: 'w' });
  const first = mind.attention.peek();
  assert.equal(first.length, 1);
  assert.match(first[0].what, /已换过 E\/W\/N 3 个方向/);
  assert.match(first[0].what, /最远 85 格/);
  assert.match(first[0].what, /12 分钟没再推进/);
  assert.match(first[0].what, /可续接 sessionId/);
  // 冷却内不重复提
  mind.noteCircling({ dim: 'the_nether', worldId: 'w' });
  assert.equal(mind.attention.peek().length, 1);
});

test('最远点还在推进或方向不足三个时不提醒', (t) => {
  const now = 1_700_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const at = (minutes: number) => now - minutes * 60_000;
  const mind = Object.create(Mind.prototype) as any;
  mind.attention = new Attention();
  mind.safe = (fn: () => unknown) => fn();
  const base = {
    id: 'leg_test', dim: 'the_nether', worldId: 'w', startedAt: at(30), lastSampleAt: now,
    farthest: { x: 0, y: 64, z: 0, dist: 85 },
    farthestByDirection: {
      E: { dist: 30, at: at(2) }, W: { dist: 30, at: at(3) }, N: { dist: 30, at: at(4) },
    },
    explores: [],
  };
  mind.d = { excursions: { current: () => ({ ...base, frontier: [at(2)] }) }, adapter: { state: () => ({ dim: 'the_nether', worldId: 'w' }) } };
  mind.noteCircling({ dim: 'the_nether', worldId: 'w' });
  assert.equal(mind.attention.peek().length, 0, '刚推进过不提醒');
  mind.d = { excursions: { current: () => ({ ...base, frontier: [at(12)], farthestByDirection: { E: { dist: 30, at: at(2) } } }) }, adapter: { state: () => ({ dim: 'the_nether', worldId: 'w' }) } };
  mind.noteCircling({ dim: 'the_nether', worldId: 'w' });
  assert.equal(mind.attention.peek().length, 0, '方向不足三个不提醒');
});
