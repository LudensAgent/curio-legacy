import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { SkillSmith } from '../src/codeskills/smith.ts';
import { EventBus } from '../src/events.ts';
import { BUILTIN_SKILLS_DIR, SkillBook } from '../src/knowledge/skillbook.ts';
import { BehaviorEngine } from '../src/mind/behaviors.ts';
import { describeDist, Ledger, type Episode } from '../src/mind/ledger.ts';
import { recallLocal } from '../src/mind/recall.ts';
import { SelfModel } from '../src/mind/self.ts';
import { FakeAdapter } from './fake-adapter.ts';

const flush = async () => { for (let i = 0; i < 10; i++) await setImmediate(); };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'curio-ledger-'));
const noSenses = { perceivedEntities: () => [], knownBlocks: () => [], refresh() {}, markSweep() {} };
const here = (y: number, biome = 'plains') => ({ pos: { x: 0, y, z: 0 }, biome, dim: 'overworld' });

test('收获账本：不针对哪种东西，按“得到的东西”记每个花多少、在变省还是变费、最省的做法是什么', () => {
  const ledger = new Ledger(null, new EventBus(), () => { throw new Error('不用状态'); });
  let at = 1_000_000;
  // 早先砍树慢，后来换了做法变快
  for (let i = 0; i < 4; i++) ledger.closeEpisode({ what: '找树砍木头', kind: 'gather', signature: 'explore > collect oak_log', outcome: 'done', sec: 240, gained: { oak_log: 4 } }, at += 60_000);
  for (let i = 0; i < 4; i++) ledger.closeEpisode({ what: '去森林边砍', kind: 'gather', signature: 'goto forest > collect oak_log', outcome: 'done', sec: 80, gained: { oak_log: 4 } }, at += 60_000);
  ledger.closeEpisode({ what: '四处看看', kind: 'explore', signature: 'explore', outcome: 'done', sec: 120, gained: {} }, at += 60_000);
  const st = ledger.stats('oak_log')!;
  assert.equal(st.units, 32);
  assert.equal(st.trend, 'better', '早先每个 60 秒，最近 20 秒');
  assert.match(st.best[0].signature, /goto forest/, '最省的做法排前面');
  assert.match(ledger.describe('oak_log'), /在变省.*最省的做法：「去森林边砍」/);
  assert.match(ledger.digest().join('\n'), /什么也没得到/, '白忙的比例也算进去');
});

test('材料的账：木料/矿石各跑了几段活、拿了多少、走了多远、最近平均每趟', () => {
  const ledger = new Ledger(null, new EventBus(), () => { throw new Error('不用状态'); });
  const ep = (at: number, walked: number, gained: Record<string, number>): Episode =>
    ({ at, what: '采集', kind: 'gather', signature: 's', outcome: 'done', sec: 60, actions: 1, failures: 0, walked, hpLost: 0, gained });
  ledger.data.episodes = [
    ep(1_000, 100, { oak_log: 6, stick: 2 }),
    ep(2_000, 200, { birch_log: 8 }),
    ep(3_000, 300, { spruce_wood: 10, dirt: 4 }),
    ep(4_000, 90, { raw_iron: 2, iron_ore: 3 }),
    ep(5_000, 70, { stone: 32 }),
  ];
  const wood = ledger.materialTally('wood');
  assert.equal(wood.trips, 3);
  assert.equal(wood.units, 24, '只数木料这一族，木棍和泥土不算');
  assert.equal(wood.walked, 600);
  assert.equal(wood.recentWalked, 200, '最近 3 段平均');
  assert.equal(wood.lastAt, 3_000);
  const ore = ledger.materialTally('ore');
  assert.equal(ore.trips, 1);
  assert.equal(ore.units, 5);
  assert.equal(ore.walked, 90);
  assert.equal(ore.lastAt, 4_000);
  ledger.data.episodes.push(ep(6_000, 30, { coal_ore: 1 }));
  assert.equal(ledger.materialTally('ore').trips, 2);
  assert.equal(ledger.materialTally('ore').recentWalked, 60, '最近 3 段变两段');
});

