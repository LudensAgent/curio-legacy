import assert from 'node:assert/strict';
import { test } from 'node:test';
import { queryMechanics } from '../src/methods/mechanics.ts';
import { SKILLS } from '../src/skills/index.ts';

test('empty mechanics query exposes only registered general operations with exact interfaces, without changing the registry', () => {
  const before = Object.keys(SKILLS), result = queryMechanics('', 20);
  for (const name of ['use_item', 'interact', 'boat_path', 'dismount', 'mine_cell', 'craft', 'look_around']) assert.ok(result.mechanics.some((entry) => entry.primitive === name));
  assert.equal(result.mechanics.some((entry) => ['boat', 'build', 'farm', 'expedition'].includes(entry.primitive)), false);
  for (const entry of result.mechanics) {
    assert.equal(entry.kind, 'primitive');
    assert.equal(entry.parameters, SKILLS[entry.primitive].argsDoc);
    assert.equal(entry.effect, SKILLS[entry.primitive].description);
    assert.equal(entry.source, 'registered_skills');
  }
  assert.deepEqual(Object.keys(SKILLS), before);
  assert.equal(queryMechanics('').mechanics.length, 6);
  assert.equal(queryMechanics('').hasMore, true);
});

test('mechanics search handles bilingual actions and exact names while keeping composites explicit and unknown abilities absent', () => {
  for (const query of ['拆除方块', 'break a block', 'dig']) assert.equal(queryMechanics(query, 1).mechanics[0]?.primitive, 'mine_cell', query);
  assert.equal(queryMechanics('右键实体', 1).mechanics[0]?.primitive, 'interact');
  assert.equal(queryMechanics('place blocks', 1).mechanics[0]?.primitive, 'use_item');
  const navigation = queryMechanics('boat', 1).mechanics[0];
  assert.equal(navigation?.primitive, 'boat_path'); assert.equal(navigation?.kind, 'primitive');
  assert.equal(SKILLS.boat, undefined);
  assert.deepEqual(queryMechanics('quantum telekinesis 999').mechanics, []);
  assert.equal(queryMechanics('use_item', 1).mechanics[0]?.parameters, SKILLS.use_item.argsDoc);
  assert.ok(queryMechanics('坐船').mechanics.some((entry) => entry.primitive === 'interact'), 'object language should also reveal general operations');
  assert.ok(queryMechanics('回收船').mechanics.some((entry) => entry.primitive === 'hit_entity'), 'left-clicking an entity is available without a recovery macro');
  assert.equal(queryMechanics('查看状态', 1).mechanics[0]?.primitive, 'inspect_block');
});
