import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { makeBridge } from '../src/codeskills/bridge.ts';
import { runSandboxed } from '../src/codeskills/sandbox.ts';
import { SkillCurator } from '../src/codeskills/curator.ts';
import { EventBus } from '../src/events.ts';
import { BUILTIN_SKILLS_DIR, SkillBook } from '../src/knowledge/skillbook.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { BehaviorEngine } from '../src/mind/behaviors.ts';
import { evalPredicate, validatePredicate, type Sense } from '../src/mind/predicate.ts';
import { SelfModel } from '../src/mind/self.ts';
import { FakeAdapter } from './fake-adapter.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'curio-body-'));
const noSenses = { perceivedEntities: () => [], knownBlocks: () => [], refresh() {}, markSweep() {} };

function rig(t: { after(fn: () => void): void }) {
  const adapter = new FakeAdapter(), bus = new EventBus(), memory = new WorldMemory(null);
  t.after(() => memory.close());
  adapter.pos = { x: 0.5, y: 64, z: 0.5 };
  const senses = {
    ...noSenses,
    perceivedEntities: (r: number) => adapter.entities.map((e) => ({ ...e, dist: Math.hypot(e.pos.x - adapter.pos.x, e.pos.y - adapter.pos.y, e.pos.z - adapter.pos.z) })).filter((e) => e.dist <= r),
  };
  const ctx = { adapter, senses, memory, bus, signal: new AbortController().signal, deadline: Date.now() + 20_000, taskId: 't', progress() {} } as any;
  const run = (code: string) => runSandboxed(code, {}, makeBridge(ctx), { signal: ctx.signal, deadline: ctx.deadline });
  return { adapter, bus, memory, run };
}

test('身体的细动作：边盯着怪边后退拉开距离，打法写在代码技能里（身体自己不会）', async (t) => {
  const { adapter, run } = rig(t);
  adapter.entities = [{ id: 7, name: 'zombie', kind: 'hostile', pos: { x: 2.5, y: 64, z: 0.5 }, dist: 2 }];
  const r = await run(`
    let me = await api.state(), z, tries = 0;
    for (;;) {
      z = (await api.entities(16)).find((e) => e.name === 'zombie');
      if (!z || z.dist >= 6 || ++tries > 20) break;
      const m = await api.move({ back: true }, 300, { face: z.id });
      if (!m.ok) throw new Error('退不了：' + m.stopped);
    }
    const hit = await api.attack(z.id);
    return { dist: z.dist, hit: hit.ok, tries };`);
  assert.equal(r.ok, true, r.error);
  assert.ok((r.result as any).dist >= 6, `拉开到 ${(r.result as any).dist} 格`);
  assert.equal((r.result as any).hit, false, '离得太远就打不到');
  assert.ok(adapter.actions.includes('drive:back'));
  assert.ok(adapter.pos.x < -2, '朝远离僵尸的方向退');
});

test('身体本能只管不迈进岩浆：退到岩浆边会自己停下，代码能看到为什么停', async (t) => {
  const { adapter, run } = rig(t);
  adapter.blocks.push({ name: 'lava', pos: { x: -1, y: 63, z: 0 } });
  adapter.entities = [{ id: 7, name: 'zombie', kind: 'hostile', pos: { x: 2.5, y: 64, z: 0.5 }, dist: 2 }];
  const r = await run(`return await api.move({ back: true }, 600, { face: 7 });`);
  assert.equal(r.ok, true, r.error);
  assert.equal((r.result as any).ok, false);
  assert.equal((r.result as any).stopped, 'lava');
  assert.ok(adapter.pos.x > -0.1, `停在岩浆前：${adapter.pos.x}`);
});

test('盾和弓：要先把盾换到副手才举得起来；拉弓蓄力多久由代码决定', async (t) => {
  const { adapter, run } = rig(t);
  adapter.inv.set('shield', 1);
  adapter.inv.set('bow', 1);
  adapter.inv.set('arrow', 8);
  const r = await run(`
    const before = await api.shield(true);
    await api.equip('shield', 'off-hand');
    const up = await api.shield(true);
    const s = await api.state();
    await api.shield(false);
    await api.draw('bow');
    await api.sleep(300);
    const shot = await api.release([10, 66, 0]);
    return { before: before.code, up: up.ok, offHand: s.offHand, using: s.usingItem, charged: shot.chargedMs };`);
  assert.equal(r.ok, true, r.error);
  const v = r.result as any;
  assert.equal(v.before, 'NO_SHIELD');
  assert.equal(v.up, true);
  assert.equal(v.offHand, 'shield');
  assert.equal(v.using, true);
  assert.ok(v.charged >= 250, `蓄了 ${v.charged}ms`);
  assert.ok(adapter.actions.includes('release:10,66,0'));
});

