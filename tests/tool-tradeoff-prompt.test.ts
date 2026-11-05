import assert from 'node:assert/strict';
import test from 'node:test';
import type { Arbiter } from '../src/arbiter/arbiter.ts';
import type { GameAdapter, MoveOpts, MoveTarget, Vec3Like } from '../src/adapter/types.ts';
import { EventBus } from '../src/events.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { createActivity } from '../src/mind/activity.ts';
import { Mind } from '../src/mind/mind.ts';
import { buildMindMessages, situationalReminders, type MindContext } from '../src/mind/prompt.ts';
import { SelfModel } from '../src/mind/self.ts';
import type { Thinker } from '../src/mind/thinker.ts';
import { Perception } from '../src/perception/perception.ts';
import { Vision } from '../src/perception/vision.ts';
import { excavationSkill, type ExcavationArgs } from '../src/skills/excavation.ts';
import type { Senses, SkillCtx } from '../src/skills/types.ts';
import { throwIfAborted } from '../src/util.ts';
import { FakeAdapter } from './fake-adapter.ts';

const AIR = new Set(['air', 'cave_air', 'void_air']);

/** 开挖测试用的小世界：和 tests/excavation.test.ts 的 ExcavationWorld 同形，digTimeEstimate 按指定工具模拟。 */
class ToolWorld extends FakeAdapter {
  digs: Vec3Like[] = [];
  moves: Vec3Like[] = [];
  digOpts: ({ tool?: string | null } | undefined)[] = [];
  /** 模拟适配器实际挖不动（例如耐久耗尽）：原样回传 reason */
  digFailure: string | null = null;
  constructor() {
    super();
    this.pos = { x: 0.5, y: 64, z: 0.5 };
    this.inv.set('iron_pickaxe', 1);
    this.inv.set('stone_shovel', 1);
  }
  setBlock(pos: Vec3Like, name: string) {
    this.blocks = this.blocks.filter((block) => block.pos.x !== pos.x || block.pos.y !== pos.y || block.pos.z !== pos.z);
    const key = `${pos.x},${pos.y},${pos.z}`;
    if (name === 'air') this.removed.add(key);
    else { this.removed.delete(key); this.blocks.push({ name, pos: { ...pos } }); }
  }
  override async look(yaw: number, pitch: number, signal?: AbortSignal) { throwIfAborted(signal); this.yaw = yaw; this.pitch = pitch; }
  override lightAt() { return { block: 14, sky: 0 }; }
  /** 镐挖石头/草方块，铲只挖泥土类；其它组合返回 null（表示这件工具挖不了） */
  override digTimeEstimate(block: string, tool: string | null) {
    if (!tool) return null;
    if (tool.endsWith('_pickaxe')) return 1500;
    if (tool.endsWith('_shovel')) return block === 'grass_block' || block === 'dirt' ? 1500 : null;
    return null;
  }
  override async dig(pos: Vec3Like, signal: AbortSignal, opts?: { tool?: string | null }) {
    throwIfAborted(signal);
    assert.ok(Math.hypot(pos.x + 0.5 - this.pos.x, pos.y + 0.5 - this.pos.y - 1.62, pos.z + 0.5 - this.pos.z) <= 4.5, 'only the physically adjacent work face is reachable');
    this.digs.push({ ...pos });
    this.digOpts.push(opts);
    if (this.digFailure) return { ok: false, reason: this.digFailure };
    this.setBlock(pos, 'air');
    return { ok: true };
  }
  override async moveTo(target: MoveTarget, options: MoveOpts) {
    throwIfAborted(options.signal);
    assert.equal(target.kind, 'near');
    if (target.kind !== 'near') throw new Error('Unexpected movement');
    assert.equal(options.constructionSafe, true);
    const feet = { x: Math.floor(target.pos.x), y: target.pos.y, z: Math.floor(target.pos.z) };
    for (const level of [0, 1]) assert.ok(AIR.has(this.blockAt({ ...feet, y: feet.y + level })), 'both actual body cells must be cleared before movement');
    assert.ok(!AIR.has(this.blockAt({ ...feet, y: feet.y - 1 })), 'a resolved move cannot fabricate a floor');
    this.moves.push({ ...target.pos });
    this.pos = { ...target.pos };
  }
}

function sensoryFixture(): Senses {
  return { refresh() {}, markSweep() {}, knownBlocks() { return []; }, perceivedEntities() { return []; } };
}

function context(world: GameAdapter): SkillCtx {
  return { adapter: world, memory: new WorldMemory(null), senses: sensoryFixture(), signal: new AbortController().signal,
    bus: new EventBus(), taskId: 'tool-tradeoff-test', deadline: Date.now() + 30000, progress() {} };
}

const args = (overrides: Partial<ExcavationArgs> = {}): ExcavationArgs => ({ entry: 'current', mode: 'stairs', direction: 'east', steps: 2, ...overrides });

test('excavate_path.tool：验证物品注册名形态，非法值在动作校验时拒绝', () => {
  const world = new ToolWorld();
  assert.equal(excavationSkill.validate({ ...args(), tool: 'iron_pickaxe' }, world).ok, true);
  assert.equal(excavationSkill.validate({ ...args(), tool: 'Iron Pickaxe' }, world).ok, false);
  assert.equal(excavationSkill.validate({ ...args(), tool: 5 }, world).ok, false);
  assert.equal(excavationSkill.validate(args(), world).ok, true, '不写 tool 仍走原有的身体换工具规则');
});

