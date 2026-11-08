import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Vec3Like } from '../src/adapter/types.ts';
import { similarSkills, SkillCurator } from '../src/codeskills/curator.ts';
import { EventBus } from '../src/events.ts';
import { BUILTIN_SKILLS_DIR, SkillBook } from '../src/knowledge/skillbook.ts';
import { BehaviorEngine } from '../src/mind/behaviors.ts';
import { mineCell } from '../src/skills/movement/primitives.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx, TestWorld } from './survival-helpers.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'curio-1026-'));
const noSenses = { perceivedEntities: () => [], knownBlocks: () => [], refresh() {}, markSweep() {} };

class LostDropWorld extends TestWorld {
  constructor() { super(); this.pos = { x: 0.5, y: 64, z: 0.5 }; }
  override async moveTo() { /* 原地够得着 */ }
  override async dig(pos: Vec3Like) { this.setBlock(pos, 'air'); return { ok: true }; }
  override async collectNearbyDrops() { return 0; }
}

test('拆了床：mine_cell 只报已挖掉、掉落物未进背包；记忆里的“我的床”跟着忘掉', async (t) => {
  const w = new LostDropWorld(), ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  ctx.memory.setWorld(w.worldId);
  const bed = { x: 2, y: 64, z: 0 };
  w.setBlock(bed, 'white_bed');
  ctx.memory.addLandmark('discovery', '我的床', 'overworld', bed, 2);
  w.setBlock({ x: 7, y: 63, z: 3 }, 'water');
  w.entities = [{ id: 9, name: 'item:white_bed', kind: 'item', pos: { x: 7.4, y: 63.2, z: 3.6 }, dist: 7, count: 1 } as any];
  const r = await mineCell.run(ctx, { at: [1, 0, -2], facing: 'E', xyz: { x: 2, y: 64, z: 0 }, own: true, allowUnknownAdjacent: true } as any);
  assert.equal(r.status, 'succeeded', r.summary);
  assert.match(r.summary, /挖掉了 \[1,0,-2\] 的 white_bed/);
  assert.equal(r.data?.inBag, false, '掉落物没进背包时如实说没拿到');
  assert.match(r.summary, /掉在地上，还没进背包/);
  assert.ok(!ctx.memory.landmarks().some((l) => l.label === '我的床'), '拆掉的床不再记成“我的床”');
});

test('整理技能：接同一种失败的、名字相近的标成相似交给整理；屡用屡败的、技能太多时最没用的直接收起', () => {
  const pairs = similarSkills([
    { name: 'night-shelter-pit', description: '天黑挖坑过夜' },
    { name: 'night-shelter-and-pit-escape', description: '夜里挖坑躲着' },
    { name: 'fix-build-a', description: '盖房出错时先挪位置', when: { after_failure: { skill: ['build'], code: ['ERROR'] } } },
    { name: 'patch-holes', description: '补洞', when: { after_failure: { skill: 'build', code: ['ERROR', 'STUCK'] } } },
    { name: 'goto-other', description: '找路失败', when: { after_failure: { skill: ['goto'], code: ['PATH_NOT_FOUND'] } } },
    { name: 'build-path', description: '盖房找不到路', when: { after_failure: { skill: ['build'], code: ['PATH_NOT_FOUND'] } } },
  ]).map(([a, b]) => `${a}|${b}`);
  assert.ok(pairs.includes('night-shelter-pit|night-shelter-and-pit-escape'));
  assert.ok(pairs.includes('fix-build-a|patch-holes'), '同样接 build ERROR');
  assert.ok(!pairs.some((p) => p.includes('build-path') && p.includes('fix-build-a')), '失败码不同不算');

  const adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(BUILTIN_SKILLS_DIR, tmp());
  const engine = new BehaviorEngine(book, adapter, null, bus, noSenses);
  for (let i = 0; i < 6; i++) assert.ok(engine.write({ name: `s${i}`, description: `技能 ${i}`, code: 'return 1;' }).ok);
  const curator = new SkillCurator({ autonomous: false } as any, engine, book, bus, { maxActive: 4, unusedDays: 1e6 });
  const st = (n: string) => engine.statsOf(n) as any;
  // s0 屡用屡败；s1、s2 有用；s3 用过成过；s4、s5 从没派上用场
  for (const [n, ok, fail] of [['s0', 1, 8], ['s1', 5, 0], ['s2', 3, 1], ['s3', 1, 0]] as const) { const x = st(n) ?? {}; Object.assign(x, { ok, fail, fired: ok + fail }); }
  for (const n of ['s0', 's1', 's2', 's3']) if (!st(n)) assert.fail(`没有 ${n} 的统计`);
  const later = Date.now() + 2 * 3600_000;
  curator.observe({ ...adapter.state(), worldAgeTicks: 0 }, false, 0);
  curator.observe({ ...adapter.state(), worldAgeTicks: 12_000 }, false, 1000);
  const out = curator.retireLowValue(later);
  assert.ok(out.includes('s0'), '屡用屡败的收起');
  assert.equal(engine.list().filter((b) => b.source === 'self' && !st(b.name)?.retired).length, 4, '收到上限');
  assert.ok(out.includes('s4') || out.includes('s5'));
  assert.ok(!out.includes('s1') && !out.includes('s2'), '有用的留着');
  // 刚写的不动
  const w6 = engine.write({ name: 's6', description: '技能 6', code: 'return 1;' });
  assert.ok(w6.ok, JSON.stringify(w6));
  assert.ok(!curator.retireLowValue(Date.now()).includes('s6'));
});

