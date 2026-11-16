import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { isMethodChoiceRule, needsProvisionalMethodLimit, PROVISIONAL_METHOD_LIMIT, refreshProvisionalMethodLimit } from '../src/mind/lesson-quality.ts';
import { SelfModel } from '../src/mind/self.ts';
import { parseConsolidation } from '../src/mind/thinker.ts';

// 以下三条是 2026-11-17 01:35 线上 /path/to/curio/data/live/mind.json 的原文，用来锁定实际误判/误伤风险。
const directFortress = '长距离回已知坐标别用 travel_to 直连（常被宿主边缘策略拒、连段无进展）；改 explore_toward 分段：direction+distance 48–96、segment 48、dig:true、place:"any"、maxDescent 8，一段段推（近期45/51格成段）。';
const shortTrip = '下界推进当短途往返：从门沿实岩开10–20格短巷，长段用 explore_toward 带 dig+place 一段段推；落点支撑是 air 或同层连断就是薄壳，别逐格补，换向或抬/降一层；开巷前带一组垫料，用完先回门口补；血/饱食见底退回。';
const parameterRule = '回已知坐标用 travel_to 必须写全 {x,y,z} 并授权 dig/place，缺 y 直接 BAD_ARGS、缺授权停在半路；报 BLOCKED 就原地挖开续走；explore_toward 要写 dig 才挖墙；go_near 只对身边看得见的容器/门/床/传送门用。';
const ordinaryRule = '下矿前先看装备和背包：护甲耐久 0 就别下深层；镐耐久低于 15% 先换一把并带备用。';

test('只识别带选择词的动作规则，不误伤参数要求或普通经验', () => {
  assert.equal(isMethodChoiceRule(directFortress), true);
  assert.equal(isMethodChoiceRule(shortTrip), true);
  assert.equal(isMethodChoiceRule(parameterRule), false);
  assert.equal(isMethodChoiceRule(ordinaryRule), false);
  assert.equal(isMethodChoiceRule('长距离优先 travel_to，近距才用 explore_toward'), true);
});

test('0 证据的方法选择规则不自动注入 know_how，但仍留在经验库里', () => {
  const self = new SelfModel(null);
  const rule = self.learn(directFortress, { source: 'reflection' });
  assert.ok(rule);
  assert.equal(rule.unverified, true);
  assert.deepEqual(rule.limits, [PROVISIONAL_METHOD_LIMIT]);
  assert.equal(self.relevantKnowHow('travel_to 下界要塞 回已知要塞口 长距离').some((lesson) => lesson.id === rule.id), false);
  assert.ok(self.data.knowHow.some((lesson) => lesson.id === rule.id), '主动 recall 仍能查到原文');
});

test('写明适用边界仍不自动注入，但保留在经验库', () => {
  const self = new SelfModel(null);
  const rule = self.learn(shortTrip, { source: 'reflection', limits: ['只在下界短途往返时'] });
  assert.ok(rule);
  assert.equal(rule.unverified, true);
  assert.equal(needsProvisionalMethodLimit(rule), true);
  assert.equal(self.relevantKnowHow('下界 短途 travel_to explore_toward').some((lesson) => lesson.id === rule.id), false);
  assert.ok(self.data.knowHow.some((lesson) => lesson.id === rule.id), '主动 recall 仍能查到原文');
});

test('已有确认应用的方法选择规则恢复自动注入', () => {
  const self = new SelfModel(null);
  const rule = self.learn(shortTrip, { source: 'reflection' });
  assert.ok(rule);
  assert.equal(needsProvisionalMethodLimit(rule), true);
  rule.applications = [{ at: 1, activityId: 'a_done', outcome: 'done', summary: '按这条走通了' }];
  assert.equal(needsProvisionalMethodLimit(rule), false);
  assert.equal(refreshProvisionalMethodLimit(rule), true);
  assert.equal(rule.limits, undefined, '确认应用后撤掉程序标注');
  assert.ok(self.relevantKnowHow('下界 短途 travel_to explore_toward').some((lesson) => lesson.id === rule.id));
});

test('撤程序标注时保留 Agent 自己写的适用边界', () => {
  const self = new SelfModel(null);
  const rule = self.learn(shortTrip, { source: 'reflection' });
  assert.ok(rule);
  rule.limits = [...(rule.limits ?? []), '只在下界短途往返时'];
  rule.applications = [{ at: 1, activityId: 'a_done', outcome: 'done', summary: '按这条走通了' }];
  refreshProvisionalMethodLimit(rule);
  assert.deepEqual(rule.limits, ['只在下界短途往返时']);
});

test('反思 add/rewrite 的 limits 能解析、落库并阻止程序补标注', () => {
  const self = new SelfModel(null);
  const parsed = parseConsolidation({
    merge: [], rewrite: [], drop: [], agenda_drop: [],
    add: [{ text: directFortress, limits: ['只在露天岩浆海、已记录落脚面缺失、目标 300+ 格时'] }],
  }, new Set(self.data.knowHow.map((lesson) => lesson.id)), new Set());
  assert.deepEqual(parsed.add, [{ text: directFortress, limits: ['只在露天岩浆海、已记录落脚面缺失、目标 300+ 格时'] }]);
  self.consolidate(parsed);
  const added = self.data.knowHow.find((lesson) => lesson.text === directFortress);
  assert.ok(added);
  assert.deepEqual(added.limits, ['只在露天岩浆海、已记录落脚面缺失、目标 300+ 格时']);

  const existing = self.learn('旧的短途做法', { source: 'reflection' });
  assert.ok(existing);
  self.consolidate({ merge: [], rewrite: [{ id: existing.id, text: shortTrip, limits: ['只在下界短途往返时'] }], drop: [], add: [], agendaDrop: [] });
  assert.deepEqual(existing.limits, ['只在下界短途往返时']);
});

test('加载旧存档时幂等补暂定边界', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-lesson-quality-'));
  const file = path.join(dir, 'mind.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    knowHow: [{ id: 'k_legacy', text: directFortress, tags: [], wins: 0, losses: 0, unverified: true, createdAt: 1, updatedAt: 1, source: 'reflection' }],
  }));
  const first = new SelfModel(file);
  assert.deepEqual(first.data.knowHow[0]!.limits, [PROVISIONAL_METHOD_LIMIT]);
  first.close();
  const again = new SelfModel(file);
  try {
    assert.deepEqual(again.data.knowHow[0]!.limits, [PROVISIONAL_METHOD_LIMIT], '重复加载不重复追加');
  } finally {
    again.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
