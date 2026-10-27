import assert from 'node:assert/strict';
import { test } from 'node:test';
import { betaSample } from '../src/mind/behaviors.ts';

test('betaSample：成多败少的抽到的机会高，成少败多的低，但都不是 0 或 1', () => {
  const avg = (a: number, b: number) => { let t = 0; for (let i = 0; i < 2000; i++) t += betaSample(a, b); return t / 2000; };
  assert.ok(Math.abs(avg(1, 1) - 0.5) < 0.05);
  assert.ok(avg(30, 4) > 0.8);
  assert.ok(avg(3, 23) < 0.2);
  let low = 0; for (let i = 0; i < 2000; i++) if (betaSample(3, 23) >= 0.2) low++;
  assert.ok(low > 20 && low < 600, `老失败的偶尔还有机会：${low}/2000`);
});