test('excavate_path.tool：指定工具不在背包 → TOOL_MISSING，不挖不走', async () => {
  const world = new ToolWorld();
  const result = await excavationSkill.run(context(world), args({ steps: 1, tool: 'diamond_pickaxe' }));
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'TOOL_MISSING');
  assert.match(result.summary, /背包里没有 diamond_pickaxe/);
  assert.equal(world.digs.length, 0);
  assert.equal(world.moves.length, 0);
  assert.ok(!world.actions.some((action) => action.startsWith('equip:')), '未装备不存在的工具');
});

test('excavate_path.tool：指定工具在背包 → 装备到主手并实际开挖成功', async () => {
  const world = new ToolWorld();
  const result = await excavationSkill.run(context(world), args({ steps: 2, tool: 'iron_pickaxe' }));
  assert.equal(result.status, 'succeeded', result.summary);
  assert.equal(world.equipped.get('hand'), 'iron_pickaxe');
  assert.ok(world.actions.includes('equip:iron_pickaxe:hand'));
  assert.ok(world.digs.length > 0);
  assert.ok(world.moves.length > 0);
  assert.ok(world.digOpts.length > 0 && world.digOpts.every((opts) => opts?.tool === 'iron_pickaxe'), '每次 dig 都把指定工具交给适配器，不让身体换别的工具');
});

test('excavate_path.tool：适配器挖不动时原样报出 TOOL_MISSING 事实，不走下一步', async () => {
  const world = new ToolWorld();
  world.digFailure = 'TOOL_MISSING:iron_pickaxe 耐久不足，实际挖不动 grass_block';
  const result = await excavationSkill.run(context(world), args({ steps: 1, tool: 'iron_pickaxe' }));
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'TOOL_MISSING');
  assert.ok(result.summary.includes(world.digFailure), result.summary);
  assert.equal(world.moves.length, 0);
});

test('excavate_path.tool：指定工具挖不了某一格 → TOOL_MISSING 并说明哪一格，不挖', async () => {
  const world = new ToolWorld();
  world.setBlock({ x: 1, y: 63, z: 0 }, 'stone');
  const result = await excavationSkill.run(context(world), args({ steps: 1, tool: 'stone_shovel' }));
  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'TOOL_MISSING');
  assert.match(result.summary, /stone_shovel 挖不了工作格 \(1,63,0\) 的 stone/);
  assert.equal(world.digs.length, 0, '预检失败前不挖，也不自动改用别的工具');
  assert.equal(world.moves.length, 0);
});

test('提示词：工具事实不占 5 条提醒配额，真实挖掘上下文里也能进入 user 消息', () => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const base: MindContext = { tier: 'deliberate', reason: '测试', percept: perception.update(), state: adapter.state(), self: new SelfModel(null),
    memory, activity: null, suspended: [], lastRecord: null, noticed: [], changes: [], userSuggestion: null, audience: null, notes: [], mySkills: [], persona: 'P' };
  const activity = createActivity({
    what: '沿矿道横着挖到 y12 以下，找钻石露头', why: '测试', kind: 'gather', repeat: 1,
    steps: [{ skill: 'excavate_path', args: { entry: 'current', mode: 'stairs', direction: 'east', steps: 4 } }],
  }, '', 'llm', adapter.state());
  const fact = '工具分级事实：铁镐耐久快见底，石镐还能挖普通方块';
  const ctx = { ...base, activity, toolFact: fact };
  const reminders = situationalReminders(ctx);
  assert.ok(reminders.length <= 5);
  assert.ok(!reminders.includes(fact), '工具事实不能放在会被 slice(0,5) 截掉的提醒里');
  const user = buildMindMessages(ctx).find((m) => m.role === 'user')!.content;
  assert.ok(user.includes(fact), '切片后单独追加，工具事实必须真正进入 user 消息');
  const hidden = buildMindMessages({ ...ctx, toolFact: null }).find((m) => m.role === 'user')!.content;
  assert.ok(!hidden.includes(fact));
  memory.close();
});

test('mind：同一 key 的工具事实不每念重复，key 变化后再说', () => {
  const adapter = new FakeAdapter(), memory = new WorldMemory(null), bus = new EventBus();
  adapter.inv.set('iron_pickaxe', 1);
  adapter.inv.set('stone_pickaxe', 1);
  adapter.inv.set('iron_ingot', 1);
  const perception = new Perception(adapter, memory, bus, new Vision(adapter));
  const captured: MindContext[] = [];
  const thinker = { think(ctx: MindContext) { captured.push(ctx); return new Promise(() => {}); } };
  const arbiter = { info: () => null, start: () => ({ id: 'noop' }) };
  const mind = new Mind({ adapter, arbiter: arbiter as unknown as Arbiter, perception, memory, bus,
    self: new SelfModel(null), persona: 'P', thinker: thinker as unknown as Thinker });
  const activity = createActivity({ what: '挖脚下', why: '测试', kind: 'gather', repeat: 1, steps: [{ skill: 'dig_at', args: { at: [0, -1, 0] } }] }, '', 'llm', adapter.state());
  (mind as any).activity = activity;
  (mind as any).think('测试', 'glance');
  assert.ok(captured[0]?.toolFact, '第一次遇到该状态时给出工具分级事实');
  (mind as any).thinking = null;
  (mind as any).think('测试', 'glance');
  assert.equal(captured[1]?.toolFact, null, '同一状态签名不重复');
  (mind as any).thinking = null;
  adapter.inv.set('iron_ingot', 2); // 稀缺材料数量变了 → key 变
  (mind as any).think('测试', 'glance');
  assert.equal(captured[2]?.toolFact, null, '两次投放至少隔 30 秒，key 变了也不立刻重发');
  (mind as any).thinking = null;
  (mind as any).toolFactAt -= 31_000;
  (mind as any).think('测试', 'glance');
  assert.ok(captured[3]?.toolFact, '过了最小间隔后状态变化再给一次');
  memory.close();
});
