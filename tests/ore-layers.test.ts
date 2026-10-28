import assert from 'node:assert/strict';
import { test } from 'node:test';
import { oreLayerFacts } from '../src/knowledge/ore-layers.ts';

test('1.20.1：说要找钻石，只给钻石的层，而且是新版的深层', () => {
  const t = oreLayerFacts('1.20.1', '开竖井下去找钻石')!;
  assert.match(t, /y-59/);
  assert.doesNotMatch(t, /铜/);
});

test('只说下矿没点名：各种矿都给', () => {
  const t = oreLayerFacts('1.21.4', '下矿')!;
  assert.match(t, /钻石/); assert.match(t, /铁/); assert.match(t, /煤/);
});

test('1.18 以前的版本：不知道就不说', () => {
  assert.equal(oreLayerFacts('1.16.5', '找钻石'), null);
});
