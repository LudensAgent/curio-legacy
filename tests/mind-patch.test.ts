import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { applyMindPatch } from '../src/mind/mind-patch.ts';
import { SelfModel } from '../src/mind/self.ts';

test('startup correction changes only the matched lesson, clears its evidence and is applied once', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-patch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const model = new SelfModel(path.join(dir, 'mind.json'));
  const lesson = model.learn('之前的旧说法', { source: 'observed', signature: 'dig', outcome: 'done' })!;
  model.learn('另一条记录', { source: 'observed' });
  model.close();
  const before = JSON.parse(fs.readFileSync(path.join(dir, 'mind.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'mind-patch.json'), JSON.stringify({ id: lesson.id, expectedText: '之前的旧说法', text: '修正后的说法' }));

  assert.match(applyMindPatch(dir)!, new RegExp(lesson.id));
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'mind.json'), 'utf8'));
  assert.deepEqual(after, { ...before, knowHow: before.knowHow.map((item: typeof lesson) => item.id === lesson.id
    ? { ...item, text: '修正后的说法', wins: 0, losses: 0, unverified: true, signature: undefined }
    : item).map((item: typeof lesson) => JSON.parse(JSON.stringify(item))) });
  assert.equal(applyMindPatch(dir), null);
  assert.ok(fs.readdirSync(dir).some((name) => /^mind-patch\.applied-\d+\.json$/.test(name)));
  const reloaded = new SelfModel(path.join(dir, 'mind.json'));
  assert.equal(reloaded.data.knowHow.find((item) => item.id === lesson.id)?.text, '修正后的说法');
  reloaded.close();
});

test('startup correction leaves the file and pending patch untouched when the original no longer matches', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-patch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'mind.json'), patch = path.join(dir, 'mind-patch.json');
  const original = JSON.stringify({ version: 1, knowHow: [{ id: 'k_1', text: '已改变', wins: 2 }] });
  fs.writeFileSync(file, original);
  fs.writeFileSync(patch, JSON.stringify({ id: 'k_1', expectedText: '旧说法', text: '修正后的说法' }));
  assert.throws(() => applyMindPatch(dir), /原文已改变/);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(fs.existsSync(patch), true);
});
