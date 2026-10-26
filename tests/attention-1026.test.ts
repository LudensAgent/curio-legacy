import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { projectRect, surveyBuildSite } from '../src/building/site.ts';
import { coversFailure } from '../src/codeskills/smith.ts';
import { AudienceChannel } from '../src/live/audience.ts';
import type { LiveMessage } from '../src/live/bilibili.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { myBuilds, describeBuild } from '../src/mind/home.ts';
import { SelfModel } from '../src/mind/self.ts';
import { StrategyLog } from '../src/mind/strategy.ts';
import { parsePlan } from '../src/mind/thinker.ts';
import { buildingArchiveFor, ownFootprints, settleBuild } from '../src/skills/build.ts';
import { normalizeSpec } from '../src/building/spec.ts';

const dm = (uid: string, text: string): LiveMessage => ({ platform: 'bilibili', kind: 'danmaku', uid, user: `用户${uid}`, text, ts: Date.now() });
const cfg = { maxInPrompt: 8, windowSec: 300, blockWords: [], perUserGapSec: 8 };

test('观众劝“房子够了”：只数说够了的弹幕，不够/还差不算；能按人数和条数看共识', () => {
  let now = 1_000_000;
  const a = new AudienceChannel(cfg, undefined, () => now);
  a.ingest(dm('1', '房子够住了别修了'));
  now += 10_000; a.ingest(dm('2', '差不多了去干别的'));
  now += 10_000; a.ingest(dm('3', '还不够，继续补'));
  now += 10_000; a.ingest(dm('4', '去挖矿'));
  let c = a.buildConsensus();
  assert.equal(c.viewers, 2);
  assert.equal(c.messages, 2);
  now += 10_000; a.ingest(dm('5', '可以了可以了'));
  c = a.buildConsensus();
  assert.equal(c.viewers, 3);
  now += 10 * 60_000;
  assert.equal(a.buildConsensus().messages, 0, '五分钟以前的不算');
  a.clearBuildConsensus();
});

function memoryWithHouse() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curio-attn-'));
  const memory = new WorldMemory(path.join(dir, 'world-memory.json'));
  const archive = buildingArchiveFor(memory);
  const spec = normalizeSpec({ name: '小屋', width: 5, depth: 5 } as any);
  const p = archive.design({ worldId: memory.worldId, dimension: 'overworld', origin: { x: 10, y: 64, z: 10 }, rotation: 0, spec, materials: {} });
  archive.inspect(p.id, { at: Date.now(), complete: false, checked: 10, defects: [{ cellId: 'a', pos: { x: 10, y: 65, z: 10 }, kind: 'missing', expected: 'oak_planks', actual: 'air' }], functions: {} });
  return { memory, archive, id: p.id };
}

test('房子可以认定“这样就行了”或“不要了”：收工的算家、复查不再变回没盖完；放弃的不再惦记', () => {
  const { memory, archive, id } = memoryWithHouse();
  const st = { worldId: memory.worldId, dim: 'overworld', pos: { x: 0, y: 64, z: 0 } };
  assert.match(describeBuild(myBuilds(memory, st)[0]), /没盖完/);
  const r = settleBuild(memory, id, 'accept', 'audience', '观众说够了');
  assert.ok(r.ok);
  assert.equal(archive.get(id)!.status, 'complete');
  assert.equal(archive.get(id)!.acceptance!.by, 'audience');
  archive.inspect(id, { at: Date.now(), complete: false, checked: 10, defects: [], functions: {} });
  assert.equal(archive.get(id)!.status, 'complete', '认定过的作品复查后仍算收工');
  assert.match(describeBuild(myBuilds(memory, st)[0]), /收工了，能住/);
  settleBuild(memory, id, 'abandon', 'agent', '不要了');
  assert.equal(myBuilds(memory, st).length, 0, '放弃的不再出现在“我盖过的”里');
  assert.equal(ownFootprints(archive, memory.worldId, 'overworld').length, 1, '但那块地仍算占着');
  memory.close();
});

test('选址避开自己别的工地：同一块地不会再另起一座', () => {
  const rect = projectRect({ x: 0, y: 64, z: 0 }, 0, { width: 5, depth: 5 });
  assert.deepEqual(rect, { minX: 0, maxX: 4, minZ: 0, maxZ: 4 });
  const flat = { state: () => ({ pos: { x: 2, y: 64, z: 2 }, dim: 'overworld' }), blockAt: (p: { y: number }) => p.y < 64 ? 'grass_block' : 'air' } as any;
  const spec = { width: 5, depth: 5, height: 4, layout: 'house' as const };
  const free = surveyBuildSite(flat, null, spec, { radius: 0, rotations: [0], center: { x: 0, y: 64, z: 0 } });
  assert.ok(free.best);
  const blocked = surveyBuildSite(flat, null, spec, { radius: 0, rotations: [0], center: { x: 0, y: 64, z: 0 }, avoid: [rect] });
  assert.equal(blocked.best, null);
  assert.equal(blocked.rejected.occupied, 1);
});

