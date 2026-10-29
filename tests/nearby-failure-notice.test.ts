import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Attention } from '../src/mind/attention.ts';
import type { ActivityEnd } from '../src/mind/types.ts';

const here = { x: 0, y: 64, z: 0 };
const now = 1_700_000_000_000;
const failure = (i: number, patch: Partial<ActivityEnd> = {}): ActivityEnd => ({
  pos: { ...here }, outcome: 'stuck', skill: 'step', failureCode: 'PATH_NOT_FOUND',
  what: `迈上台阶 ${i}`, summary: `目标脚下是 air（尝试 ${i}）`, at: now + i * 1000, ...patch,
});

test('同一失败码的不同技能不会拼成三次重复失败', () => {
  const attention = new Attention();
  const records = [failure(1), failure(2, { skill: 'goto' }), failure(3, { skill: 'dig' })];
  assert.equal(attention.fromLoop(records, here, now + 3000), null);
  records.push(failure(4));
  assert.equal(attention.fromLoop(records, here, now + 4000), null);
  records.push(failure(5));
  const notice = attention.fromLoop(records, here, now + 5000);
  assert.ok(notice);
  assert.match(notice.what, /step/);
  assert.doesNotMatch(notice.what, /goto|dig/);
});

test('中途完成活动会截断旧失败累计并撤掉待处理提醒', () => {
  const attention = new Attention();
  const records = [failure(1), failure(2), failure(3)];
  assert.ok(attention.fromLoop(records, here, now + 3000));
  assert.ok(attention.peek().some((n) => n.key.startsWith('loop:')));
  records.push(failure(4, { outcome: 'done', summary: '已走上台阶' }));
  assert.equal(attention.fromLoop(records, here, now + 4000), null);
  assert.ok(attention.peek().every((n) => !n.key.startsWith('loop:')));
  records.push(failure(5), failure(6));
  assert.equal(attention.fromLoop(records, here, now + 6000), null);
  records.push(failure(7));
  assert.ok(attention.fromLoop(records, here, now + 7000));
});

test('首轮提醒之前的完成活动同样截断失败累计', () => {
  const attention = new Attention();
  const records = [failure(1), failure(2), failure(3, { outcome: 'done', summary: '已到达' }), failure(4)];
  assert.equal(attention.fromLoop(records, here, now + 4000), null);
  records.push(failure(5));
  assert.equal(attention.fromLoop(records, here, now + 5000), null);
  records.push(failure(6));
  assert.ok(attention.fromLoop(records, here, now + 6000));
});

for (const excluded of [
  { at: now - 10 * 60_000 - 1 },
  { at: now + 20_000 },
  { pos: { ...here, x: 9 } },
] satisfies Partial<ActivityEnd>[]) test(`过期、未来或远处的失败不参与当前批次：${JSON.stringify(excluded)}`, () => {
  const attention = new Attention();
  const records = [failure(1, excluded), failure(2), failure(3)];
  assert.equal(attention.fromLoop(records, here, now + 3000), null);
});
