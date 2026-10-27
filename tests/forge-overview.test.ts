import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BUILTIN_SKILLS_DIR, SkillBook } from '../src/knowledge/skillbook.ts';
import { BehaviorEngine, idleRetirement, tombstoneRelevance } from '../src/mind/behaviors.ts';
import { EventBus } from '../src/events.ts';
import { FakeAdapter } from './fake-adapter.ts';

const noSenses = { perceivedEntities: () => [], knownBlocks: () => [], refresh() {}, markSweep() {} };

function engineWith() {
  const book = new SkillBook(BUILTIN_SKILLS_DIR, fs.mkdtempSync(path.join(os.tmpdir(), 'curio-forgeov-')));
  return new BehaviorEngine(book, new FakeAdapter(), null, new EventBus(), noSenses as any);
}

test('写技能时的一览：在用的全列，墓碑只列和这次沾边的，其余只给个数', () => {
  const engine = engineWith();
  const add = (name: string, description: string, extra: Record<string, unknown> = {}) =>
    assert.ok(engine.write({ name, description, code: 'return 1;', ...extra }).ok, name);
  add('escape-when-buried', '头被砂砾埋住窒息掉血时挖开头顶');
  add('mine-iron-tunnel', '开一条巷道找铁矿');
  add('unstick-goto', '寻路卡住时先挖开挡路的方块', { mode: 'recover', when: { after_failure: { skill: 'goto', code: ['STUCK'] } } });
  for (let i = 0; i < 30; i++) add(`craft-thing-${i}`, `合成第 ${i} 种东西`);
  for (let i = 0; i < 30; i++) assert.ok(engine.retire(`craft-thing-${i}`, `技能太多（40 份），它最少派上用场（成 0 败 0）`));
  assert.ok(engine.retire('escape-when-buried', '用了 8 次只成了 1 次，在添乱'));
  assert.ok(engine.retire('unstick-goto', '合并进 mine-iron-tunnel'));
  add('redo-after-dig', '挖不动时换个角度重来', { mode: 'recover', when: { after_failure: { skill: 'dig_at' } } });
  assert.ok(engine.retire('redo-after-dig', '用了 6 次只成了 1 次，在添乱'));

  const about = '被砂砾埋住了，正在窒息掉血\n[-3s] task_end [llm] goto → failed：STUCK\n[-9s] task_end [llm] dig_at → succeeded';
  const lines = engine.forgeOverview(about, '被砂砾埋住了，正在窒息掉血');
  assert.ok(lines.some((l) => l.startsWith('mine-iron-tunnel')), '在用的全列');
  assert.ok(lines.some((l) => l.startsWith('escape-when-buried') && /已收起/.test(l)), '相关墓碑列出');
  assert.ok(lines.some((l) => l.startsWith('unstick-goto')), '管同一个失败动作的墓碑列出');
  assert.ok(!lines.some((l) => l.startsWith('craft-thing-')), '不沾边的墓碑不列');
  assert.ok(!lines.some((l) => l.startsWith('redo-after-dig')), '管的动作这次只出现、没失败：不算沾边');
  assert.ok(lines.some((l) => /另有 31 份已收起/.test(l)), JSON.stringify(lines));
  assert.ok(engine.forgeOverview('合成第 3 种东西：craft-thing-3').some((l) => l.startsWith('craft-thing-3')), '点名的墓碑列出');
});

test('墓碑最多列几条；只因数量上限收起的过了冷却期标明可以重写', () => {
  const engine = engineWith();
  for (let i = 0; i < 12; i++) {
    assert.ok(engine.write({ name: `dig-stairs-up-${i}`, description: '挖台阶往上走出坑', code: 'return 1;' }).ok);
    assert.ok(engine.retire(`dig-stairs-up-${i}`, '写下 5 小时一次都没用上'));
  }
  const lines = engine.forgeOverview('在坑里，想挖台阶往上走');
  assert.equal(lines.filter((l) => l.startsWith('dig-stairs-up-')).length, BehaviorEngine.FORGE_TOMBSTONES);
  assert.ok(lines.some((l) => /另有 4 份已收起/.test(l)));
  assert.ok(!lines.some((l) => /不是做不好/.test(l)), '刚收起（冷却期内）不说可以重写');
  for (let i = 0; i < 12; i++) (engine as any).stats[`dig-stairs-up-${i}`].retiredAt = Date.now() - BehaviorEngine.TOMBSTONE_MS - 1000 * (i + 1);
  const later = engine.forgeOverview('在坑里，想挖台阶往上走');
  assert.ok(later.some((l) => l.startsWith('dig-stairs-up-0') && /不是做不好/.test(l)), '过了冷却期：说明可以同名重写');
  assert.ok(!later.some((l) => l.startsWith('dig-stairs-up-11')), '同样相关的，先列最近收起的');
});

test('收起原因分类与相关度打分', () => {
  assert.ok(idleRetirement('技能太多（28 份），它最少派上用场（成 6 败 2）'));
  assert.ok(idleRetirement('4 小时没用上'));
  assert.ok(!idleRetirement('合并进 counter-hostile-at-low-hp'));
  assert.ok(!idleRetirement('用了 6 次只成了 1 次，在添乱'));
  const b = { name: 'breathe-first-in-water', description: '在水下氧气快没了先浮上去换气', overrides: ['low-hp-flee'] };
  assert.equal(tombstoneRelevance(b, '在挖铁矿'), 0);
  assert.ok(tombstoneRelevance(b, '在水下氧气快没了，溺水掉血') >= 2);
  assert.ok(tombstoneRelevance(b, 'reflex low-hp-flee') >= 2);
});
