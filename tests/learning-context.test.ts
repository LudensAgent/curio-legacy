import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { Executive } from '../src/brain/executive.ts';
import { deathCause, hazardLesson, reflectionDue, type VitalSample } from '../src/brain/habits.ts';
import { config } from '../src/config.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { bindRelative, derivePostcondition, MethodLibrary, simpleToMethod } from '../src/methods/learning.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import type { Completion } from '../src/planner/llm.ts';
import { normalizeStep, validatePlan } from '../src/planner/plan.ts';
import { Planner } from '../src/planner/planner.ts';
import { enforcePromptBudget, lightUserPrompt, promptCost, userPrompt, type PlanContext } from '../src/planner/prompt.ts';
import { SKILLS } from '../src/skills/index.ts';
import { FakeAdapter } from './fake-adapter.ts';

const flush = async () => { await setImmediate(); await setImmediate(); await setImmediate(); };
const reply = (body: object): Completion => ({ latencyMs: 500, text: JSON.stringify(body) });
const payload = (text: string) => JSON.parse(text.slice(text.indexOf('\n') + 1, text.lastIndexOf('\n')));

// ------------------------------------------------------------ 计划解析
test('步骤参数平铺在 step 上时提进 args；不存在的 wait/idle 映射为 wait（没有就环顾）', () => {
  const adapter = new FakeAdapter();
  assert.deepEqual(normalizeStep({ skill: 'gather', block: 'stone', for: { item: 'stone_pickaxe', count: 1 } }),
    { skill: 'gather', args: { block: 'stone', for: { item: 'stone_pickaxe', count: 1 } } });
  assert.deepEqual(normalizeStep({ skill: 'gather', args: { block: 'log' } }), { skill: 'gather', args: { block: 'log' } }, '已有 args 不动');
  const v = validatePlan({ goal: '挖石头', steps: [{ skill: 'gather', block: 'stone', count: 3 }, { skill: 'goto', target: 'base' }],
    on_fail: [{ skill: 'explore', direction: 'N' }] }, adapter, 'llm');
  assert.ok(v.ok, v.ok ? '' : v.error);
  if (v.ok) {
    assert.equal((v.plan.steps[0].args as any).block, 'stone');
    assert.equal((v.plan.steps[1].args as any).target, 'base');
    assert.equal(v.plan.onFail?.[0].skill, 'explore');
  }
  const w = validatePlan({ goal: '等一会', steps: [{ skill: 'idle', seconds: 6 }] }, adapter, 'llm');
  assert.ok(w.ok, w.ok ? '' : w.error);
  if (w.ok) assert.equal(w.plan.steps[0].skill, SKILLS.wait ? 'wait' : 'look_around');
  const saved = SKILLS.wait;
  delete SKILLS.wait;
  try {
    const l = validatePlan({ goal: '等一会', steps: [{ skill: 'wait', args: { seconds: 6 } }] }, adapter, 'llm');
    assert.ok(l.ok && l.plan.steps[0].skill === 'look_around');
  } finally { if (saved) SKILLS.wait = saved; }
  // 其余校验不变
  const bad = validatePlan({ goal: 'x', steps: [{ skill: 'gather', count: 3 }] }, adapter, 'llm');
  assert.ok(!bad.ok && /block 不能为空/.test(bad.error));
  assert.ok(!validatePlan({ goal: 'x', steps: [{ skill: 'teleport' }] }, adapter, 'llm').ok);
});