test('缺料时不拆自家房子当原料：dig_at / dig 拒绝并说清楚为什么；collect 跳过房子上的方块；真要拆写 own', async (t) => {
  const { buildingArchiveFor, ownBuildingAt } = await import('../src/skills/build.ts');
  const { compileBuilding, DEFAULT_SPEC, materialCost, rotatePosition } = await import('../src/building/spec.ts');
  const { mineCell } = await import('../src/skills/movement/primitives.ts');
  const w = new LostDropWorld();
  const { semanticMemory } = await import('./semantic-fixture.ts');
  const { memory } = semanticMemory(w.worldId, path.join(tmp(), 'world-memory.json'));
  const ctx = makeCtx(w, { memory });
  t.after(() => ctx.memory.close());
  ctx.memory.setWorld(w.worldId);
  const s = w.state();
  const origin = { x: 3, y: 64, z: -2 };
  const bp = compileBuilding(DEFAULT_SPEC);
  buildingArchiveFor(ctx.memory).design({ worldId: s.worldId, dimension: s.dim, origin, rotation: 0, spec: DEFAULT_SPEC, materials: materialCost(bp.cells), reason: 't' });
  const wall = bp.cells.find((c) => c.pos.y === 1 && c.name && !/air|door|glass/.test(c.name))!;
  const pos = rotatePosition(wall.pos, origin, 0);
  w.setBlock(pos, wall.name);
  assert.ok(ownBuildingAt(ctx.memory, s, pos, wall.name));
  assert.equal(ownBuildingAt(ctx.memory, s, pos, 'sand'), null, '换成了别的方块就不算');
  w.pos = { x: pos.x + 0.5, y: pos.y - 1, z: pos.z + 1.5 }; // 站在墙南边一格，面朝北
  const v = mineCell.validate({ at: [1, 1, 0], facing: 'N', allowUnknownAdjacent: true }, w) as any;
  const r = await mineCell.run(ctx, v.args);
  assert.equal(r.status, 'failed');
  assert.match(r.summary, /自己盖的.*拆东墙补西墙/);
  assert.equal(w.blockAt(pos), wall.name, '没拆');
  const forced = await mineCell.run(ctx, (mineCell.validate({ at: [1, 1, 0], facing: 'N', own: true, allowUnknownAdjacent: true }, w) as any).args);
  assert.equal(forced.status, 'succeeded', forced.summary);
});

