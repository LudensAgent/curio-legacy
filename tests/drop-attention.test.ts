import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Attention } from '../src/mind/attention.ts';
import { Perception, type Percept } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { FakeAdapter } from './fake-adapter.ts';

const baseline = (() => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null);
  const snapshot = new Perception(adapter, memory, new EventBus(), new Vision(adapter)).update();
  memory.close();
  return snapshot;
})();
const percept = (drops: NonNullable<Percept['vision']>['visible_drops']) => ({
  ...baseline, vision: { ...baseline.vision!, visible_drops: drops },
});
const drop = (id: number, item = 'cobblestone') => ({ ids: [id], item, count: 1, dist: 3, dir: 'N' });

test('the grouped visual summary keeps each visible drop entity ID', () => {
  const adapter = new FakeAdapter(), vision = new Vision(adapter);
  adapter.entities.push(
    { id: 1, name: 'item:cobblestone', kind: 'item', count: 2, pos: { x: 4, y: 65, z: 0 }, dist: 0, height: 0.25 },
    { id: 2, name: 'item:cobblestone', kind: 'item', count: 3, pos: { x: 5, y: 65, z: 0 }, dist: 0, height: 0.25 },
    { id: 3, name: 'item:coal', kind: 'item', count: 1, pos: { x: 6, y: 65, z: 0 }, dist: 0, height: 0.25 },
  );
  vision.scan();
  const drops = vision.summary(adapter.pos).visible_drops;
  assert.deepEqual(drops?.map(({ ids, item, count }) => ({ ids, item, count })), [
    { ids: [1, 2], item: 'cobblestone', count: 5 }, { ids: [3], item: 'coal', count: 1 },
  ]);
});

test('first-frame drops are already available to the initial thought and do not create another notice', () => {
  const attention = new Attention();
  assert.deepEqual(attention.fromPercept(percept([drop(1)]), 0, true), []);
  attention.fromPercept(percept([]), 1, true);
  assert.deepEqual(attention.fromPercept(percept([drop(1)]), 120_000, true), []);
  assert.deepEqual(attention.peek(), []);
});

test('turning away and seeing the same drop again never retriggers it after the old cooldown', () => {
  const attention = new Attention();
  attention.fromPercept(percept([]), 0, true);
  assert.equal(attention.fromPercept(percept([drop(1)]), 1, true).length, 1);
  attention.drain();
  attention.fromPercept(percept([]), 2, true);
  assert.deepEqual(attention.fromPercept(percept([drop(1)]), 600_000, true), []);
  assert.equal(attention.highest(), 0);
});

test('new entities of the same item still reach attention without a name-based cooldown', () => {
  const attention = new Attention();
  attention.fromPercept(percept([]), 0, true);
  const first = attention.fromPercept(percept([drop(1)]), 1, true);
  const second = attention.fromPercept(percept([{ ...drop(2), ids: [1, 2], count: 2 }]), 2, true);
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.notEqual(first[0].key, second[0].key);
  assert.equal(attention.peek().length, 2, 'both observations remain pending for the normal thought scheduler');
  assert.equal(attention.fromPercept(percept([{ ...drop(2), ids: [1, 2], count: 2 }]), 3, true).length, 0);
});

test('the pickup preference decides between a light reconsideration and a passive note', () => {
  const attention = new Attention();
  attention.fromPercept(percept([]), 0);
  const passive = attention.fromPercept(percept([drop(1)]), 1);
  assert.equal(passive[0].salience, 0.4);
  assert.equal(passive[0].level, 'note');
  const active = attention.fromPercept(percept([drop(2, 'coal')]), 2, true);
  assert.equal(active[0].salience, 0.5);
  assert.equal(active[0].level, 'reconsider');
});

test('multiple new drops in the same observation are one combined notice', () => {
  const attention = new Attention();
  attention.fromPercept(percept([]), 0, true);
  const notices = attention.fromPercept(percept([
    { ...drop(1), ids: [1, 2], count: 2 }, drop(3, 'coal'), drop(4, 'torch'),
  ]), 1, true);
  assert.equal(notices.length, 1);
  assert.match(notices[0].what, /cobblestone×2.*coal×1.*torch×1/);
  assert.equal(attention.peek().length, 1);
});

test('reset clears observed entity IDs so a new session can reuse them', () => {
  const attention = new Attention();
  attention.fromPercept(percept([]), 0, true);
  attention.fromPercept(percept([drop(1)]), 1, true);
  attention.reset();
  assert.deepEqual(attention.peek(), []);
  attention.fromPercept(percept([]), 2, true);
  assert.equal(attention.fromPercept(percept([drop(1)]), 3, true).length, 1);
});