// ------------------------------------------------------------ 简单格式的 learn_skill
test('简单 learn_skill 转成候选方法：最后的合成/采集推出背包验收，去已知地标推出位置验收，推不出的退回宏', (t) => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null);
  t.after(() => memory.close());
  memory.setWorld(adapter.worldId);
  assert.deepEqual(derivePostcondition([{ skill: 'gather', args: { block: 'stone', count: 3 } }, { skill: 'craft', args: { item: 'stone_pickaxe' } }], adapter, memory),
    { type: 'inventory_gain', item: 'stone_pickaxe', count: 1 });
  assert.deepEqual(derivePostcondition([{ skill: 'gather', args: { block: 'stone', count: 6 } }], adapter, memory), { type: 'inventory_gain', item: 'cobblestone', count: 6 });
  assert.equal(derivePostcondition([{ skill: 'gather', args: { block: 'log', count: 6 } }], adapter, memory), null, '不知道是哪种原木');
  const lm = memory.addLandmark('waypoint', '矿洞口', adapter.dim, { x: 30, y: 64, z: 4 })!;
  assert.deepEqual(derivePostcondition([{ skill: 'goto', args: { target: '矿洞口' } }], adapter, memory),
    { type: 'location_near', dimension: adapter.dim, pos: { x: 30, y: 64, z: 4 }, radius: 4, landmarkId: lm.id });

  const r = simpleToMethod({ name: 'Stone Pick!', description: '挖石头做石镐', steps: [{ skill: 'gather', block: 'stone', count: 3 }, { skill: 'craft', args: { item: 'stone_pickaxe' } }] }, adapter, memory);
  assert.equal(r.kind, 'method');
  const methods = new MethodLibrary(null, adapter, memory, new EventBus());
  t.after(() => methods.dispose());
  if (r.kind === 'method') {
    assert.equal(r.method.name, 'stone_pick');
    const p = methods.propose(r.method);
    assert.ok(p.ok, p.ok ? '' : p.error);
    assert.equal(methods.list()[0].status, 'candidate');
  }
  const macro = simpleToMethod({ name: 'wood_run', description: '砍树', steps: [{ skill: 'gather', args: { block: 'log' } }, { skill: 'explore', args: {} }] }, adapter, memory);
  assert.equal(macro.kind, 'macro');
  assert.equal(simpleToMethod({ name: 'x' }, adapter, memory).kind, 'invalid');
  // 相对验收：已经有 5 块圆石时，要求试验后至少 11 块
  assert.deepEqual(bindRelative({ type: 'inventory_gain', item: 'cobblestone', count: 6 }, { inventory: [{ name: 'cobblestone', count: 5 }] } as any),
    { type: 'inventory_min', item: 'cobblestone', count: 11 });
  // 同样的程序不重复存版本
  if (r.kind === 'method') {
    const again = methods.propose(r.method);
    assert.ok(again.ok && again.existing);
    assert.equal(methods.list().length, 1);
  }
});

// ------------------------------------------------------------ 记忆：笔记、经验、反思
test('笔记带位置持久化；经验按 key 更新、亲历的排前面；反思计数不被亲历经验重置', (t) => {
  const memory = new WorldMemory(null);
  t.after(() => memory.close());
  memory.setWorld('w1');
  memory.addNote('inference', '村子在 120,64,-40', 'overworld', { x: 1.4, y: 64, z: 2.6 });
  memory.addNote('inference', '村子在 120,64,-40', 'overworld', { x: 2, y: 64, z: 3 });
  memory.addNote('inference', '下界要塞在东边', 'the_nether', { x: 0, y: 70, z: 0 });
  assert.equal(memory.notesFor({ dimension: 'overworld' }).length, 1, '同一处同一句只记一次');
  assert.deepEqual(memory.notesFor({ dimension: 'overworld' })[0].pos, { x: 1, y: 64, z: 3 });

  memory.addLesson('木镐挖不了铁', { source: 'model' });
  memory.addLesson('在 (1,2,3) 附近淹死过 1 次', { source: 'observed', key: 'hazard:a' });
  memory.addLesson('在 (1,2,3) 附近淹死过 2 次', { source: 'observed', key: 'hazard:a' });
  const lessons = memory.lessonsFor(6);
  assert.equal(lessons.length, 2);
  assert.equal(lessons[0].source, 'observed');
  assert.match(lessons[0].text, /2 次/);
  assert.equal(lessons[0].worldId, 'w1');

  for (let i = 0; i < 8; i++) memory.recordGoal({ goal: `g${i}`, goalType: 'gather', source: 'llm', status: 'succeeded', summary: '' });
  // 目标和经验同一毫秒写入时 ts 相同；把模型经验挪到更早
  (memory as any).data.lessons[0].ts = 0;
  assert.ok(reflectionDue(memory), '亲历经验不算反思');
  assert.ok(!reflectionDue(memory, 8, Date.now() + 1), '刚反思过就不再到期');
});

