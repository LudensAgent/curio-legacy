import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractJson } from '../src/planner/plan.ts';

test('model JSON with a 「key」, a zero-width space or a trailing comma still parses', () => {
  assert.deepEqual(extractJson('{"activity":{"what":"挖"},「say」:"又得换地方"}'), { activity: { what: '挖' }, say: '又得换地方' });
  assert.deepEqual(extractJson('{"a":1,\u200b"next":{"what":"x"}}'), { a: 1, next: { what: 'x' } });
  assert.deepEqual(extractJson('{"steps":[1,2,],"ok":true,}'), { steps: [1, 2], ok: true });
});

test('text that is genuinely broken still fails', () => {
  assert.throws(() => extractJson('{"a": 1 "b": 2}'));
});
