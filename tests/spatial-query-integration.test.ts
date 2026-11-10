/**
 * spatial_query 集成验收：真实注册、真实 SharedSpatialSession（独立临时 SQLite），
 * 经 Arbiter、api.act 代码路径、学习步骤和 SkillLibrary 宏分发；不连接游戏、不启动 harness。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import type { BlockObservation } from '../src/adapter/types.ts';
import { makeBridge } from '../src/codeskills/bridge.ts';
import { EventBus } from '../src/events.ts';
import { SkillBook } from '../src/knowledge/skillbook.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { BehaviorEngine } from '../src/mind/behaviors.ts';
import { moveDetails, movesCatalog } from '../src/mind/prompt.ts';
import { Vision } from '../src/perception/vision.ts';
import { SKILLS, skillCatalog } from '../src/skills/index.ts';
import { SkillLibrary } from '../src/skills/library.ts';
import { spatialQuery } from '../src/skills/spatial-query.ts';
import { runSkill, type SkillCtx } from '../src/skills/types.ts';
import { setBehaviorRegistry, useSkill } from '../src/skills/use-skill.ts';
import { SharedSpatialSession } from '../src/spatial/shared-session.ts';
import type { ShutdownResult } from '../src/spatial/shared-session.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { stubSenses } from './survival-helpers.ts';

const WORLD = 'world-spatial-integration';
const DIM = 'overworld';
const SESSION = 's1';

const clone = <T>(value: T): T => structuredClone(value);

function block(pos: { x: number; y: number; z: number }, name: string, observedAt: number, observationId: number): BlockObservation {
  return {
    name, properties: {}, worldId: WORLD, sessionId: SESSION, dimension: DIM,
    source: 'vision', stateComplete: true, observedAt, observationId, pos,
  };
}

function rec(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected object');
  return value as Record<string, unknown>;
}

/** 真实 Arbiter 任务的终态（保持 done 监听直到收到或预算耗尽）。 */
function arbiterOutcome(arbiter: Arbiter, skill: string, args: unknown, budgetMs = 5000): Promise<TaskOutcome | null> {
  const started = arbiter.start({ skill, args }, 'user');
  if ('error' in started) throw new Error(started.error);
  const id = started.id;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { arbiter.off('done', onDone); resolve(null); }, budgetMs);
    const onDone = (outcome: TaskOutcome) => {
      if (outcome.task.id !== id) return;
      clearTimeout(timer);
      arbiter.off('done', onDone);
      resolve(outcome);
    };
    arbiter.on('done', onDone);
  });
}