test('死因只根据死前的真实状态判断，并写成具体的亲历经验', () => {
  const now = 100_000;
  const s = (dt: number, o: Partial<VitalSample>): VitalSample => ({ ts: now - dt, hp: 20, food: 20, oxygen: 20, inWater: false, inLava: false, hostileDist: null, ...o });
  assert.equal(deathCause([s(3000, { inWater: true, oxygen: 4 }), s(1000, { inWater: true, oxygen: 0, hp: 2 })], 0, now), 'drowning');
  assert.equal(deathCause([s(1000, { inLava: true })], 0, now), 'lava');
  assert.equal(deathCause([s(1000, { food: 0, hp: 1 })], 0, now), 'starvation');
  assert.equal(deathCause([s(1000, { hostileDist: 2, hp: 4 })], now - 500, now), 'mob');
  assert.equal(deathCause([s(2000, { hp: 20 }), s(1000, { hp: 20 })], 0, now), 'fall');
  assert.equal(deathCause([], 0, now), 'unknown');
  assert.notEqual(deathCause([s(1000, { inWater: false, oxygen: 0, hp: 20 }), s(500, { oxygen: 0, hp: 20 })], 0, now), 'drowning', '岸上的氧气读数不可信');
  assert.equal(deathCause([s(1000, { hp: 8, hostileDist: 18, hostiles: [{ name: 'skeleton', dist: 18 }] })], 0, now), 'mob', '远处的骷髅也能射死人');
  assert.equal(hazardLesson({ pos: { x: -52, y: 58, z: 58 }, kind: 'drowning', count: 3, during: 'gather stone' }),
    '在 (-52,58,58) 附近做 gather stone 时淹死过 3 次：别在这一带往下挖或潜水；挖进水里先往上游、离开水边');
});

test('危险区域很久没再出事就淡化、过期；半径最多 12', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const memory = new WorldMemory(null);
  t.after(() => memory.close());
  memory.setWorld('w');
  let h = memory.addHazard({ dim: 'overworld', pos: { x: 0, y: 60, z: 0 }, kind: 'drowning' });
  for (let i = 0; i < 6; i++) h = memory.addHazard({ dim: 'overworld', pos: { x: 1, y: 60, z: 0 }, kind: 'drowning' });
  assert.equal(h.radius, 12);
  assert.ok(memory.hazardAt({ x: 5, y: 60, z: 0 }, 'overworld'));
  t.mock.timers.tick(3 * 40 * 60_000 + 20 * 60_000);
  assert.equal(memory.hazards('overworld')[0].radius, 10, '开始缩小');
  t.mock.timers.tick(5 * 20 * 60_000);
  assert.equal(memory.hazards('overworld').length, 0, '过期');
  assert.equal(memory.hazardAt({ x: 0, y: 60, z: 0 }, 'overworld'), null);
  assert.equal(memory.addHazard({ dim: 'overworld', pos: { x: 0, y: 60, z: 0 }, kind: 'drowning' }).count, 1, '过期后重新计数');
});

// ------------------------------------------------------------ 提示词里的学习上下文
function promptFixture() {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null);
  memory.setWorld(adapter.worldId);
  memory.addLesson('木镐挖不了铁', { source: 'model' });
  memory.addLesson('在 (-52,58,58) 附近做 gather stone 时淹死过 3 次', { source: 'observed', key: 'hazard:x' });
  for (let i = 0; i < 3; i++) memory.addHazard({ dim: adapter.dim, pos: { x: 10, y: 60, z: 0 }, kind: 'drowning', during: 'gather stone' });
  memory.addHazard({ dim: adapter.dim, pos: { x: 500, y: 60, z: 0 }, kind: 'lava' });
  memory.setChest(adapter.dim, { x: 3, y: 64, z: 1 }, [{ name: 'cobblestone', count: 40 }, { name: 'bread', count: 3 }]);
  const percept = new Perception(adapter, memory, new EventBus(), new Vision(adapter)).update();
  const ctx: PlanContext = { reason: 'no_goal', percept, current: null, lastFailure: null, userSuggestion: null, worldState: adapter.state(),
    mySkills: [{ name: 'trial:stone_pick:v1', status: 'candidate', description: '挖石头做石镐', trials: { verified: 1, failed: 0 } }] };
  return { adapter, memory, ctx };
}