test('技能互相拆台：一个放的块被另一个挖掉，两边都记下，整理时看得到', async () => {
  const { claimEdits, noteEdit, resetEdits } = await import('../src/mind/edits.ts');
  resetEdits();
  const t0 = Date.now();
  noteEdit('t1', 'place', { x: 1, y: 64, z: 1 }, t0);
  noteEdit('t1', 'place', { x: 1, y: 65, z: 1 }, t0);
  assert.deepEqual(claimEdits('t1', 'pillar-up'), []);
  noteEdit('t2', 'dig', { x: 1, y: 64, z: 1.4 }, t0 + 1000);
  noteEdit('t2', 'dig', { x: 1, y: 65, z: 1 }, t0 + 1100);
  noteEdit('t2', 'dig', { x: 9, y: 65, z: 1 }, t0 + 1200);
  assert.deepEqual(claimEdits('t2', 'dig-down'), [{ skill: 'pillar-up', cells: 2 }]);
  // 同一个技能自己挖自己放的不算
  noteEdit('t3', 'place', { x: 9, y: 65, z: 1 }, t0 + 2000);
  assert.deepEqual(claimEdits('t3', 'dig-down'), []);

  const adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(BUILTIN_SKILLS_DIR, tmp());
  const engine = new BehaviorEngine(book, adapter, null, bus, noSenses);
  for (const n of ['pillar-up', 'dig-down']) assert.ok(engine.write({ name: n, description: `技能 ${n}`, code: 'return 1;' }).ok);
  resetEdits();
  noteEdit('a', 'place', { x: 0, y: 70, z: 0 });
  (engine as any).noteUndo('pillar-up', 'a');
  noteEdit('b', 'dig', { x: 0, y: 70, z: 0 });
  (engine as any).noteUndo('dig-down', 'b');
  assert.deepEqual(engine.statsOf('dig-down')?.undid, { 'pillar-up': 1 });
  assert.deepEqual(engine.statsOf('pillar-up')?.undoneBy, { 'dig-down': 1 });
  const curator = new SkillCurator({ autonomous: false } as any, engine, book, bus);
  const payload = curator.messages()[1].content;
  assert.match(payload, /"undid_work_of":\{"pillar-up":1\}/);
  assert.match(payload, /"work_undone_by":\{"dig-down":1\}/);
  assert.match(curator.messages()[0].content, /互相拆台/);
});

test('自己站的格子里有火把：mine_cell [0,0,0] 照样拿掉（不再说“本来就空着”）；pillar_one 被火把挡住时说清楚', async (t) => {
  const { mineCell, pillarOne } = await import('../src/skills/movement/primitives.ts');
  const w = new LostDropWorld(), ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  w.setBlock({ x: 0, y: 63, z: 0 }, 'stone');
  w.setBlock({ x: 0, y: 64, z: 0 }, 'torch');
  const r = await mineCell.run(ctx, (mineCell.validate({ at: [0, 0, 0], facing: 'N', allowUnknownAdjacent: true }, w) as any).args);
  assert.equal(r.status, 'succeeded', r.summary);
  assert.match(r.summary, /挖掉了 \[0,0,0\] 的 torch/);
  assert.equal(w.blockAt({ x: 0, y: 64, z: 0 }), 'air');
  w.setBlock({ x: 0, y: 64, z: 0 }, 'air');
  const empty = await mineCell.run(ctx, (mineCell.validate({ at: [0, 0, 0], facing: 'N', allowUnknownAdjacent: true }, w) as any).args);
  assert.match(empty.summary, /本来就空着/);
  // 原地垫高的提示
  w.inv.set('dirt', 4);
  (w as any).pillarUp = async () => ({ ok: false, reason: 'BLOCKED:torch' });
  const p = await pillarOne.run(ctx, (pillarOne.validate({ item: 'dirt' }, w) as any).args);
  assert.equal(p.status, 'failed', p.summary);
  assert.match(p.summary, /原地垫高没成/);
});

test('inspect_block 看身后的方块会先回头看，而不是直接说看不见', async (t) => {
  const { inspectBlock } = await import('../src/skills/observation.ts');
  const w = new LostDropWorld();
  const target = { x: 0, y: 64, z: 5 }; // 南边（身后，默认面朝北）
  const looks: number[] = [];
  w.look = async (yaw: number) => { looks.push(yaw); (w as any).yaw = yaw; };
  const facingIt = () => Math.abs(Math.atan2(-(target.x + 0.5 - w.pos.x), -(target.z + 0.5 - w.pos.z)) - ((w as any).yaw ?? 0)) < 0.3;
  const ctx = makeCtx(w, { senses: { observeBlocks: (ps: any[]) => facingIt() ? ps.map((p) => ({ name: 'chest', properties: {}, pos: p })) : [] } as any });
  t.after(() => ctx.memory.close());
  const r = await inspectBlock.run(ctx, { target });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(looks.length, 1, '回了一次头');
});
