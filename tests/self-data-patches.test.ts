import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SelfModel } from '../src/mind/self.ts';

test('一次性修正活跃 agenda/plan/knowHow 里的错误要塞坐标，保留历史', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-self-patch-'));
  const file = path.join(dir, 'mind.json');
  const wrong = '(219,60,-262)';
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    agenda: [
      { id: 'a1', text: `记住了：下界要塞在下界约 ${wrong} 一带（上次被烈焰人烧死的地点）`, kind: 'goal', horizon: 'today', status: 'open', createdAt: 1, updatedAt: 1, attempts: 0 },
      { id: 'a2', text: `已放弃的要塞 ${wrong}`, kind: 'goal', horizon: 'today', status: 'dropped', createdAt: 1, updatedAt: 1, attempts: 0 },
    ],
    knowHow: [{ id: 'k1', text: `沿实岩去要塞一带 ${wrong}`, createdAt: 1, wins: 1, losses: 0, source: 'observed' }],
    plan: {
      agendaId: 'a1', goal: `去要塞 ${wrong}`, setAt: 1, updatedAt: 1,
      steps: [{ text: `摸清要塞 ${wrong}`, done: false }],
      methods: [{ text: `朝要塞 ${wrong} 推进`, outcome: 0, status: 'active' }],
    },
    diary: [{ at: 1, text: `旧日记：要塞 ${wrong}`, dim: 'the_nether', pos: [219, 60, -262] }],
  }));
  const self = new SelfModel(file);
  try {
    assert.match(self.data.agenda[0]!.text, /\(219,60,-224\)/);
    assert.doesNotMatch(self.data.agenda[0]!.text, /-262|被烈焰人烧死/);
    assert.match(self.data.agenda[1]!.text, /-262/, '已放弃的历史议程不改');
    assert.match(self.data.knowHow[0]!.text, /\(219,60,-224\)/);
    assert.match(self.data.plan!.goal, /\(219,60,-224\)/);
    assert.match(self.data.plan!.steps[0]!.text, /\(219,60,-224\)/);
    assert.match(self.data.plan!.methods![0]!.text, /\(219,60,-224\)/);
    assert.match(self.data.diary[0]!.text, /-262/, '历史日记不改');
    assert.ok(self.data.patches?.includes('fortress-coordinate-20261116'));
  } finally { self.close(); }

  const again = new SelfModel(file);
  try {
    assert.equal(again.data.patches?.filter((p) => p === 'fortress-coordinate-20261116').length, 1);
    assert.match(again.data.agenda[0]!.text, /\(219,60,-224\)/);
  } finally { again.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
