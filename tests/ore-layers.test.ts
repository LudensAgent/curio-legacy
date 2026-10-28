import assert from 'node:assert/strict';
import { test } from 'node:test';
import { oreLayerFacts } from '../src/knowledge/ore-layers.ts';

test('1.20.1：说要找钻石，只给钻石的层，而且是新版的深层', () => {
  const t = oreLayerFacts('1.20.1', '开竖井下去找钻石')!;
  assert.match(t, /y-64~16/);
  assert.doesNotMatch(t, /洞穴里不如|平推巷道/);
  assert.doesNotMatch(t, /铜/);
});

test('只说下矿没点名：各种矿都给', () => {
  const t = oreLayerFacts('1.21.4', '下矿')!;
  assert.match(t, /钻石/); assert.match(t, /铁/); assert.match(t, /煤/);
});

test('1.18 以前的版本：不知道就不说', () => {
  assert.equal(oreLayerFacts('1.16.5', '找钻石'), null);
});

test('生成参数与世界采样峰值分开，不把高度概率当作现场矿物', () => {
  const t = oreLayerFacts('1.20.1', '下矿')!;
  for (const fact of ['y16', 'y232', 'y96', 'y-16', 'y48', '不保证眼前有矿']) assert.ok(t.includes(fact), fact);
  assert.doesNotMatch(t, /y14|y45|y-18|一次一块|y8 以下是深板岩/);
});
