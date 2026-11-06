import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventBus } from '../src/events.ts';
import { husbandryFacts, villagerFacts } from '../src/knowledge/husbandry.ts';
import { Ledger } from '../src/mind/ledger.ts';
import { SKILLS } from '../src/skills/index.ts';
import { FakeAdapter } from './fake-adapter.ts';

test('养动物的说明书：只在打算里提到养/引/喂时给；点名了哪种动物就只给它的吃食，通用机制每次都带', () => {
  assert.equal(husbandryFacts('去挖铁'), null);
  const cow = husbandryFacts('把牛引回家养起来')!;
  assert.match(cow, /牛：吃小麦/);
  assert.doesNotMatch(cow, /猪：/, '没点名的动物不给');
  assert.match(cow, /lead/, '带着走的办法要提到');
  assert.match(cow, /两只成年各喂一次/);
  assert.match(cow, /6000 个实体刻.*游戏钟表约 6 小时/);
  assert.match(cow, /24000 个实体刻.*游戏钟表 1 天/);
  assert.match(husbandryFacts('养鸡')!, /6000–12000 个实体刻.*游戏钟表约 6–12 小时/);
  const any = husbandryFacts('想养几只动物')!;
  assert.match(any, /牛：.*羊：.*猪：/s, '没点名就都给');
});

test('村民的说明书：按打算里说的事挑相关的几条', () => {
  assert.equal(villagerFacts('砍树'), null);
  assert.match(villagerFacts('去村庄用小麦换绿宝石')!, /农民收小麦/);
  assert.match(villagerFacts('给村民放讲台换职业')!, /讲台 lectern/);
  assert.match(villagerFacts('让村民繁殖')!, /多余的床/);
  assert.match(villagerFacts('治疗僵尸村民')!, /3600–6000 个实体刻.*游戏钟表约 3 小时 36 分至 6 小时/);
});

test('打猎的账：按 hunt 的活数次数、估只数、最近几次走多远', () => {
  const ledger = new Ledger(null, new EventBus(), () => { throw new Error('不用状态'); });
  let at = 1_000_000;
  assert.equal(ledger.huntTally().trips, 0);
  ledger.closeEpisode({ what: '打两头牛', kind: 'gather', signature: 'hunt:cow', outcome: 'done', sec: 90, gained: { beef: 4, leather: 1 } }, at += 60_000);
  ledger.closeEpisode({ what: '砍树', kind: 'gather', signature: 'gather:oak_log', outcome: 'done', sec: 60, gained: { oak_log: 8 } }, at += 60_000);
  ledger.closeEpisode({ what: '找鸡', kind: 'gather', signature: 'explore > hunt:chicken', outcome: 'done', sec: 200, gained: { chicken: 1, feather: 2 } }, at += 60_000);
  const t = ledger.huntTally();
  assert.equal(t.trips, 2);
  assert.equal(t.animals, 3, '4 块牛肉按 2 只估，1 块鸡肉 1 只');
  assert.equal(t.lastAt, at);
});
