import assert from 'node:assert/strict';
import test from 'node:test';
import { Executive, briefReason } from '../src/brain/executive.ts';
import { extractJson } from '../src/planner/plan.ts';
import { lightUserPrompt, userPrompt, type PlanContext } from '../src/planner/prompt.ts';
import { WorldMemory } from '../src/memory/store.ts';

/**
 * 小决策要接上“此刻”，而不是接上十几秒前的情况：
 * - 只在手头最后一步快做完时才开始想（按模型实际要想多久估计）
 * - 每次决策都附上“自上次决定以来”程序测得的变化
 * - 小决策不带上一轮的 thought（模型会照抄“还泡在水里”这种过时的感受）
 */

const nearlyDone = (Executive.prototype as any).nearlyDone as (this: unknown, cur: unknown) => boolean;
const self = (full = false, durations: [string, number][] = []) => ({ latency: { light: 2000, full: 8000 }, durations: new Map(durations), wouldBeFull: () => full });
const taskOf = (skill: string, progress: number, elapsedMs: number) => ({ skill, progress, startedAt: Date.now() - elapsedMs });
const task = (progress: number, elapsedMs: number) => ({ progress, startedAt: Date.now() - elapsedMs });

test('长动作刚开始时不预先想下一步；按进度估计快做完（剩余时间 ≤ 模型响应时间）才想', () => {
  assert.equal(nearlyDone.call(self(), task(0, 500)), false, '刚开始、没有进度');
  assert.equal(nearlyDone.call(self(), task(0.125, 4000)), false, '砍了 1/8：还要约 28 秒');
  assert.equal(nearlyDone.call(self(), task(0.875, 28000)), false, '7/8：还要约 4 秒，比小决策的 2 秒久');
  assert.equal(nearlyDone.call(self(), task(0.95, 38000)), true, '还要约 2 秒：现在开始想正好接上');
  assert.equal(nearlyDone.call(self(), task(0.98, 100)), true, '进度报告说马上完成');
  assert.equal(nearlyDone.call(self(true), task(0.8, 20000)), true, '完整决策要想 8 秒：剩 5 秒时就该开始');
  // 报不出进度的动作（走路、只采一个）：按这个技能平时做一次要多久估计
  assert.equal(nearlyDone.call(self(false, [['goto', 10000]]), taskOf('goto', 0, 3000)), false, '平时 10 秒的 goto 才走了 3 秒');
  assert.equal(nearlyDone.call(self(false, [['goto', 10000]]), taskOf('goto', 0, 7000)), true, '还剩约 3 秒：现在想，决定到时正好接上');
  assert.equal(nearlyDone.call(self(), taskOf('goto', 0, 7000)), false, '没有进度也没有经验时等它做完');
});

function memory() { const m = new WorldMemory(null); m.setWorld('w'); return m; }

function ctx(extra: Partial<PlanContext> = {}): PlanContext {
  const percept: any = {
    self: { pos: [6, 63, -70], dim: 'overworld', hp: 18, food: 17, biome: null, inWater: false, inLava: false, held: 'wooden_axe' },
    inventory: [{ name: 'spruce_log', count: 8 }], emptySlots: 30,
    nearby: { hostile: [], passive: [], players: [], resources: [] }, vision: null, time: { timeOfDay: 3000, phase: 'day' },
    curiosities: [], drives: [], learn_candidates: [],
  };
  return { reason: 'no_goal', percept, current: null, lastFailure: null, userSuggestion: null,
    thread: [{ goal: '离开水域', thought: '还泡在水里，先上岸', then: '回去砍树', outcome: 'succeeded：到达 6,63,-70' }],
    changes: { seconds: 12, facts: ['走了约 9 格，现在在 (6,63,-70)', '已经离开水、不在水里了'] }, ...extra };
}

test('小决策末尾先写“此刻”和“自上次决定以来”的事实；旧 thought 不再出现', (t) => {
  const m = memory(); t.after(() => m.close());
  const text = lightUserPrompt(ctx(), m);
  const tail = text.slice(text.lastIndexOf('\n') + 1);
  assert.match(tail, /^此刻（以此为准）：在 \(6,63,-70\)，生命 18、饥饿 17，手持 wooden_axe。/);
  assert.match(tail, /自上次决定以来（12 秒）：走了约 9 格.*已经离开水、不在水里了/);
  assert.doesNotMatch(text, /还泡在水里/, '上一轮的感受不进小决策');
  assert.match(text, /回去砍树/, '上一轮的打算（then）保留，接着它走');
});

test('在水里时“此刻”明确写出来', (t) => {
  const m = memory(); t.after(() => m.close());
  const c = ctx(); (c.percept.self as any).inWater = true;
  assert.match(lightUserPrompt(c, m), /此刻（以此为准）：在 \(6,63,-70\)，在水里/);
});

test('完整决策把 since_last_decision 放在 state 前面', (t) => {
  const m = memory(); t.after(() => m.close());
  const text = userPrompt(ctx(), m);
  const body = JSON.parse(text.slice(text.indexOf('\n') + 1, text.lastIndexOf('\n')));
  const keys = Object.keys(body);
  assert.deepEqual(body.since_last_decision.facts.at(-1), '已经离开水、不在水里了');
  assert.ok(keys.indexOf('since_last_decision') > keys.indexOf('tool_results') && keys.indexOf('since_last_decision') < keys.indexOf('state'), '放在实时区、紧挨着 state 之前');
});

test('模型在完整对象后多写了内容时，取第一个括号配平的对象', () => {
  const one = '{"kind":"plan","goal":"砍树","steps":[{"skill":"gather","args":{"block":"log"}}]}';
  assert.deepEqual(extractJson(`${one}}`), JSON.parse(one));
  assert.deepEqual(extractJson(`${one}\n{"kind":"plan","goal":"另一份"}`), JSON.parse(one));
  assert.deepEqual(extractJson('前面的话 {"a":"含 } 的字符串","b":1} 后面'), { a: '含 } 的字符串', b: 1 });
});

test('亲历经验里的失败原因压成一句，不留半截括号', () => {
  assert.equal(briefReason('hut_5x5 尚未验收（123 个缺陷）。地基不行：air×4——换一块更平、没有水和岩浆的地方（换 origin）；还有 stone×22'), '地基不行：air×4');
  assert.doesNotMatch(briefReason('无法合成 stone_axe：MISSING_MATERIALS（cobblestone 还差 1（有 1），stick 还差 1（有 0））'), /[（(][^）)]*$/);
});