test('感官：代码能读到距上次挨打多久、死后掉在地上的东西还剩多少秒', async (t) => {
  const { bus, memory, run } = rig(t);
  const first = await run('return await api.state();');
  assert.equal((first.result as any).hurtAgoMs, null);
  assert.equal((first.result as any).deathDrop, null);
  bus.publish('hurt', 'P2', '受到伤害');
  memory.setDeath({ ts: Date.now() - 60_000, dim: 'overworld', pos: { x: 30, y: 64, z: 0 }, lost: [{ name: 'iron_pickaxe', count: 1 }] });
  const r = await run('return await api.state();');
  const s = r.result as any;
  assert.ok(s.hurtAgoMs >= 0 && s.hurtAgoMs < 5000);
  assert.deepEqual(s.deathDrop.items, [{ name: 'iron_pickaxe', count: 1 }]);
  assert.ok(s.deathDrop.secondsLeft > 230 && s.deathDrop.secondsLeft <= 240);
});

test('触发条件：dropped_items 和 dim 都是感觉得到的事实，怎么用由技能自己定', () => {
  const sense = (dim: string, deathDrop: Sense['deathDrop']) => ({ state: { dim, hp: 20, food: 20 }, hostiles: [], lightLevel: 15, facing: 'N', cell: () => null, doing: null, hurtAgoMs: Infinity, cover: 'open', deathDrop }) as unknown as Sense;
  const p = validatePredicate({ dropped_items: { within: 100, left_above: 60 } });
  assert.ok(!('error' in p));
  assert.equal(evalPredicate(p as any, sense('overworld', { dist: 40, leftS: 200, count: 3 })), true);
  assert.equal(evalPredicate(p as any, sense('overworld', { dist: 140, leftS: 200, count: 3 })), false, '太远');
  assert.equal(evalPredicate(p as any, sense('overworld', { dist: 40, leftS: 30, count: 3 })), false, '来不及');
  assert.equal(evalPredicate(p as any, sense('overworld', null)), false);
  const nether = validatePredicate({ dim: 'the_nether', hp_below: 10 });
  assert.equal(evalPredicate(nether as any, { ...sense('the_nether', null), state: { dim: 'the_nether', hp: 6 } } as any), true);
  assert.equal(evalPredicate(nether as any, { ...sense('overworld', null), state: { dim: 'overworld', hp: 6 } } as any), false);
  assert.match((validatePredicate({ dropped_items: { left_above: 900 } }) as any).error, /0–300/);
});

test('新环境：第一次到下界是新环境（老存档里的主世界不算）；只在下界用的技能，人在主世界时不会因为“长期不用”被收起', async () => {
  const self = new SelfModel(null);
  assert.equal(self.firstVisit('overworld'), false);
  assert.equal(self.firstVisit('the_nether'), true);
  assert.equal(self.firstVisit('the_nether'), false);
  const adapter = new FakeAdapter(), bus = new EventBus();
  const book = new SkillBook(BUILTIN_SKILLS_DIR, tmp());
  const engine = new BehaviorEngine(book, adapter, null, bus, noSenses);
  assert.ok(engine.write({ name: 'nether-lava-care', description: '下界里血少时贴墙走', when: { dim: 'the_nether', hp_below: 10 }, code: 'return 1;' }).ok);
  assert.ok(engine.write({ name: 'old-trick', description: '血少时垫高', when: { hp_below: 6 }, code: 'return 1;' }).ok);
  const curator = new SkillCurator({ autonomous: false } as any, engine, book, bus, { unusedMs: 1000 });
  curator.dim = () => adapter.dim;
  curator.retireUnused(Date.now() + 5000);
  assert.equal(engine.statsOf('nether-lava-care')?.retired, undefined, '人不在下界，用不上是正常的');
  assert.match(engine.statsOf('old-trick')!.retired!, /没用上/);
});
