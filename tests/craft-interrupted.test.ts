import assert from 'node:assert/strict';
import { test } from 'node:test';
import { craft } from '../src/skills/work.ts';
import { sleep } from '../src/util.ts';
import { makeCtx, TestWorld } from './survival-helpers.ts';

/** 像真的 Mineflayer：取消只是不再等，合成请求照样在服务器那边做完 */
class LaggyCraftWorld extends TestWorld {
  crafts = 0;
  override async craft(item: string, count: number, signal: AbortSignal) {
    this.crafts++;
    const done = sleep(150).then(() => { this.inv.set(item, (this.inv.get(item) ?? 0) + count); });
    await Promise.race([done, new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortedError' })), { once: true }))]);
    return { ok: true, crafted: count };
  }
}

test('合成被打断但其实做成了：说一声；紧接着再要同一样，不重复做', async () => {
  const w = new LaggyCraftWorld();
  const first = makeCtx(w);
  const ctrl = new AbortController();
  const events: string[] = [];
  first.bus.on('event', (e: any) => events.push(`${e.type}:${e.msg}`));
  const run1 = craft.run({ ...first, signal: ctrl.signal }, { item: 'iron_sword', count: 1 });
  await sleep(30);
  ctrl.abort('改了做法');
  await assert.rejects(run1, (e: any) => e.name === 'AbortedError');

  // 心智马上又下了同一个合成
  const r = await craft.run(makeCtx(w), { item: 'iron_sword', count: 1 });
  assert.equal(r.status, 'succeeded');
  assert.match(r.summary, /其实已经做成了 1 个 iron_sword，这次不再重复做（背包里现在共 1 个）/);
  assert.equal(w.inv.get('iron_sword'), 1, '只有一把');
  assert.equal(w.crafts, 1, '没有再发一次合成');
  assert.ok(events.some((e) => e.startsWith('craft_landed:') && /iron_sword \+1/.test(e)));

  // 之后再要一把：已经有一把还经用的铁剑，不再做；明说要备用（extra）才做，并说清现在共有几把
  const dup = await craft.run(makeCtx(w), { item: 'iron_sword', count: 1 });
  assert.equal(dup.failureCode, 'BAD_ARGS');
  assert.match(dup.summary, /已经有 iron_sword×1/);
  const r2 = await craft.run(makeCtx(w), { item: 'iron_sword', count: 1, extra: true });
  assert.match(r2.summary, /合成了 1 个 iron_sword（背包里现在共 2 个）/);
  assert.equal(w.crafts, 2);
});

test('合成成功的结果写出背包里共有几个，身上穿着同样的也说出来', async () => {
  const w = new TestWorld();
  w.inv.set('iron_chestplate', 1);
  const base = w.state.bind(w);
  (w as any).state = () => ({ ...base(), equipment: [{ slot: 'torso', name: 'iron_chestplate' }] });
  const r = await craft.run(makeCtx(w), { item: 'iron_chestplate', count: 1, extra: true }); // 已经穿着一件，明说要再做
  assert.match(r.summary, /合成了 1 个 iron_chestplate（背包里现在共 2 个，身上还穿着一件）/);
});
