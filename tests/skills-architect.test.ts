import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { critique, designBuilding, logsFor, siteFor } from '../src/building/architect.ts';
import { compileDesign } from '../src/building/design.ts';
import { DraftStore, draftsFor } from '../src/building/drafts.ts';
import { compileBuilding, normalizeSpec } from '../src/building/spec.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { BUILTIN_SKILLS_DIR, SkillBook } from '../src/knowledge/skillbook.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import type { ChatMessage } from '../src/planner/llm.ts';
import { Planner } from '../src/planner/planner.ts';
import { build } from '../src/skills/build.ts';
import { craft } from '../src/skills/work.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'curio-skills-'));
const designsIn = (md: string) => [...md.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)].map((m) => JSON.parse(m[1]));

function scriptedPlanner(replies: string[], seen: ChatMessage[][] = []) {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const cfg = { ...config, llm: { ...config.llm, provider: 'openai' as const, maxCallsPerHour: 1000, maxPromptTokens: 60000, timeoutMs: 60000 } };
  const planner = new Planner(cfg, { name: 'scripted', complete: async (messages) => { seen.push(messages.map((m) => ({ ...m }))); return { text: replies.shift() ?? '{}', latencyMs: 10 }; } }, adapter, memory, bus, null);
  return { planner, adapter, memory, bus };
}

test('技能书：读出内置技能和自己写的技能；索引只放一行用途；不能改内置技能', () => {
  const self = tmp();
  const book = new SkillBook(BUILTIN_SKILLS_DIR, self);
  assert.ok(book.get('architect')?.body.includes('坡屋顶'));
  assert.ok(book.get('homemaking'));
  assert.ok(book.index().some((l) => l.startsWith('architect：')));
  assert.equal(book.write('architect', '我的版本', '随便写点什么，至少二十个字的内容在这里。').ok, false);
  const w = book.write('Hillside Homes', '在山坡上盖房子的做法', '1. 先用圆石把低的一边垫平\n2. 墙基做高一层\n3. 门开在高的一边');
  assert.ok(w.ok && w.skill.name === 'hillside-homes');
  const again = new SkillBook(BUILTIN_SKILLS_DIR, self);
  assert.equal(again.get('hillside-homes')?.source, 'self');
  assert.ok(again.index().some((l) => l.includes('（我自己写的）')));
});

test('设计手册里的参考作品都能直接施工，而且有坡顶/屋檐、柱子、窗户和光', () => {
  const md = fs.readFileSync(path.join(BUILTIN_SKILLS_DIR, 'architect', 'SKILL.md'), 'utf8');
  const designs = designsIn(md);
  assert.ok(designs.length >= 2);
  for (const d of designs) {
    const compiled = compileDesign(d);
    assert.deepEqual(compiled.warnings, []);
    const spec = normalizeSpec({ name: 'ref', design: d });
    assert.ok(compileBuilding(spec).cells.length > 50);
    assert.deepEqual(critique(spec), []);
  }
});

test('图纸格式：台阶自动朝中间往上爬、半砖、栅栏可用；屋檐画在墙脚外面，门开在墙脚上', () => {
  const d = compileDesign({
    legend: { C: 'cobblestone', P: 'oak_planks', D: 'oak_door', F: 'oak_fence', S: 'oak_stairs', s: 'oak_slab[type=top]', T: 'torch', '.': 'air' },
    layers: [
      ['       ', ' CCCCC ', ' CCCCC ', ' CCCCC ', ' CCCCC ', ' CCCCC ', '       '],
      ['       ', ' PPDPP ', ' P...P ', ' P.T.P ', ' P...P ', ' PPFPP ', '       '],
      ['       ', ' PPPPP ', ' P...P ', ' P...P ', ' P...P ', ' PPPPP ', '       '],
      ['SSSSSSS', ' PsssP ', ' PsssP ', ' PsssP ', ' PsssP ', ' PsssP ', 'SSSSSSS'],
    ],
  });
  const at = (x: number, y: number, z: number) => d.components.find((c) => c.pos.x === x && c.pos.y === y && c.pos.z === z);
  assert.equal(at(3, 2, 0)?.properties.facing, 'south', '北边那排台阶朝南（往房子中间）爬');
  assert.equal(at(3, 2, 6)?.properties.facing, 'north');
  assert.equal(at(2, 2, 2)?.properties.type, 'top');
  assert.equal(at(3, 0, 1)?.properties.facing, 'north', '门开在墙脚北边，朝外');
  assert.equal(at(3, 0, 5)?.name, 'oak_fence');
  assert.ok(at(0, 2, 0)!.dependsOn.length, '屋檐挂在墙头上，一格格往外接');
  assert.throws(() => compileDesign({ legend: { C: 'cobblestone', P: 'gravel', '.': 'air' }, layers: [['CCC', 'CCC', 'CCC'], ['P.P', '...', 'PPP'], ['CCC', 'CCC', 'CCC']] }), /会掉落/);
});

