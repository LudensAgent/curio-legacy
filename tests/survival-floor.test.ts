import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Arbiter } from '../src/arbiter/arbiter.ts';
import { Reflex } from '../src/brain/reflex.ts';
import { SkillCurator } from '../src/codeskills/curator.ts';
import { EventBus } from '../src/events.ts';
import { BUILTIN_SKILLS_DIR, SkillBook } from '../src/knowledge/skillbook.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { BehaviorEngine, INSTINCTS, instinctNote, isEmergency, setInstinctSource } from '../src/mind/behaviors.ts';
import { Vision } from '../src/perception/vision.ts';
import { FakeAdapter } from './fake-adapter.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'curio-floor-'));
const noSenses = { perceivedEntities: () => [], knownBlocks: () => [], refresh() {}, markSweep() {} };

test('本能如实：技能模式下躲苦力怕、低血逃、还手代码里没开，说明里写清楚；概览里“代替本能”标出本来就没开', () => {
  const adapter = new FakeAdapter(), bus = new EventBus(), memory = new WorldMemory(null);
  const arbiter = new Arbiter(adapter, memory, bus, new Vision(adapter));
  const reflex = new Reflex(adapter, arbiter, bus, noSenses as any, { routineCare: false, instincts: 'skills' });
  const on = reflex.activeInstincts();
  assert.ok(!on.includes('lava') && !on.includes('drowning') && !on.includes('eat'));
  assert.ok(!on.includes('creeper') && !on.includes('low-hp-flee') && !on.includes('fight-back'));
  setInstinctSource(() => reflex.activeInstincts());
  const note = instinctNote();
  assert.match(note, /没开、身体不会自己做的：[^。]*creeper/);
  assert.match(note, /drowning（水里快没气时的反应）/);
  assert.ok(INSTINCTS.drowning.off);
  assert.ok(INSTINCTS['low-hp-flee'].off);
  assert.ok(INSTINCTS.lava.off);
  const book = new SkillBook(BUILTIN_SKILLS_DIR, tmp());
  const engine = new BehaviorEngine(book, adapter, null, bus, noSenses as any);
  assert.ok(engine.write({ name: 'run-from-mobs', description: '血少有怪就跑', when: { hp_below: 6, hostile: { within: 10 } }, overrides: ['low-hp-flee'], code: 'return 1;' }).ok);
  assert.match(engine.overview().find((l) => l.startsWith('run-from-mobs'))!, /low-hp-flee（这条本能本来就没开）/);
  const legacy = new Reflex(adapter, arbiter, bus, noSenses as any, { routineCare: true, instincts: 'builtin' });
  setInstinctSource(() => legacy.activeInstincts());
  assert.equal(INSTINCTS['low-hp-flee'].off, undefined, '旧模式开着');
  setInstinctSource(() => reflex.activeInstincts());
});

test('成功过的稳定应急技能不因闲置或容量收起，一再失败仍能收起', async () => {
  const adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(BUILTIN_SKILLS_DIR, tmp());
  const engine = new BehaviorEngine(book, adapter, null, bus, noSenses as any);
  const w = (name: string, b: Record<string, unknown>) => { const r = engine.write({ name, description: `遇到情况时做 ${name} 这件事`, code: 'return 1;', ...b }); assert.ok(r.ok, JSON.stringify(r)); };
  w('dig-out-when-buried', { when: { in_wall: true, hurt_within: 3 } });
  w('swim-up-for-air', { when: { oxygen_below: 6 } });
  w('flee-creeper', { when: { hostile: { name: ['creeper'], within: 5 } }, overrides: ['creeper'] });
  w('eat-when-hungry', { description: '饿了先吃背包里的面包', when: { food_below: 8 } });
  for (let i = 0; i < 5; i++) w(`tool-${i}`, {});
  assert.ok(isEmergency(engine.get('dig-out-when-buried')!) && isEmergency(engine.get('flee-creeper')!));
  assert.ok(!isEmergency(engine.get('eat-when-hungry')!) && !isEmergency(engine.get('tool-0')!));
  for (const name of ['dig-out-when-buried', 'swim-up-for-air', 'flee-creeper'])
    engine.recordInvocation(name, { status: 'succeeded', summary: '实际成功避开危险', data: { version: 1, verified: true } });
  const curator = new SkillCurator({ autonomous: false } as any, engine, book, bus, { unusedDays: 1, maxActive: 3 });
  curator.observe({ ...adapter.state(), worldAgeTicks: 0 }, false, 0);
  curator.observe({ ...adapter.state(), worldAgeTicks: 24_000 }, false, 1000);
  const later = Date.now() + 5 * 3600_000;
  const unused = curator.retireUnused(later);
  assert.ok(unused.includes('eat-when-hungry'));
  assert.ok(!unused.some((n) => ['dig-out-when-buried', 'swim-up-for-air', 'flee-creeper'].includes(n)), JSON.stringify(unused));
  curator.retireLowValue(later);
  for (const n of ['dig-out-when-buried', 'swim-up-for-air', 'flee-creeper']) assert.equal(engine.statsOf(n)?.retired, undefined, `${n} 不因技能太多被挤掉`);
  Object.assign(engine.statsOf('swim-up-for-air') ?? {}, { ok: 1, fail: 7, fired: 8, byVersion: { '1': { ok: 1, fail: 7 } } });
  assert.ok(curator.retireLowValue(later).includes('swim-up-for-air'), '一再失败照样收');
  assert.match(curator.messages()[1].content, /"lifesaver":true/);
});