test('东西出现在哪：看见的和拿到的按高度、群系记成分布，同一格方块只记一次', () => {
  const bus = new EventBus();
  let blocks = [{ name: 'iron_ore', pos: { x: 3, y: 14, z: 2 } }, { name: 'iron_ore', pos: { x: 4, y: 20, z: 2 } }];
  const adapter = new FakeAdapter();
  const ledger = new Ledger(null, bus, () => adapter.state(), () => ({ blocks, entities: [] }));
  for (let i = 0; i < 6; i++) ledger.tick();
  blocks = [{ name: 'iron_ore', pos: { x: 3, y: 14, z: 2 } }, { name: 'iron_ore', pos: { x: 9, y: 40, z: 1 } }];
  for (let i = 0; i < 3; i++) ledger.tick();
  assert.equal(ledger.data.seen.iron_ore.n, 3, '同一格不重复记');
  for (const y of [-50, -54, -58, -40]) ledger.note('got', 'diamond', 1, here(y, 'dripstone_caves'));
  const d = describeDist(ledger.data.got.diamond);
  assert.match(d, /Y -64~-33（最多在 -56~-49）/);
  assert.match(d, /dripstone_caves 100%/);
  assert.match(ledger.digest().join('\n'), /见过但还没拿过：iron_ore/);
});

test('效率信号：拿某样东西比它自己平时明显费劲或省事才报（和自己的历史比，不是固定阈值）', () => {
  const bus = new EventBus();
  const ledger = new Ledger(null, bus, () => { throw new Error('不用状态'); });
  const signals: any[] = [];
  ledger.onSignal = (s) => signals.push(s);
  let at = 0;
  const ep = (sec: number, n = 3) => ledger.closeEpisode({ what: '挖煤', kind: 'gather', signature: 'collect coal_ore', outcome: 'done', sec, gained: { coal: n } }, at += 60_000);
  for (const sec of [60, 75, 55, 70, 65]) ep(sec);
  assert.equal(signals.length, 0, '平时的起伏不算');
  ep(80);
  assert.equal(signals.length, 0, '稍慢一点也不算');
  ep(600);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].direction, 'slow');
  assert.equal(signals[0].item, 'coal');
  ep(6, 3);
  assert.equal(signals.at(-1).direction, 'fast', '明显省事也报：值得记下这次的做法');
});

test('技能对收获的影响：用它时和不用它时、各版本之间，拿同样东西每个花多少', () => {
  const used: Record<number, string[]> = {};
  const ledger = new Ledger(null, new EventBus(), () => { throw new Error('不用状态'); }, undefined, (from, to) => Object.entries(used).filter(([t]) => +t >= from && +t <= to).flatMap(([, v]) => v));
  let at = 1_000_000;
  const ep = (sec: number, skill?: string) => { at += 600_000; if (skill) used[at - 1000] = [skill]; ledger.closeEpisode({ what: '挖石头', kind: 'gather', signature: 's', outcome: 'done', sec, gained: { cobblestone: 8 } }, at); };
  ep(160); ep(170); ep(80, 'strip-mine@v1'); ep(90, 'strip-mine@v1'); ep(40, 'strip-mine@v2'); ep(48, 'strip-mine@v2');
  const effect = ledger.skillEffect('strip-mine');
  assert.match(effect, /cobblestone 用它时每个 \d+ 现实秒（4 次），不用它时 21 现实秒（2 次）/);
  assert.match(effect, /按版本.*v2 每个 6 现实秒.*v1 每个 11 现实秒|按版本.*v1 每个 11 现实秒.*v2 每个 6 现实秒/);
  assert.equal(ledger.skillEpisodes(), 4);
});

test('想到某样东西就想起它的账：中文的活名也能连到物品（挖铁矿 → raw_iron）', () => {
  const dir = tmp();
  const ledger = new Ledger(null, new EventBus(), () => { throw new Error('不用状态'); });
  ledger.closeEpisode({ what: '下矿洞挖铁矿', kind: 'gather', signature: 'dig_down > collect iron_ore', outcome: 'done', sec: 300, gained: { raw_iron: 5 } });
  ledger.note('got', 'raw_iron', 5, here(10));
  const self = new SelfModel(path.join(dir, 'mind.json'));
  const memory = { lessonsFor: () => [], notesFor: () => [], landmarks: () => [] } as any;
  const found = recallLocal('去挖铁矿做铁镐', { self, memory, ledger });
  const hit = found.find((r) => r.kind === 'ledger');
  assert.ok(hit, '想起了收获账');
  assert.match(hit!.text, /raw_iron：1 段活拿到 5 个，每个约 60 现实秒/);
});