test('自查会指出方盒子、单一材料和太小的屋子', () => {
  const box = normalizeSpec({ name: 'box', design: { legend: { P: 'oak_planks', D: 'oak_door', '.': 'air' }, layers: [['PPP', 'PPP', 'PPP'], ['PDP', 'P.P', 'PPP'], ['PPP', 'P.P', 'PPP'], ['PPP', 'PPP', 'PPP']] } });
  const issues = critique(box);
  assert.ok(issues.some((i) => /放不下/.test(i)));
  assert.ok(issues.some((i) => /一种材料|只用了/.test(i)));
  assert.ok(issues.some((i) => /窗户/.test(i)));
});

test('自查会指出悬空的屋顶；缺的木料会折成原木数', () => {
  const layers = [
    ['       ', ' CCCCC ', ' CCCCC ', ' CCCCC ', ' CCCCC ', ' CCCCC ', '       '],
    ['       ', ' PPDPP ', ' G...G ', ' P.T.P ', ' G...G ', ' PPPPP ', '       '],
    ['       ', ' PPPPP ', ' P...P ', ' P...P ', ' P...P ', ' PPPPP ', '       '],
    ['       ', '       ', '       ', '   S   ', '       ', '       ', '       '],
  ];
  const floating = normalizeSpec({ name: 'f', design: { legend: { C: 'cobblestone', P: 'oak_planks', G: 'glass_pane', D: 'oak_door', T: 'torch', S: 'oak_stairs', '.': 'air' }, layers } });
  assert.ok(critique(floating).some((i) => /悬在半空/.test(i)));
  assert.equal(logsFor([['oak_planks', 8], ['oak_stairs', 8], ['cobblestone', 30]]), 5);
});

test('建筑师子代理：独立上下文带设计手册，自查后改进，交回图纸；build 只要 draft ID', async () => {
  const md = fs.readFileSync(path.join(BUILTIN_SKILLS_DIR, 'architect', 'SKILL.md'), 'utf8');
  const [cottage] = designsIn(md);
  const box = { legend: { P: 'oak_planks', D: 'oak_door', '.': 'air' }, layers: [['PPP', 'PPP', 'PPP'], ['PDP', 'P.P', 'PPP'], ['PPP', 'PPP', 'PPP']] };
  const seen: ChatMessage[][] = [];
  const { planner, adapter } = scriptedPlanner([
    JSON.stringify({ name: '小盒子', purpose: '住处', design: box }),
    JSON.stringify({ name: '林间小屋', purpose: '住处', style: '云杉木配深色橡木坡顶', design: cottage, notes: '先打墙基' }),
  ], seen);
  const drafts = new DraftStore(null);
  const book = new SkillBook(BUILTIN_SKILLS_DIR, null);
  const res = await designBuilding(planner, book, drafts, adapter, { brief: '湖边一个能住的小家', persona: '你叫 Curio。', inventory: [{ name: 'spruce_planks', count: 20 }], nearby: ['spruce_log'], likes: ['湖边'], pastWorks: [] }, new AbortController().signal);
  assert.ok(res.ok, !res.ok ? res.error : '');
  if (!res.ok) return;
  assert.match(seen[0][0].content, /设计手册/);
  assert.match(seen[1].at(-1)!.content, /自查发现/);
  assert.equal(res.draft.name, '林间小屋');
  assert.match(res.summary, new RegExp(res.draft.id));
  assert.match(res.summary, /还缺/);
  const memory = new WorldMemory(null);
  const store = draftsFor(memory);
  const saved = store.add({ ...res.draft });
  const v = build.validate({ draft: saved.id }, adapter);
  assert.ok(v.ok, !v.ok ? v.error : '');
  assert.equal(v.ok && v.args.spec?.name, '林间小屋');
  assert.equal(build.validate({ draft: 'dr_nope' }, adapter).ok, false);
  memory.close();
});

