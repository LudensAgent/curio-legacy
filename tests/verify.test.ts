import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { CodeImprover } from '../src/codeskills/improver.ts';
import { EventBus } from '../src/events.ts';
import { SkillBook } from '../src/knowledge/skillbook.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { BehaviorEngine, validateBehavior, VERIFY_REQUIRED } from '../src/mind/behaviors.ts';
import { Vision } from '../src/perception/vision.ts';
import { setBehaviorRegistry } from '../src/skills/use-skill.ts';
import { FakeAdapter } from './fake-adapter.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'curio-verify-'));

function setup(t: any) {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const vision = new Vision(adapter), arbiter = new Arbiter(adapter, memory, bus, vision);
  const engine = new BehaviorEngine(new SkillBook(null, tmp()), adapter, arbiter, bus, vision);
  setBehaviorRegistry(engine);
  t.after(() => { setBehaviorRegistry(null); engine.dispose(); memory.close(); });
  const run = (name: string) => new Promise<TaskOutcome>((resolve, reject) => {
    const done = (outcome: TaskOutcome) => resolve(outcome);
    arbiter.once('done', done);
    const started = arbiter.start({ skill: 'use_skill', args: { name, trial: true } }, 'llm');
    if ('error' in started) { arbiter.off('done', done); reject(new Error(started.error)); }
  });
  return { adapter, bus, engine, run };
}

test('verify：模型写代码技能必须带判定；判定只能看不能动', (t) => {
  const { adapter, engine } = setup(t);
  const no = engine.write({ name: 'exit-boat', description: '下不了船时换个办法', code: 'return {ok:true};' }, { by: 'forge' });
  assert.ok(!no.ok && no.error === VERIFY_REQUIRED);
  const bad = validateBehavior({ name: 'exit-boat', description: '下不了船时换个办法', code: 'return 1;', verify: 'await api.digAt(0,0,0); return true;' }, adapter);
  assert.ok('error' in bad && /判定只能看/.test(bad.error) && /api\.digAt/.test(bad.error), JSON.stringify(bad));
  const yes = engine.write({ name: 'exit-boat', description: '下不了船时换个办法', code: 'return 1;', verify: 'const s = await api.state(); return s.inWater ? "还在水里" : true;' }, { by: 'forge' });
  assert.ok(yes.ok, JSON.stringify(yes));
  assert.match(engine.get('exit-boat', true)?.verify ?? '', /inWater/);
});

test('verify：代码说做完了但判定没通过，算这次没做成、记进失败；判定通过才算成', async (t) => {
  const { adapter, engine, run } = setup(t);
  engine.write({ name: 'swim-out', description: '在水里时游上岸', code: 'return {ok:true, note:"身上没有船，直接重试原动作"};', verify: 'const s = await api.state(); return s.inWater ? "还在水里" : true;' }, { by: 'forge' });
  adapter.inWater = true;
  const wet = await run('swim-out');
  assert.equal(wet.result.status, 'failed');
  assert.match(wet.result.summary, /说做完了，但判定没通过：还在水里/);
  assert.equal(engine.statsOf('swim-out')?.fail, 1);
  adapter.inWater = false;
  const dry = await run('swim-out');
  assert.equal(dry.result.status, 'succeeded', dry.result.summary);
  // 判定对照开工前：before 是开工前的 api.state()
  engine.write({ name: 'step-up', description: '原地垫高一格', code: 'return 1;', verify: 'const s = await api.state(); return s.feet.y > args.before.feet.y ? true : "没垫高";' }, { by: 'forge' });
  const flat = await run('step-up');
  assert.match(flat.result.summary, /判定没通过：没垫高/);
  // 判定自己写错了：说清楚是判定出错
  engine.write({ name: 'broken-check', description: '判定写错了的技能', code: 'return 1;', verify: 'return args.nothing.here;' }, { by: 'forge' });
  const broken = await run('broken-check');
  assert.match(broken.result.summary, /判定代码出错/);
});

test('verify：判定没过的记录交给后台改进，改进器看得到判定，也能连判定一起改', async (t) => {
  const { adapter, bus, engine, run } = setup(t);
  const asked: string[] = [];
  const planner = { autonomous: true, noteInvalid() {}, complete: async (m: any[]) => {
    asked.push(m.at(-1).content);
    return { text: JSON.stringify({ code: 'return 2;', change: '换个办法', verify: 'const s = await api.state(); return s.inWater ? "还在水里（v2）" : true;' }), latencyMs: 5 };
  } };
  const improver = new CodeImprover(planner as any, engine, bus);
  engine.improve = (n, why, note) => { improver.consider(n, why, note); };
  engine.write({ name: 'swim-out', description: '在水里时游上岸', code: 'return 1;', verify: 'const s = await api.state(); return s.inWater ? "还在水里" : true;' }, { by: 'forge' });
  adapter.inWater = true;
  await run('swim-out'); await run('swim-out');
  for (let i = 0; i < 10; i++) await setImmediate();
  assert.equal(asked.length, 1);
  assert.match(asked[0], /现在的判定/);
  assert.match(asked[0], /判定没通过：还在水里/, '改进时看得到判定没过的记录');
  assert.match(engine.get('swim-out', true)?.verify ?? '', /v2/);
});
