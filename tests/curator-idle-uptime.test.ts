import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SkillCurator } from '../src/codeskills/curator.ts';
import { EventBus } from '../src/events.ts';
import type { SkillBook } from '../src/knowledge/skillbook.ts';
import type { BehaviorEngine, BehaviorStats } from '../src/mind/behaviors.ts';

test('unused skills get a full running observation window after an offline gap', (t) => {
  const started = 1_700_000_000_000, hour = 3_600_000;
  t.mock.method(Date, 'now', () => started);
  const skills = ['old-skill', 'used-skill', 'restored-skill'].map((name) => ({ name, source: 'self', mode: 'manual' }));
  const stats: Record<string, BehaviorStats> = Object.fromEntries(skills.map(({ name }) => [name,
    { fired: 0, ok: 0, fail: 0, lastAt: started - 8 * hour }]));
  const retired: string[] = [], reasons: string[] = [];
  const engine = {
    list: (trial = false) => trial ? [] : skills,
    enabled: (skill: { name: string }) => !retired.includes(skill.name),
    statsOf: (name: string) => stats[name],
    retire: (name: string, why: string) => { retired.push(name); reasons.push(why); stats[name].retired = why; return true; },
  } as unknown as BehaviorEngine;
  const book = { get: () => ({ updatedAt: started - 8 * hour }) } as unknown as SkillBook;
  const planner = { autonomous: false, noteInvalid() {}, async complete() { return { text: '{}', latencyMs: 0 }; } };
  const curator = new SkillCurator(planner, engine, book, new EventBus());

  assert.deepEqual(curator.retireUnused(started + 10 * 60_000), [], 'offline time does not immediately retire the skills');
  stats['restored-skill'].restoredAt = started + hour;
  stats['used-skill'].lastUsedAt = started + 2 * hour;
  assert.deepEqual(curator.retireUnused(started + 3 * hour - 1), []);
  assert.deepEqual(curator.retireUnused(started + 3 * hour), ['old-skill'], 'an unused skill can still retire after three running hours');
  assert.match(reasons[0], /本次运行观察 3 小时/);
  assert.deepEqual(curator.retireUnused(started + 4 * hour - 1), []);
  assert.deepEqual(curator.retireUnused(started + 4 * hour), ['restored-skill'], 'restoration starts a new observation window');
  assert.deepEqual(curator.retireUnused(started + 5 * hour - 1), [], 'actual use resets the idle window');
  assert.deepEqual(curator.retireUnused(started + 5 * hour), ['used-skill']);
});

test('a restored skill receives the existing one-hour grace period before value-based retirement', (t) => {
  const restored = 1_700_000_000_000, hour = 3_600_000;
  t.mock.method(Date, 'now', () => restored);
  for (const reason of ['failures', 'capacity'] as const) {
    const skill = { name: 'restored-skill', source: 'self', mode: 'manual' };
    const stats: BehaviorStats = { fired: 7, ok: 0, fail: reason === 'failures' ? 7 : 0, lastAt: restored - 8 * hour, restoredAt: restored };
    let retired = false;
    const engine = {
      list: (trial = false) => trial ? [] : [skill],
      enabled: () => !retired,
      statsOf: () => stats,
      currentStats: () => stats,
      retire: () => { retired = true; stats.retired = reason; return true; },
    } as unknown as BehaviorEngine;
    const book = { get: () => ({ updatedAt: restored - 8 * hour }) } as unknown as SkillBook;
    const planner = { autonomous: false, noteInvalid() {}, async complete() { return { text: '{}', latencyMs: 0 }; } };
    const curator = new SkillCurator(planner, engine, book, new EventBus(), { maxActive: reason === 'capacity' ? 0 : 24 });

    assert.deepEqual(curator.retireLowValue(restored + hour - 1), [], `${reason} must not immediately undo restoration`);
    assert.deepEqual(curator.retireLowValue(restored + hour), ['restored-skill'], `${reason} can still apply after the grace period`);
  }
});