test('树冠下抬头看见树叶：人在地表，不算在地下', () => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  adapter.light = 3; // 茂密树冠下天光很弱
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) adapter.blocks.push({ name: 'oak_leaves', pos: { x: dx, y: 68, z: dz } });
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const p = perception.update();
  assert.equal(p.self.overhead?.covered, 'canopy');
  assert.equal(p.self.overhead?.block, 'oak_leaves');
  assert.equal(p.light?.underground, false);
  memory.close();
});

test('野外临时放的工作台用完收回背包；家附近的留着', async (t) => {
  const adapter = new FakeAdapter();
  const ctx = makeCtx(adapter);
  t.after(() => ctx.memory.close());
  const tablePos = { x: 2, y: 64, z: 0 };
  t.mock.method(adapter, 'craft', async (item: string, count: number) => {
    adapter.blocks.push({ name: 'crafting_table', pos: tablePos });
    adapter.inv.set(item, (adapter.inv.get(item) ?? 0) + count);
    return { ok: true, crafted: count, tablePos };
  });
  const r = await craft.run(ctx, { item: 'wooden_pickaxe', count: 1 });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.match(r.summary, /收回背包/);
  assert.equal(adapter.inv.get('crafting_table'), 1);
  ctx.memory.addLandmark('base', '基地', 'overworld', { x: 0, y: 64, z: 0 }, 4);
  adapter.inv.set('crafting_table', 0);
  const r2 = await craft.run(ctx, { item: 'wooden_pickaxe', count: 1 });
  assert.doesNotMatch(r2.summary, /收回/);
  assert.equal(adapter.blockAt(tablePos), 'crafting_table');
});

test('建筑师按地形挑的位置换算成施工 origin：房子中心落在选的格子上，地面高度取草图', () => {
  const radius = 2;
  const heights: (number | 'water' | null)[][] = [[0, 0, 0, 0, 0], [0, 0, 0, 1, 1], [0, 0, 0, 1, 1], ['water', 0, 0, 1, 1], [null, 0, 0, 0, 0]];
  const terrain = { center: { x: 100, y: 64, z: 200 }, radius, heights, trees: heights.map((r) => r.map(() => false)), rows: [], summary: '' };
  const site = siteFor({ x: 1, z: 0, why: '高一点' }, terrain, [0, 4], [0, 4], { width: 5, depth: 5 });
  assert.deepEqual(site?.origin, { x: 99, y: 66, z: 198 });
  assert.equal(siteFor({ x: -2, z: 1 }, terrain, [0, 4], [0, 4], { width: 5, depth: 5 }), null, '水面上不行');
  assert.equal(siteFor({ x: 9, z: 0 }, terrain, [0, 4], [0, 4], { width: 5, depth: 5 }), null, '草图外不行');
});

test('地形草图：东边高起一块、南边有水，行北到南、列西到东', async () => {
  const { FakeAdapter } = await import('./fake-adapter.ts');
  const { terrainSketch } = await import('../src/building/site.ts');
  const a = new FakeAdapter();
  for (let z = -2; z <= 2; z++) for (const y of [64, 65]) a.blocks.push({ name: 'dirt', pos: { x: 2, y, z } });
  for (let x = -2; x <= 2; x++) a.blocks.push({ name: 'water', pos: { x, y: 63, z: 2 } });
  const t = terrainSketch(a, 2);
  assert.equal(t.center.y, 63);
  assert.equal(t.heights[2][4], 2, '正东那列高 2 格');
  assert.equal(t.heights[4][0], 'water', '南边一行是水');
  assert.equal(t.rows[2].split(' ')[4], '+2');
  assert.match(t.summary, /东高西低/);
  assert.match(t.summary, /南边有水/);
});
