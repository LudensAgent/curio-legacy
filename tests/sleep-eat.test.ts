import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sleepSkill, sleepReason } from '../src/skills/build.ts';
import { shelter } from '../src/skills/survival.ts';
import { eat } from '../src/skills/work.ts';
import { sleep } from '../src/util.ts';
import { makeCtx, TestWorld } from './survival-helpers.ts';

/** 可控时间的世界：tod 是游戏刻（0–24000），每过 1 秒真实时间推进 ticksPerSecond 刻 */
class Clock extends TestWorld {
  tod = 1000;
  ticksPerSecond = 0;
  private t0 = Date.now();
  now() { return (this.tod + Math.floor((Date.now() - this.t0) / 1000) * this.ticksPerSecond) % 24000; }
  override state() { const t = this.now(); return { ...super.state(), timeOfDay: t, isDay: t < 13000 }; }
  override async sleepInBed(signal: AbortSignal) {
    const t = this.now();
    if (t < 12542 || t > 23459) return { ok: false, reason: "it's not night" };
    if (![...this.inv.keys()].some((n) => n.endsWith('_bed'))) return { ok: false, reason: 'NO_BED' };
    await sleep(50, signal);
    this.actions.push('slept');
    return { ok: true, bedPos: { x: 2, y: 64, z: 0 } };
  }
}

test('白天 sleep：不白跑，说清楚还要多久天黑', async () => {
  const w = new Clock(); w.inv.set('white_bed', 1); w.tod = 3000;
  const ctx = makeCtx(w);
  try {
    const r = await sleepSkill.run(ctx, {});
    assert.equal(r.status, 'failed');
    assert.match(r.summary, /还是白天，大约 \d+ 分钟后才能睡/);
    assert.ok(!w.actions.includes('slept'));
  } finally { ctx.memory.close(); }
});

test('黄昏 sleep：在床边等到天黑再躺上去（而不是立刻失败）', async () => {
  const w = new Clock(); w.inv.set('white_bed', 1); w.tod = 12500; w.ticksPerSecond = 40;
  const ctx = makeCtx(w, { deadlineMs: 60_000 });
  try {
    const r = await sleepSkill.run(ctx, {});
    assert.equal(r.status, 'succeeded', r.summary);
    assert.match(r.summary, /等了 \d+ 秒天黑，睡了一觉/);
    assert.ok(w.actions.includes('slept'));
  } finally { ctx.memory.close(); }
});

test('天黑后 shelter：背包有床、附近没怪就直接睡，不挖坑', async () => {
  const w = new Clock(); w.inv.set('white_bed', 1); w.inv.set('dirt', 4); w.tod = 14000;
  const ctx = makeCtx(w);
  try {
    const r = await shelter.run(ctx, { until: 'day' });
    assert.equal(r.status, 'succeeded', r.summary);
    assert.match(r.summary, /有床就没挖坑/);
    assert.ok(!w.actions.some((a) => a.startsWith('dig')), '没有挖坑');
  } finally { ctx.memory.close(); }
});

test('睡觉失败的原因翻成人话', () => {
  assert.match(sleepReason('You can\'t sleep, there are monsters nearby'), /附近有怪物/);
  assert.match(sleepReason('NO_BED'), /羊毛/);
});

class SlowStomach extends TestWorld {
  bites = 0; updateDelayMs = 300; swallow = true;
  override hasFood() { return (this.inv.get('bread') ?? 0) > 0; }
  override async eat(signal: AbortSignal) {
    await sleep(50, signal);
    this.bites++;
    this.inv.set('bread', (this.inv.get('bread') ?? 0) - 1);
    // 服务器的饥饿值更新晚到
    if (this.swallow) setTimeout(() => { this.food = Math.min(20, this.food + 5); }, this.updateDelayMs);
    return true;
  }
}

test('eat：饥饿值更新晚到也能吃饱，不会咬一口就当吃完', async () => {
  const w = new SlowStomach(); w.food = 6; w.inv.set('bread', 5);
  const ctx = makeCtx(w);
  try {
    const r = await eat.run(ctx, {});
    assert.equal(r.status, 'succeeded', r.summary);
    assert.ok(w.food >= 18, `吃到能回血：${w.food}`);
    assert.match(r.summary, /饥饿值 6 → \d+/);
  } finally { ctx.memory.close(); }
});

test('eat：咬了但饥饿值没变，就报没吃进去，而不是“进食完成”', async () => {
  const w = new SlowStomach(); w.food = 6; w.inv.set('bread', 5); w.swallow = false;
  const ctx = makeCtx(w);
  try {
    const r = await eat.run(ctx, {});
    assert.equal(r.status, 'failed');
    assert.match(r.summary, /没吃进去/);
  } finally { ctx.memory.close(); }
});

test('已经有床（背包里或放在某处）就不再做第一张以外的床，并告诉它床在哪', async () => {
  const { craft } = await import('../src/skills/work.ts');
  const w = new Clock(); w.inv.set('white_wool', 3); w.inv.set('oak_planks', 3);
  const ctx = makeCtx(w);
  ctx.memory.setWorld(w.worldId);
  try {
    w.inv.set('white_bed', 1);
    let r = await craft.run(ctx, { item: 'white_bed', count: 1 });
    assert.equal(r.status, 'failed');
    assert.match(r.summary, /背包里已经有 white_bed/);
    w.inv.delete('white_bed');
    ctx.memory.addLandmark('discovery', '我的床', 'overworld', { x: 40, y: 64, z: 0 }, 2);
    r = await craft.run(ctx, { item: 'white_bed', count: 1 });
    assert.equal(r.status, 'failed');
    assert.match(r.summary, /已经有一张自己的床放在 \(40,64,0\)/);
    assert.ok(!w.actions.includes('craft:white_bed'));
  } finally { ctx.memory.close(); }
});
