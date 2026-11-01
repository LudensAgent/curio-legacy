import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { EventBus } from '../src/events.ts';
import { SkillBook } from '../src/knowledge/skillbook.ts';
import { BehaviorEngine } from '../src/mind/behaviors.ts';
import { FakeAdapter } from './fake-adapter.ts';

const def = { name: 'toss-verified-behind', description: '扔杂石并核对', body: '扔杂石', code: 'return {dropped:1};', verify: 'const s = await api.state(); return true;' };

function setup(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-broken-'));
  const book = new SkillBook(null, dir);
  const bus = new EventBus();
  const engine = new BehaviorEngine(book, new FakeAdapter(), null, bus, { perceivedEntities: () => [] }, path.join(dir, 'stats.json'));
  t.after(() => { engine.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { book, bus, engine };
}

test('做完的事被自己打破（effect_broken）记成该技能的失败证据；原始动作不误记', (t) => {
  const w = setup(t);
  assert.ok(w.engine.write({ ...def }).ok);
  assert.ok(!w.engine.get(def.name)?.candidate, '不带 by 写的是稳定版');
  // 先记一次成功（verify 通过），再被打破：成败应从 {ok:1,fail:0} 变成 {ok:1,fail:1}
  w.engine.recordInvocation(def.name, { status: 'succeeded', summary: '代码技能做完了', data: { version: 1, verified: true } });
  assert.deepEqual(w.engine.currentStats(def.name), { ok: 1, fail: 0 });
  w.bus.publish('effect_broken', 'P2', '34 秒前 toss-verified-behind「扔掉了 diorite×24」，又捡回来了', { by: def.name, item: 'diorite', count: 24 });
  assert.deepEqual(w.engine.currentStats(def.name), { ok: 1, fail: 1 });
  // 原始动作（toss_item）不在技能书里：effect_broken 不该误记到别的技能上
  w.bus.publish('effect_broken', 'P2', '2 秒前 toss_item「扔掉了 diorite×24」，又捡回来了', { by: 'toss_item', item: 'diorite', count: 24 });
  assert.deepEqual(w.engine.currentStats(def.name), { ok: 1, fail: 1 });
});