test('完整决策带上经验、危险区域、自学技能和记得的箱子；小决策带精简版和能否睡觉', (t) => {
  const w = promptFixture();
  t.after(() => w.memory.close());
  const full = payload(userPrompt(w.ctx, w.memory));
  assert.match(full.lessons[0], /^【亲历】/);
  assert.equal(full.danger_zones.length, 1, '128 格外的不带');
  assert.deepEqual({ kind: full.danger_zones[0].kind, count: full.danger_zones[0].count, during: full.danger_zones[0].during }, { kind: 'drowning', count: 3, during: 'gather stone' });
  assert.equal(full.my_skills[0].name, 'trial:stone_pick:v1');
  assert.deepEqual(full.known_chests[0].items, ['cobblestone×40', 'bread×3']);
  const keys = Object.keys(full);
  assert.ok(keys.indexOf('lessons') < keys.indexOf('recent_attempts') && keys.indexOf('danger_zones') < keys.indexOf('state'), '稳定的在前，实时的在后');
  assert.equal(typeof full.state.time.can_sleep, 'boolean');
  assert.ok(keys.indexOf('my_skills') > keys.indexOf('known_locations'), '带试验计数的技能放在地标之后');

  const text = lightUserPrompt(w.ctx, w.memory);
  const light = JSON.parse(text.slice(text.indexOf('\n') + 1, text.lastIndexOf('\n')));
  assert.ok(light.lessons.length <= 3 && light.danger_zones.length <= 3 && light.my_skills.length <= 6);
  assert.deepEqual(Object.keys(light.my_skills[0]), ['name', 'description']);
  assert.equal(typeof light.state.time.can_sleep, 'boolean');
});

test('反思请求写在用户提示词末尾，压缩上下文时保留', (t) => {
  const w = promptFixture();
  t.after(() => w.memory.close());
  w.ctx.reflection = { why: '刚刚淹死了一次', learnCandidate: true };
  const content = userPrompt(w.ctx, w.memory);
  assert.match(content.slice(content.lastIndexOf('\n')), /反思（刚刚淹死了一次）.*lesson.*learn_skill/);
  payload(content);
  const huge = { ...w.ctx, results: Array.from({ length: 12 }, (_, i) => ({ skill: 'gather', summary: 'x'.repeat(3000), i })) };
  const messages = [{ role: 'system' as const, content: 'sys' }, { role: 'user' as const, content: userPrompt(huge, w.memory, [], 8000) }];
  enforcePromptBudget(messages, promptCost(messages) - 400);
  assert.match(messages[1].content, /context_truncated/);
  assert.match(messages[1].content.slice(messages[1].content.lastIndexOf('\n')), /反思（刚刚淹死了一次）/);
});

// ------------------------------------------------------------ 执行层
function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 });
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const vision = new Vision(adapter), arbiter = new Arbiter(adapter, memory, bus, vision);
  const perception = new Perception(adapter, memory, bus, vision);
  const pending: { resolve: (value: Completion) => void; messages: any[] }[] = [];
  const cfg = { ...config, llm: { ...config.llm, provider: 'openai' as const, maxCallsPerHour: 1000, maxPromptTokens: 40000 } };
  const planner = new Planner(cfg, { name: 'learning-test', complete: (messages) => new Promise((resolve) => pending.push({ resolve, messages })) }, adapter, memory, bus, null);
  const executive = new Executive({ adapter, memory, bus, arbiter, perception, planner });
  executive.start(1_000_000);
  t.after(() => { executive.stop(); arbiter.cancel('test end'); memory.close(); });
  const tick = async () => { executive.tick(); await flush(); };
  return { adapter, memory, bus, arbiter, executive, pending, tick, perception, planner };
}

test('note 写进世界记忆（带位置），新的执行层（重启后）还能在工作记忆里看到', async (t) => {
  const w = fixture(t);
  await w.tick();
  w.pending[0].resolve(reply({ goal: '去村子', thought: '那边有村民', note: '村子在 120,64,-40', lesson: '村民附近比较安全',
    steps: [{ skill: 'look_around', args: { for: 'villager' } }] }));
  await flush(); await w.tick();
  const saved = w.memory.notesFor({ dimension: w.adapter.dim });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].kind, 'inference');
  assert.ok(saved[0].pos);
  assert.equal(w.memory.lessonsFor()[0].source, 'model');
  const ctx = (w.executive as any).ctx('failure');
  assert.equal(ctx.notes.length, 1, '短期笔记和持久笔记去重');
  const fresh = new Executive({ adapter: w.adapter, memory: w.memory, bus: w.bus, arbiter: w.arbiter, perception: w.perception, planner: w.planner });
  assert.match((fresh as any).ctx('no_goal').notes[0], /^村子在 120,64,-40（(?:刚才|\d+ 分钟前)写于 -?\d+,-?\d+,-?\d+(?:，离这里 \d+ 格)?）$/);
});