test('清单项可以带 done_when：事实达成就自动勾掉', () => {
  const plan = parsePlan({ focus: '睡上床', steps: [{ text: '做一张床', done_when: { type: 'inventory_min', item: 'white_bed', count: 1 } }, '往东探'] }, (c) => c as any);
  assert.ok(plan?.conditions?.[0]);
  assert.equal(plan?.conditions?.[1], null);
  const self = new SelfModel(null);
  self.setPlan(plan!.focus!, plan!.steps!, plan!.conditions!);
  assert.deepEqual(self.autoCheckPlan(() => true), ['做一张床'], '没写条件的项不自动勾');
  assert.equal(self.plan()!.steps[0].auto, true);
});

test('技能工程师认得某个技能已经管着某种失败', () => {
  assert.ok(coversFailure({ all: [{ hp_below: 5 }, { after_failure: { skill: ['goto'], code: ['PATH_NOT_FOUND'] } }] }, 'goto', 'PATH_NOT_FOUND'));
  assert.ok(coversFailure({ after_failure: { skill: ['goto'] } }, 'goto', 'STUCK'));
  assert.ok(!coversFailure({ after_failure: { skill: ['goto'], code: ['STUCK'] } }, 'goto', 'PATH_NOT_FOUND'));
});

test('策略回顾的事实：夜里在哪过、死在哪，只给事实', () => {
  const log = new StrategyLog();
  log.onTick('day', 10, '砍树', 1);
  log.onTick('night', 150, '往东探', 2);
  log.onEvent({ ts: 3, type: 'death', severity: 'P1', msg: '死亡', data: { message: 'shot by Skeleton' } } as any, { phase: 'night', bedDist: 150, doing: '往东探' });
  log.onTick('day', 150, '往东探', 4);
  const facts = log.facts({ agenda: [], builds: [] }, 5).join('\n');
  assert.match(facts, /睡床 0 次，在外面熬 1 次（那几晚离床最远 150 格），夜里死了 1 次/);
  assert.match(facts, /shot by Skeleton×1/);
});

test('技能目录不列收起的；收起不久的技能后台不同名重写（墓碑）；刚写的不算可靠积木', async () => {
  const { BUILTIN_SKILLS_DIR, SkillBook } = await import('../src/knowledge/skillbook.ts');
  const { BehaviorEngine } = await import('../src/mind/behaviors.ts');
  const { EventBus } = await import('../src/events.ts');
  const { FakeAdapter } = await import('./fake-adapter.ts');
  const noSenses = { perceivedEntities: () => [], knownBlocks: () => [], refresh() {}, markSweep() {} };
  const book = new SkillBook(BUILTIN_SKILLS_DIR, fs.mkdtempSync(path.join(os.tmpdir(), 'curio-tomb-')));
  const engine = new BehaviorEngine(book, new FakeAdapter(), null, new EventBus(), noSenses as any);
  const w0 = engine.write({ name: 'dig-me-out', description: '被困在坑里时挖台阶出去', code: 'return 1;' });
  assert.ok(w0.ok, JSON.stringify(w0));
  assert.ok(engine.retire('dig-me-out', '一次都没用上'));
  assert.ok(engine.inactive('dig-me-out'));
  assert.ok(!book.index((n) => engine.inactive(n)).some((l) => l.startsWith('dig-me-out')), '目录不列收起的');
  const w = engine.write({ name: 'dig-me-out', description: '被困在坑里时挖台阶出去 v2', code: 'return 2;' }, { by: 'forge' });
  assert.ok(!w.ok && (w as any).gated, '收起不久，后台不重写');
  assert.match((w as any).error, /收起/);
  assert.ok(engine.write({ name: 'dig-me-out', description: '被困在坑里时挖台阶出去 v2', code: 'return 2;' }).ok, '心智自己要写可以');
  assert.match(engine.reliable('dig-me-out') ?? '', /不够可靠/);
});

test('时间感：离天黑/天亮几分钟；中午、半夜、天亮各提醒一次；干等比干活无聊得快', async () => {
  const { clockOf } = await import('../src/perception/perception.ts');
  const { Attention } = await import('../src/mind/attention.ts');
  const { relaxMood, DEFAULT_MOOD } = await import('../src/mind/self.ts');
  assert.deepEqual(clockOf(10800), { toDusk: 1, toDawn: null });
  assert.deepEqual(clockOf(17000), { toDusk: null, toDawn: 5 });
  const att = new Attention();
  const p = (tod: number) => ({ time: { timeOfDay: tod, phase: tod < 12000 ? 'day' : tod < 13800 ? 'dusk' : tod < 22200 ? 'night' : 'dawn', day: 2 }, self: { food: 20, hp: 20, inWater: false }, emptySlots: 5, nearby: { hostile: [], resources: [] }, light: null } as any);
  att.fromPercept(p(5900));
  assert.ok(att.fromPercept(p(6100)).some((n) => n.key === 'noon' && /第 3 天/.test(n.what)));
  att.fromPercept(p(17900));
  assert.ok(att.fromPercept(p(18100)).some((n) => n.key === 'midnight' && /离天亮约/.test(n.what)));
  const waited = relaxMood(DEFAULT_MOOD, 120, 'waiting').boredom, worked = relaxMood(DEFAULT_MOOD, 120, true).boredom;
  assert.ok(waited > worked + 0.2, `干等两分钟 ${waited} vs 干活两分钟 ${worked}`);
});
