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
import { dig } from '../src/skills/body.ts';
import { goTo as goto } from '../src/skills/movement.ts';
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

test('拆了床没捡到：说清楚掉落物现在在哪、是不是泡在水里漂；记忆里的“我的床”跟着忘掉', async (t) => {
  const w = new LostDropWorld(), ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  ctx.memory.setWorld(w.worldId);
  const bed = { x: 2, y: 64, z: 0 };
  w.setBlock(bed, 'white_bed');
  ctx.memory.addLandmark('discovery', '我的床', 'overworld', bed, 2);
  w.setBlock({ x: 7, y: 63, z: 3 }, 'water');
  w.entities = [{ id: 9, name: 'item:white_bed', kind: 'item', pos: { x: 7.4, y: 63.2, z: 3.6 }, dist: 7, count: 1 } as any];
  const parsed = dig.validate({ target: '2,64,0', block: 'white_bed' }, w);
  assert.ok(parsed.ok);
  const r = await dig.run(ctx, (parsed as any).args);
  assert.equal(r.status, 'failed');
  assert.match(r.summary, /white_bed×1 在 \(7,63,3\).*泡在水里正在漂/);
  assert.match(r.summary, /pickup_items/);
  assert.ok(!ctx.memory.landmarks().some((l) => l.label === '我的床'), '拆掉的床不再记成“我的床”');
  // 一个都看不到：照实说，不假设拿到了
  w.setBlock({ x: 2, y: 64, z: 1 }, 'white_bed');
  w.entities = [];
  const r2 = await dig.run(ctx, (dig.validate({ target: '2,64,1', block: 'white_bed' }, w) as any).args);
  assert.match(r2.summary, /附近看不到它的掉落物/);
});

test('goto 可以写方向和格数：E 20 是往 x 变大的方向走 20 格，回报实际往哪走了', async (t) => {
  const w = new FakeAdapter(); w.pos = { x: 10.5, y: 64, z: 10.5 };
  const ctx = makeCtx(w); t.after(() => ctx.memory.close());
  const v = goto.validate({ target: 'E 20' }, w);
  assert.ok(v.ok);
  const r = await goto.run(ctx, (v as any).args);
  assert.equal(r.status, 'succeeded', r.summary);
  assert.ok(w.pos.x > 28 && Math.abs(w.pos.z - 10.5) < 1.5, `到了 ${JSON.stringify(w.pos)}`);
  assert.match(r.summary, /往 E 20 格/);
  assert.match(r.summary, /本次往 E 移动/);
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  const r2 = await goto.run(ctx, (goto.validate({ target: 'n 8' }, w) as any).args);
  assert.ok(w.pos.z < -6, `北是 z 变小：${JSON.stringify(w.pos)} ${r2.summary}`);
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
  const curator = new SkillCurator({ autonomous: false } as any, engine, book, bus, { maxActive: 4, unusedMs: 1e12 });
  const st = (n: string) => engine.statsOf(n) as any;
  // s0 屡用屡败；s1、s2 有用；s3 用过成过；s4、s5 从没派上用场
  for (const [n, ok, fail] of [['s0', 1, 8], ['s1', 5, 0], ['s2', 3, 1], ['s3', 1, 0]] as const) { const x = st(n) ?? {}; Object.assign(x, { ok, fail, fired: ok + fail }); }
  for (const n of ['s0', 's1', 's2', 's3']) if (!st(n)) assert.fail(`没有 ${n} 的统计`);
  const later = Date.now() + 2 * 3600_000;
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
  const { digAt } = await import('../src/skills/primitives.ts');
  const w = new LostDropWorld(), ctx = makeCtx(w, { memory: new (await import('../src/memory/store.ts')).WorldMemory(path.join(tmp(), 'world-memory.json')) });
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
  const v = digAt.validate({ at: [1, 1, 0], facing: 'N' }, w) as any;
  const r = await digAt.run(ctx, v.args);
  assert.equal(r.status, 'failed');
  assert.match(r.summary, /自己盖的.*拆东墙补西墙/);
  assert.equal(w.blockAt(pos), wall.name, '没拆');
  const forced = await digAt.run(ctx, (digAt.validate({ at: [1, 1, 0], facing: 'N', own: true }, w) as any).args);
  assert.equal(forced.status, 'succeeded', forced.summary);
  w.setBlock(pos, wall.name);
  const r2 = await dig.run(ctx, (dig.validate({ target: `${pos.x},${pos.y},${pos.z}` }, w) as any).args);
  assert.match(r2.summary, /自己盖的/);
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
