import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { RecipeBook } from '../src/methods/recipes.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { validatePlan } from '../src/planner/plan.ts';
import { Planner } from '../src/planner/planner.ts';
import { FakeAdapter } from './fake-adapter.ts';

const lake = (a: FakeAdapter) => {
  // 东边 4..40 是一片水（水面 y=63），再往东是陆地
  for (let x = 4; x <= 40; x++) for (let z = -3; z <= 3; z++) a.blocks.push({ name: 'water', pos: { x, y: 63, z } });
};
const runner = (a: FakeAdapter, memory = new WorldMemory(null)) => {
  const arbiter = new Arbiter(a, memory, new EventBus(), new Vision(a));
  return async (skill: string, args: unknown) => {
    const done = new Promise<TaskOutcome>((r) => arbiter.once('done', r));
    const started = arbiter.start({ skill, args }, 'llm');
    assert.ok(!('error' in started), 'error' in started ? started.error : '');
    return (await done).result;
  };
};

test('基础动作可以组合出“造船过河”：放船 → 坐上去 → 划过去 → 靠岸下船（这是 LLM 自己能拼出来的组合，不是专门的技能）', async () => {
  const a = new FakeAdapter();
  lake(a);
  a.inv.set('oak_boat', 1);
  const run = runner(a);
  let r = await run('use_item', { item: 'oak_boat', on: 'water', dir: 'E' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.spawned, 'boat');
  r = await run('interact', { entity: 'boat' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(a.state().riding, 'boat');
  r = await run('ride', { direction: 'E', distance: 80 });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(r.data?.blocked, true, '划到对岸靠岸停下');
  assert.ok(a.pos.x > 35, `应该划到湖对面，x=${a.pos.x}`);
  r = await run('dismount', {});
  assert.equal(r.status, 'succeeded', r.summary);
  assert.equal(a.state().riding, null);
});

test('基础动作的失败会给出可理解的原因', async () => {
  const a = new FakeAdapter();
  const run = runner(a);
  let r = await run('use_item', { item: 'oak_boat', on: 'water' });
  assert.equal(r.failureCode, 'MISSING_MATERIALS');
  a.inv.set('oak_boat', 1);
  r = await run('use_item', { item: 'oak_boat', on: 'water' });
  assert.equal(r.failureCode, 'NOT_FOUND');
  assert.match(r.summary, /看不见可以对着用的 water/);
  r = await run('ride', { direction: 'N' });
  assert.match(r.summary, /没有在乘坐/);
});

test('模型自己写的组合计划能通过校验', () => {
  const a = new FakeAdapter();
  const v = validatePlan({ goal: '造条船划到对岸', thought: '水太宽了，游过去太危险', steps: [
    { skill: 'craft', args: { item: 'boat', count: 1 } },
    { skill: 'use_item', args: { item: 'oak_boat', on: 'water' } },
    { skill: 'interact', args: { entity: 'boat' } },
    { skill: 'ride', args: { direction: 'E', distance: 60 } },
    { skill: 'dismount', args: {} },
  ], missing_ability: '想把船收回背包' }, a, 'llm');
  assert.ok(v.ok, !v.ok ? v.error : '');
  if (v.ok) assert.equal(v.plan.missingAbility, '想把船收回背包');
});

// ------------------------------------------------------------ 配方记忆
test('配方是玩出来的记忆：拿到过材料才知道；按类别再按物品分级查询', () => {
  const memory = new WorldMemory(null);
  memory.setWorld('w1');
  const book = new RecipeBook(config.mc.version, memory);
  try {
    let r: any = book.query({ category: 'transport' }, []);
    assert.equal(r.known.length, 0, '什么都没拿到过时不知道交通类配方');
    assert.ok(r.locked_count > 0);
    r = book.query({ item: 'oak_boat' }, []);
    assert.equal(r.known, false);

    memory.markSeen('items', 'oak_planks');
    r = book.query({ category: 'transport' }, []);
    assert.ok(r.known.some((k: any) => String(k.item).includes('boat')), JSON.stringify(r.known));
    r = book.query({ item: 'oak_boat' }, [{ name: 'oak_planks', count: 2 }]);
    assert.equal(r.known, true);
    assert.equal(r.craftable_now, false);
    const need = r.craft[0].needs.find((n: any) => n.item === 'oak_planks');
    assert.equal(need.missing, 3);
    assert.ok(r.missing_from[0].craft_from.some((x: string) => x.endsWith('_log')), JSON.stringify(r.missing_from));
    r = book.query({}, []);
    assert.ok(r.categories.some((c: string) => c.startsWith('transport')));
    assert.ok(book.unlockedBy('cobblestone', memory.heldItems()).some((x) => x.includes('furnace') || x.includes('stone_')));
  } finally { memory.close(); }
});

test('第一次拿到物品时记进记忆并提示想起了哪些配方', () => {
  const a = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const perception = new Perception(a, memory, bus, new Vision(a));
  const book = new RecipeBook(config.mc.version, memory);
  const unlocked: string[][] = [];
  perception.onNewItem = (item, before) => unlocked.push([item, ...book.unlockedBy(item, before)]);
  try {
    a.inv.set('cobblestone', 3);
    perception.update();
    perception.update();
    assert.equal(unlocked.filter((u) => u[0] === 'cobblestone').length, 1, '只在第一次拿到时提示');
    assert.ok(memory.heldItems().has('cobblestone'));
  } finally { memory.close(); }
});

test('决策时模型可以先查配方（只读），再给出计划', async () => {
  const a = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  memory.markSeen('items', 'oak_log');
  const perception = new Perception(a, memory, bus, new Vision(a));
  const replies = [
    JSON.stringify({ kind: 'recipes', category: 'transport' }),
    JSON.stringify({ kind: 'recipes', item: 'oak_boat' }),
    JSON.stringify({ goal: '做条船', thought: '有木头就能做船', steps: [{ skill: 'craft', args: { item: 'oak_boat', count: 1 } }] }),
  ];
  const sent: string[] = [];
  const cfg = { ...config, llm: { ...config.llm, provider: 'openai' as const, maxCallsPerHour: 1000, maxPromptTokens: 40000 } };
  const planner = new Planner(cfg, { name: 'recipe-test', complete: async (m) => { sent.push(m.at(-1)!.content); return { text: replies.shift()!, latencyMs: 5 }; } }, a, memory, bus, null);
  planner.recipeBook = new RecipeBook(config.mc.version, memory);
  try {
    const plan = await planner.propose({ reason: 'no_goal', percept: perception.update(), current: null, lastFailure: null, userSuggestion: null, results: [] });
    assert.equal(plan.steps[0].skill, 'craft');
    assert.match(sent[1], /配方记忆查询结果/);
    assert.match(sent[2], /oak_boat/);
    assert.equal(bus.recent().filter((e) => e.type === 'recipe_query').length, 2);
    assert.equal(bus.recent().filter((e) => e.type === 'llm_invalid').length, 0);
  } finally { memory.close(); }
});