test('边做边想的决定：要紧的事没变就不作废；掉血、背包大变或等太久才重想', (t) => {
  const w = fixture(t);
  const ex = w.executive as any;
  const cur = { skill: 'gather', args: { block: 'stone' } } as any;
  const snap = ex.basisSnapshot();
  w.adapter.pos.x += 30;
  assert.equal(ex.materialChange(snap, cur), null, '移动类动作走动是预期内的');
  assert.match(ex.materialChange(snap, { skill: 'craft', args: {} }), /格外/);
  w.adapter.pos.x -= 30;
  w.adapter.hp -= 5;
  assert.match(ex.materialChange(snap, cur), /掉了/);
  w.adapter.hp += 5;
  assert.equal(ex.materialChange({ ...snap, inventory: { ...snap.inventory, oak_log: 3 } }, cur) !== null, true, '背包里的东西没了');
  assert.equal(ex.materialChange({ ...snap, inventory: { ...snap.inventory, cobblestone: 80 } }, { skill: 'build', args: {} }), null, '建造本来就会用掉方块');
  w.adapter.inv.set('cobblestone', 40);
  assert.equal(ex.materialChange(snap, cur), null, '采集多出东西是预期内的');
});

test('失败补救：水边走不通坐船；没吃的时钓鱼或采集野果', (t) => {
  const w = fixture(t);
  const ex = w.executive as any;
  const outcome = (skill: string, args: unknown, code: string, summary: string) => ({ task: { skill, args }, result: { status: 'failed', failureCode: code, summary } } as unknown as TaskOutcome);
  if (SKILLS.boat) {
    const r = ex.repairSteps(outcome('goto', { target: '200,64,-30' }, 'PATH_NOT_FOUND', '前面是一大片水，走不过去'));
    assert.equal(r?.[0].skill, 'boat');
    assert.match(JSON.stringify(r?.[0].args.to), /200.*-30/);
  }
  if (SKILLS.forage) {
    const r = ex.repairSteps(outcome('eat', {}, 'NO_FOOD', '背包里没有可吃的食物'));
    assert.equal(r?.[0].skill, 'forage');
  }
  if (SKILLS.fish) {
    w.adapter.inv.set('fishing_rod', 1);
    const r = ex.repairSteps(outcome('eat', {}, 'NO_FOOD', '背包里没有可吃的食物'));
    assert.equal(r?.[0].skill, 'fish');
  }
});

test('死亡后最后失败写明死因与危险区域，下一次完整决策带上反思请求', async (t) => {
  const w = fixture(t);
  const hazard = w.memory.addHazard({ dim: w.adapter.dim, pos: { x: 0, y: 60, z: 0 }, kind: 'drowning', during: 'gather stone' });
  w.executive.onDeath({ cause: 'drowning', hazard, during: 'gather stone' });
  const lf = (w.executive as any).lastFailure;
  assert.equal(lf.code, 'DIED');
  assert.match(lf.summary, /淹死.*gather stone.*危险区域/);
  t.mock.timers.tick(2000);
  await w.tick();
  assert.ok(w.pending.length >= 1);
  const user = w.pending.at(-1)!.messages[1].content as string;
  assert.match(user.slice(user.lastIndexOf('\n')), /反思（刚刚淹死了一次）/);
  assert.ok(w.bus.recent().some((e) => e.type === 'llm_request' && e.data?.reflection));
  assert.equal(payload(user).reason, 'no_goal', '反思是附加标记，不改写原因');
  assert.equal((w.executive as any).reflectPending, '刚刚淹死了一次', '决定被采用前不记账');
  w.pending.at(-1)!.resolve(reply({ goal: '离开水边', thought: '这里太危险', lesson: '别在这片水边挖', steps: [{ skill: 'look_around', args: { for: 'land' } }] }));
  await flush(); await w.tick();
  assert.equal((w.executive as any).reflectPending, null);
});