test('效率信号交给造技能的：费劲了对比最省的几次；回顾时整本账一起看', async (t) => {
  const adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(BUILTIN_SKILLS_DIR, tmp());
  const engine = new BehaviorEngine(book, adapter, null, bus, noSenses);
  const asked: string[] = [];
  const planner = { autonomous: true, noteInvalid() {}, complete: async (m: any[]) => { asked.push(m[0].content + '\n' + m[1].content); return { text: '{"none":true,"why":"纯属运气"}', latencyMs: 5 }; } };
  const smith = new SkillSmith(planner as any, engine, book, bus, () => adapter.state(), () => ['挖煤 → done（600s）']);
  const ledger = new Ledger(null, bus, () => adapter.state());
  smith.ledger = ledger;
  ledger.onSignal = (s) => smith.efficiency(s);
  let at = Date.now() - 3600_000;
  for (const sec of [60, 70, 65, 62]) ledger.closeEpisode({ what: '在山洞口挖煤', kind: 'gather', signature: 'goto cave > collect coal_ore', outcome: 'done', sec, gained: { coal: 3 } }, at += 60_000);
  ledger.closeEpisode({ what: '漫山遍野找煤', kind: 'gather', signature: 'explore > explore > collect coal_ore', outcome: 'done', sec: 900, gained: { coal: 3 } }, at += 60_000);
  await flush();
  assert.equal(asked.length, 1);
  assert.match(asked[0], /比自己平时明显费劲/);
  assert.match(asked[0], /最省的做法：「在山洞口挖煤」goto cave/, '带着账里最省的做法去对比');
  assert.match(asked[0], /漫山遍野找煤/, '带着这次的经过');
  // 同一样东西同一方向，十分钟内不重复
  ledger.closeEpisode({ what: '又到处找煤', kind: 'gather', signature: 'explore', outcome: 'done', sec: 950, gained: { coal: 3 } }, at += 60_000);
  await flush();
  assert.equal(asked.length, 1);
  smith.review('天亮了', Date.now() + 6 * 60_000);
  await flush();
  assert.equal(asked.length, 2);
  assert.match(asked[1], /能做成但费劲/);
  assert.match(asked[1], /harvest_ledger/);
  t.after(() => smith.stop());
});

test('整理技能也管升级：账本显示拖慢了的交给改进器，新版本不如旧版的退回', async () => {
  const { SkillCurator } = await import('../src/codeskills/curator.ts');
  const adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(BUILTIN_SKILLS_DIR, tmp());
  const engine = new BehaviorEngine(book, adapter, null, bus, noSenses);
  assert.ok(engine.write({ name: 'strip-mine', description: '按间隔开支道挖', code: 'return 1;', verify: 'const s = await api.state(); return true;' }).ok);
  // 两个版本都跑够几次才谈得上比较（数据太少不退回）
  const run = () => (engine as any).record(engine.get('strip-mine'), true, '挖完了', {});
  for (let i = 0; i < 3; i++) run();
  assert.ok(engine.write({ name: 'strip-mine', description: '按间隔开支道挖', code: 'return 2;', verify: 'const s = await api.state(); return true;' }).ok, '改进器换上 v2');
  for (let i = 0; i < 4; i++) run();
  assert.equal(engine.get('strip-mine')?.version, 2);
  const improved: string[] = [];
  engine.improve = (name, why, note) => { improved.push(`${name}:${why}:${note}`); };
  const used: Record<number, string[]> = {};
  const ledger = new Ledger(null, bus, () => adapter.state(), undefined, (from, to) => Object.entries(used).filter(([t]) => +t >= from && +t <= to).flatMap(([, v]) => v));
  const prompts: string[] = [];
  const planner = { autonomous: true, noteInvalid() {}, complete: async (m: any[]) => { prompts.push(m[1].content); return { text: JSON.stringify({
    rollback: [{ name: 'strip-mine', to: 1, why: 'v2 每个慢一倍' }], improve: [{ name: 'strip-mine', why: '支道太密，走回头路多' }] }), latencyMs: 5 }; } };
  const curator = new SkillCurator(planner as any, engine, book, bus, { gapMs: 0, minSkills: 4 });
  curator.ledger = ledger;
  curator.evidenceStep = 4;
  // 只有一个技能：本来不够整理，但账本里攒够了用过它的经历，值得看效果
  let at = Date.now() - 3600_000;
  for (const [sec, v] of [[40, 1], [45, 1], [90, 2], [95, 2]] as const) { at += 600_000; used[at - 1000] = [`strip-mine@v${v}`]; ledger.closeEpisode({ what: '挖矿', kind: 'gather', signature: 's', outcome: 'done', sec, gained: { cobblestone: 8 } }, at); }
  const r = await curator.check();
  assert.match(prompts[0], /harvest_effect/);
  assert.match(r!, /strip-mine 退回 v1/);
  assert.equal(engine.get('strip-mine')?.code?.trim(), 'return 1;', '换回了 v1 的代码');
  assert.deepEqual(improved, ['strip-mine:slow:支道太密，走回头路多']);
});
