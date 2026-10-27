import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearSelfEffects, remainingEffects } from '../src/adapter/mineflayer.ts';

test('状态效果的剩余时间往下数，到点没收到结束包也当作结束', () => {
  const t0 = 1_000_000;
  const effects: Record<string, any> = { 19: { id: 19, amplifier: 0, duration: 600 }, 2: { id: 2, amplifier: 0, duration: 1800 } }; // 中毒 30 秒、缓慢 90 秒
  const seen = new Map<number, number>();
  assert.deepEqual(remainingEffects(effects, seen, t0).map((x) => [x.e.id, x.seconds]), [[2, 90], [19, 30]]);
  assert.deepEqual(remainingEffects(effects, seen, t0 + 20_000).map((x) => [x.e.id, x.seconds]), [[2, 70], [19, 10]]);
  // 中毒 30 秒早过了、结束包没来：当作结束，并从身上去掉
  assert.deepEqual(remainingEffects(effects, seen, t0 + 40_000).map((x) => [x.e.id, x.seconds]), [[2, 50]]);
  assert.ok(!effects[19]);
  // 无限时长的不往下数
  const inf: Record<string, any> = { 16: { id: 16, amplifier: 0, duration: -1 } };
  assert.equal(remainingEffects(inf, new Map(), t0 + 1e9).length, 1);
});

test('死亡清掉身上的效果', () => {
  const bot = { entity: { effects: { 19: { id: 19, duration: 600 }, 2: { id: 2, duration: 1800 } } } };
  const seen = new Map([[19, 1], [2, 1]]);
  clearSelfEffects(bot, seen);
  assert.deepEqual(bot.entity.effects, {});
  assert.equal(seen.size, 0);
});