test('spatial_query：真实注册、只读分发、查询数据保留且不产生物理效果', async (t) => {
  // ---- 注册与目录：名字 + 一句用途，不把完整 schema 塞进静态目录 ----
  assert.equal(SKILLS.spatial_query, spatialQuery);
  assert.equal(spatialQuery.readOnly, true);
  const catalog = skillCatalog();
  assert.match(catalog, /- spatial_query /);
  assert.equal(movesCatalog(), movesCatalog(), '静态完整目录保持稳定');
  assert.match(movesCatalog(), /spatial_query（/, '完整目录只给名字 + 用途');
  assert.doesNotMatch(movesCatalog(), /"kind":"cells"/, '完整目录不塞入查询参数 schema');
  assert.match(moveDetails(['spatial_query']), /"kind":"cells"/, '按需查询才给完整参数');

  const dir = mkdtempSync(join(tmpdir(), 'spatial-query-integration-'));
  const adapter = new FakeAdapter();
  const memory = new WorldMemory(null);
  const bus = new EventBus();
  const spatial = await SharedSpatialSession.open({ worldId: WORLD, databasePath: join(dir, 'memory.db'), timeoutMs: 5000 });
  let shutdown: ShutdownResult | null = null;
  let arbiter: Arbiter | null = null;
  const library = new SkillLibrary(null, adapter, memory, bus);

  try {
    spatial.beginSession({ worldId: WORLD, dim: DIM, sessionId: SESSION });
    const now = Date.now();
    spatial.observe([
      block({ x: 0, y: 64, z: 0 }, 'minecraft:stone', now, 1),
      block({ x: 1, y: 64, z: 0 }, 'minecraft:dirt', now, 2),
    ]);
    const facts = spatial.session.facts;
    facts.upsertPlace({
      id: 'n-a', kind: 'base', label: 'home', worldId: WORLD, dim: DIM,
      location: { kind: 'exact', pos: { x: 0, y: 64, z: 0 } }, observedAt: 12_345,
      source: { source: 'agent', sessionId: SESSION, observationIds: ['obs-a'] }, gone: false,
    });
    facts.upsertResource({
      id: 'n-b', worldId: WORLD, dim: DIM, label: 'iron', sourceCell: { x: 1, y: 64, z: 0 },
      observedAt: 23_456, source: { source: 'vision', sessionId: SESSION }, revoked: false,
    });

    const evidenceBefore = {
      voxelRevision: spatial.session.voxel.saveRevision,
      factsRevision: facts.revision,
      cell: clone(spatial.session.voxel.cellAt(DIM, 0, 64, 0)),
      factsSnapshot: clone(facts.checkpointSnapshot()),
    };

    arbiter = new Arbiter(adapter, memory, bus, new Vision(adapter), spatial);
    const ctx: SkillCtx = {
      adapter, memory, bus, senses: stubSenses(adapter),
      signal: new AbortController().signal, deadline: Date.now() + 10_000,
      taskId: 'integration-parent', progress() {}, spatial,
    };

    await t.test('Arbiter 任务：契约信封与库分页原样穿过调度', async () => {
      const nodes = await arbiterOutcome(arbiter!, 'spatial_query', {
        kind: 'nodes', dim: DIM, source: 'agent', limit: 1,
      });
      assert.ok(nodes !== null, 'nodes 查询应有终态');
      assert.equal(nodes.result.status, 'succeeded');
      const nodesEnvelope = rec(nodes.result.data);
      assert.equal(nodesEnvelope.status, 'ok');
      assert.equal(nodesEnvelope.contract, 'memory-host-contract/2');
      assert.equal(nodesEnvelope.worldId, WORLD);
      assert.equal(nodesEnvelope.dim, DIM);
      assert.equal(nodesEnvelope.readOnly, true);
      assert.equal(nodesEnvelope.executable, false);
      const nodesData = rec(nodesEnvelope.data);
      assert.equal(nodesData.kind, 'nodes');
      assert.deepEqual((nodesData.items as { id: string }[]).map((node) => node.id), ['n-a']);

      const first = await arbiterOutcome(arbiter!, 'spatial_query', {
        kind: 'nodes', dim: DIM, source: 'agent', limit: 1,
      });
      assert.ok(first !== null);
      assert.equal(first.result.status, 'succeeded');
      const firstEnvelope = rec(first.result.data);
      assert.equal(firstEnvelope.total, 1);
      const firstData = rec(firstEnvelope.data);
      const firstNode = rec((firstData.items as unknown[])[0]);
      assert.equal(firstNode.id, 'n-a');

      const second = await arbiterOutcome(arbiter!, 'spatial_query', {
        kind: 'nodes', dim: DIM, source: 'program', limit: 1,
      });
      assert.ok(second !== null);
      const secondEnvelope = rec(second.result.data);
      assert.equal(secondEnvelope.total, 1);
      const secondNode = rec((rec(secondEnvelope.data).items as unknown[])[0]);
      assert.equal(secondNode.id, 'n-b');

      // 退役的路线/片段 kind 已不在库请求联合中；库 validator 自然拒绝。
      const retired = await arbiterOutcome(arbiter!, 'spatial_query', { kind: 'fragments', dim: DIM, limit: 1 });
      assert.ok(retired !== null);
      assert.equal(retired.result.status, 'failed');
      const retiredData = rec(retired.result.data);
      assert.equal(retiredData.status, 'invalid_request');
      assert.equal(retiredData.data, undefined);
    });

    await t.test('代码路径 api.act：保留查询结果、标记 noop、不冒充物理动作', async () => {
      const code = `const a = await api.act("spatial_query", ${JSON.stringify({ kind: 'cells', dim: DIM, positions: [{ x: 0, y: 64, z: 0 }] })});\n`
        + `const b = await api.act("spatial_query", ${JSON.stringify({ kind: 'nodes', dim: DIM, source: 'agent', limit: 1 })});\n`
        + 'return { a, b };';
      const behavior = { name: 'query-code', description: '代码只读查询', steps: [], code };
      setBehaviorRegistry({ get: (name) => name === behavior.name ? behavior : undefined, list: () => [{ name: behavior.name }] });
      const result = await useSkill.run(ctx, { name: behavior.name });
      assert.equal(result.status, 'succeeded');
      assert.equal(result.data?.noop, true);
      const returned = rec(result.data?.result);
      const cellEnvelope = rec(rec(returned.a).data);
      assert.equal(cellEnvelope.status, 'ok');
      const cellData = rec(cellEnvelope.data);
      assert.equal(rec((cellData.cells as unknown[])[0]).observed, true);
      const nodeEnvelope = rec(rec(returned.b).data);
      const nodeItem = rec((rec(nodeEnvelope.data).items as unknown[])[0]);
      assert.equal(nodeItem.id, 'n-a');
    });

    await t.test('学习步骤：只读步骤不计完成数、保留 stepResults 与查询数据', async () => {
      const behavior = {
        name: 'query-steps', description: '两步只读查询', version: 1,
        steps: [
          { skill: 'spatial_query', args: { kind: 'cells', dim: DIM, positions: [{ x: 1, y: 64, z: 0 }] } },
          { skill: 'spatial_query', args: { kind: 'nodes', dim: DIM, source: 'agent', limit: 1 } },
        ],
      };
      setBehaviorRegistry({ get: (name) => name === behavior.name ? behavior : undefined, list: () => [{ name: behavior.name }] });
      const result = await useSkill.run(ctx, { name: behavior.name });
      assert.equal(result.status, 'succeeded');
      assert.equal(result.data?.noop, true);
      const steps = result.data?.stepResults as Record<string, unknown>[];
      assert.equal(steps.length, 2);
      const cellEnvelope = rec(rec(steps[0]!.data));
      assert.equal(rec((rec(cellEnvelope.data).cells as unknown[])[0]).observed, true);
      const nodesEnvelope = rec(rec(steps[1]!.data));
      assert.equal(nodesEnvelope.total, 1);
      assert.equal(rec((rec(nodesEnvelope.data).items as unknown[])[0]).id, 'n-a');
    });

    await t.test('SkillLibrary 宏：只读元数据、逐页结果与 noop 聚合穿过 api.act', async () => {
      const learned = library.learn({
        name: 'query_macro', description: '分页读取历史片段',
        steps: [
          { skill: 'spatial_query', args: { kind: 'nodes', dim: DIM, source: 'agent', limit: 1 } },
          { skill: 'spatial_query', args: { kind: 'cells', dim: DIM, positions: [{ x: 1, y: 64, z: 0 }] } },
        ],
      });
      assert.ok(learned.ok, learned.ok ? '' : learned.error);
      const macro = SKILLS['macro:query_macro'];
      assert.ok(macro);
      assert.equal(macro.readOnly, true);

      const direct = await runSkill(ctx, macro, {});
      assert.equal(direct.status, 'succeeded');
      assert.equal(direct.data?.noop, true);
      const directSteps = direct.data?.stepResults as Record<string, unknown>[];
      assert.equal(directSteps.length, 2);
      const nodeEnvelope = rec(directSteps[0]!.data);
      const nodeItem = rec((rec(nodeEnvelope.data).items as unknown[])[0]);
      assert.equal(nodeItem.id, 'n-a');
      const cellItem = rec((rec(rec(directSteps[1]!.data).data).cells as unknown[])[0]);
      assert.equal(cellItem.observed, true);

      // 宏再被代码包一层：查询数据仍保留，整体仍是 noop。
      const behavior = { name: 'query-macro-code', description: '代码调用只读宏', steps: [], code: 'return await api.act("macro:query_macro", {});' };
      setBehaviorRegistry({ get: (name) => name === behavior.name ? behavior : undefined, list: () => [{ name: behavior.name }] });
      const wrapped = await useSkill.run(ctx, { name: behavior.name });
      assert.equal(wrapped.status, 'succeeded');
      assert.equal(wrapped.data?.noop, true);
      const returned = rec(wrapped.data?.result);
      assert.equal(returned.ok, true);
      assert.equal(rec(returned.data).noop, true);
      assert.equal((rec(returned.data).stepResults as unknown[]).length, 2);

      // 宏作为学习步骤的一步：只读步骤不增加物理完成数。
      const stepsBehavior = {
        name: 'query-macro-steps', description: '步骤里套只读宏', version: 1,
        steps: [
          { skill: 'macro:query_macro' },
          { skill: 'spatial_query', args: { kind: 'cells', dim: DIM, positions: [{ x: 0, y: 64, z: 0 }] } },
        ],
      };
      setBehaviorRegistry({ get: (name) => name === stepsBehavior.name ? stepsBehavior : undefined, list: () => [{ name: stepsBehavior.name }] });
      const stepped = await useSkill.run(ctx, { name: stepsBehavior.name });
      assert.equal(stepped.status, 'succeeded');
      assert.equal(stepped.data?.noop, true);
      assert.equal((stepped.data?.stepResults as unknown[]).length, 2);
      assert.ok(((rec((stepped.data?.stepResults as Record<string, unknown>[])[0]!.data).stepResults) as unknown[]).length >= 2);

      // 输入动作确实执行过，但效果未确认：不是 noop，也绝不能聚合成已确认的世界效果。
      adapter.inv.set('ender_pearl', 2);
      const inputMacro = library.learn({
        name: 'input_macro', description: '两次使用输入',
        steps: [
          { skill: 'use_item', args: { item: 'ender_pearl', on: 'self' } },
          { skill: 'use_item', args: { item: 'ender_pearl', on: 'self' } },
        ],
      });
      assert.ok(inputMacro.ok, inputMacro.ok ? '' : inputMacro.error);
      const inputOnly = await runSkill(ctx, SKILLS['macro:input_macro'], {});
      assert.equal(inputOnly.status, 'succeeded');
      assert.equal(inputOnly.data?.inputCompleted, true);
      assert.equal(inputOnly.data?.effectUnconfirmed, true);
      assert.notEqual(inputOnly.data?.noop, true, '输入已执行，不能记成空转');
      assert.deepEqual(adapter.actions.filter((a) => a === 'use:ender_pearl:self'), ['use:ender_pearl:self', 'use:ender_pearl:self']);

      // 显式 verified + changed 的物理子步骤仍然聚合成真实物理结果，不会因输入语义被降级。
      adapter.inv.set('water_bucket', 2);
      const physicalMacro = library.learn({
        name: 'physical_macro', description: '两次倒水',
        steps: [
          { skill: 'use_item', args: { item: 'water_bucket', on: { x: 3, y: 64, z: 0 } } },
          { skill: 'use_item', args: { item: 'water_bucket', on: { x: 3, y: 64, z: 1 } } },
        ],
      });
      assert.ok(physicalMacro.ok, physicalMacro.ok ? '' : physicalMacro.error);
      const physical = await runSkill(ctx, SKILLS['macro:physical_macro'], {});
      assert.equal(physical.status, 'succeeded');
      assert.notEqual(physical.data?.inputCompleted, true);
      assert.notEqual(physical.data?.effectUnconfirmed, true);
      assert.notEqual(physical.data?.noop, true, '确认改变世界的子步骤仍算物理结果');
      assert.deepEqual(adapter.actions.filter((a) => a === 'useBucket:water_bucket'), ['useBucket:water_bucket', 'useBucket:water_bucket']);
    });

    // ---- 所有分发都没有刷新共享证据或改写事实时间/会话 ----
    assert.equal(spatial.session.voxel.saveRevision, evidenceBefore.voxelRevision);
    assert.equal(facts.revision, evidenceBefore.factsRevision);
    assert.deepEqual(spatial.session.voxel.cellAt(DIM, 0, 64, 0), evidenceBefore.cell);
    assert.deepEqual(facts.checkpointSnapshot(), evidenceBefore.factsSnapshot);
    const base = facts.places({ worldId: WORLD, includeGone: true }).items.find((fact) => fact.id === 'n-a');
    assert.equal(base?.source.sessionId, SESSION);
    assert.equal(base?.observedAt, 12_345);
    const ore = facts.resources({ worldId: WORLD, includeGone: true }).items.find((fact) => fact.id === 'n-b');
    assert.equal(ore?.observedAt, 23_456);
    assert.equal(ore?.source.source, 'vision');

    await t.test('真实 BehaviorEngine：实际 use_skill 结果按 noop/输入/物理语义记账', async () => {
      const statsDir = mkdtempSync(join(tmpdir(), 'spatial-query-stats-'));
      const book = new SkillBook(null, statsDir);
      const engine = new BehaviorEngine(book, adapter, null, bus, { perceivedEntities: () => [], observeBlocks: () => [] }, join(statsDir, 'stats.json'));
      t.after(() => { engine.dispose(); rmSync(statsDir, { recursive: true, force: true }); });

      const register = (behavior: { name: string; description: string; body: string; code?: string; steps?: { skill: string; args?: unknown }[]; verify?: string }) => {
        assert.ok(engine.write(behavior, { by: 'mind' }).ok);
        setBehaviorRegistry({ get: (name) => name === behavior.name ? { ...behavior, steps: behavior.steps ?? [] } : undefined, list: () => [{ name: behavior.name }] });
      };
      // 实际执行 use_skill，再把真实结果交给 BehaviorEngine 的正式记账入口。
      const execute = async (behavior: { name: string }) => {
        const result = await useSkill.run(ctx, { name: behavior.name });
        engine.recordInvocation(behavior.name, result);
        return result;
      };

      // 1) 只读查询代码技能：noop 只计使用/跳过，不记成败、不晋升。
      const queryBehavior = { name: 'query-shaped-candidate', description: '只读查询验证', body: '只读取历史事实。',
        code: 'const r = await api.act("spatial_query", { kind: "nodes", dim: "overworld", limit: 1 }); return r;',
        verify: 'const s = await api.state(); return s.hp > 0 ? true : "dead";' };
      register(queryBehavior);
      const queryResult = await execute(queryBehavior);
      assert.equal(queryResult.status, 'succeeded', queryResult.summary);
      assert.equal(queryResult.data?.noop, true);
      const queryStats = engine.statsOf(queryBehavior.name)!;
      assert.equal(queryStats.uses, 1);
      assert.equal(queryStats.skipped, 1);
      assert.deepEqual(engine.currentStats(queryBehavior.name, true), { ok: 0, fail: 0 }, 'noop 不能成为物理成功证据');
      assert.ok(engine.list(true).some((b) => b.name === queryBehavior.name), '没有物理成功证据时仍是候选');
      assert.equal(engine.get(queryBehavior.name)?.candidate, true, '未被晋升为稳定版');

      // 2) 宏里的 use_item 输入已执行、效果未确认：不是 noop，也不能算成功。
      if (!SKILLS['macro:input_macro']) {
        adapter.inv.set('ender_pearl', 1);
        const learned = library.learn({ name: 'input_macro', description: '两次使用输入',
          steps: [
            { skill: 'use_item', args: { item: 'ender_pearl', on: 'self' } },
            { skill: 'use_item', args: { item: 'ender_pearl', on: 'self' } },
          ] });
        assert.ok(learned.ok, learned.ok ? '' : learned.error);
      }
      const inputBehavior = { name: 'input-only-macro', description: '宏只执行使用输入', body: '执行物品使用输入，不声称效果。',
        steps: [{ skill: 'macro:input_macro' }] };
      register(inputBehavior);
      const inputResult = await execute(inputBehavior);
      assert.equal(inputResult.status, 'succeeded', inputResult.summary);
      assert.equal(inputResult.data?.inputCompleted, true);
      assert.equal(inputResult.data?.effectUnconfirmed, true);
      assert.notEqual(inputResult.data?.noop, true, '输入确实执行过，不能当空转');
      const inputStats = engine.statsOf(inputBehavior.name)!;
      assert.equal(inputStats.uses, 1);
      assert.equal(inputStats.skipped ?? 0, 0);
      assert.deepEqual(engine.currentStats(inputBehavior.name, true), { ok: 0, fail: 0 }, '输入未确认不能晋升为成功');
      assert.equal(engine.get(inputBehavior.name)?.candidate, true);

      // 3) 真实物理对比：同一具身动作路径里 effectEvidence verified+changed，成功仍按成功记账。
      adapter.inv.set('water_bucket', 1);
      const physicalBehavior = { name: 'physical-shaped-candidate', description: '执行倒水并验证', body: '真实改变世界的物理动作。',
        code: 'const r = await api.act("use_item", { item: "water_bucket", on: { x: 6, y: 64, z: 0 } }); return r;',
        verify: 'const s = await api.state(); return s.hp > 0 ? true : "dead";' };
      register(physicalBehavior);
      const physicalResult = await execute(physicalBehavior);
      assert.equal(physicalResult.status, 'succeeded', physicalResult.summary);
      assert.notEqual(physicalResult.data?.noop, true);
      assert.notEqual(physicalResult.data?.effectUnconfirmed, true);
      assert.deepEqual(engine.currentStats(physicalBehavior.name, true), { ok: 1, fail: 0 }, '真实物理成功仍正常计入');
      assert.equal(engine.statsOf(physicalBehavior.name)!.skipped ?? 0, 0);
    });
  } finally {
    setBehaviorRegistry(null);
    for (const name of ['macro:query_macro', 'macro:input_macro', 'macro:physical_macro']) delete SKILLS[name];
    arbiter?.dispose();
    shutdown = await spatial.shutdown();
    assert.ok(shutdown !== null);
    assert.equal(shutdown.close?.completed, true, '真实 close 必须完成');
    assert.equal(shutdown.close?.error, null);
    assert.equal(shutdown.close?.unconfirmedRequest, false);
    assert.equal(shutdown.close?.dirty, false);
    memory.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
