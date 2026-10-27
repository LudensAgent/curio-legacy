import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { WorldMemory } from '../src/memory/store.ts';
import { homeOf } from '../src/mind/home.ts';
import { sleepSkill } from '../src/skills/build.ts';
import { makeCtx, TestWorld } from './survival-helpers.ts';

const W = '127.0.0.1:25565';
const base = (label: string, x: number, ts: number, primary = false) => ({ id: `base_${label}`, kind: 'base', label, worldId: W, dim: 'overworld', pos: { x, y: 64, z: 0 }, ts, ...(primary ? { primary: true } : {}) });

test('读档时清掉睡觉睡出来的“基地 N”：只留出生点和起了名字的；首选改成最近的有名字的基地', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bed-bases-'));
  const file = path.join(dir, 'world-memory.json');
  fs.writeFileSync(file, JSON.stringify({ version: 3, worldId: W, landmarks: [
    base('基地 7', 70, 7, true), base('基地 6', 60, 6), base('高地白桦小舍', 50, 5), base('基地 3', 30, 3), base('基地 1', 10, 1), base('基地 2', 20, 2),
    { id: 'res_1', kind: 'resource', label: 'iron_ore', worldId: W, dim: 'overworld', pos: { x: 1, y: 2, z: 3 }, ts: Date.now() },
  ] }));
  const m = new WorldMemory(file);
  try {
    assert.deepEqual(m.bases().map((b) => b.label).sort(), ['基地 1', '高地白桦小舍']);
    assert.equal(m.base('overworld')?.label, '高地白桦小舍');
    assert.ok(m.landmarks().some((l) => l.label === 'iron_ore'), '别的地标不动');
  } finally { m.close(); }
});

test('只有一个没名字的基地（出生点）时什么都不动', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bed-bases-'));
  const file = path.join(dir, 'world-memory.json');
  fs.writeFileSync(file, JSON.stringify({ version: 3, worldId: W, landmarks: [base('基地 1', 10, 1, true)] }));
  const m = new WorldMemory(file);
  try { assert.deepEqual(m.bases().map((b) => [b.label, b.primary]), [['基地 1', true]]); } finally { m.close(); }
});

test('睡一觉只记“我的床”，不再新建基地', async () => {
  const w = new TestWorld();
  w.inv.set('white_bed', 1);
  (w as any).sleepInBed = async () => ({ ok: true, bedPos: { x: 5, y: 64, z: 5 } });
  const base0 = w.state.bind(w);
  (w as any).state = () => ({ ...base0(), timeOfDay: 14000, isDay: false });
  const ctx = makeCtx(w);
  try {
    const r = await sleepSkill.run(ctx, { place: true } as any);
    assert.equal(r.status, 'succeeded', r.summary);
    assert.equal(ctx.memory.bases().length, 0);
    assert.ok(ctx.memory.landmarks().some((l) => l.label === '我的床'));
  } finally { ctx.memory.close(); }
});

test('家在哪：有首选基地就是它，不再挑离得最近的那个', () => {
  const m = new WorldMemory(null);
  m.setWorld(W);
  m.setBase('overworld', { x: 300, y: 64, z: 0 }, '高地白桦小舍');
  m.addLandmark('discovery', '小屋', 'overworld', { x: 5, y: 64, z: 0 });
  assert.equal(homeOf(m, { worldId: W, dim: 'overworld', pos: { x: 0, y: 64, z: 0 } })?.label, '高地白桦小舍');
  m.close();
});
