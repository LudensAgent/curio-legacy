import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorldMemory } from '../src/memory/store.ts';
import { Executive } from '../src/brain/executive.ts';
import { lightSystemPrompt, lightUserPrompt, type PlanContext } from '../src/planner/prompt.ts';
import { pickupItems } from '../src/skills/survival.ts';
import type { SkillCtx } from '../src/skills/types.ts';

function context(): PlanContext {
  return { reason: 'no_goal', current: null, lastFailure: null, userSuggestion: null,
    percept: { self: { pos: [0, 64, 0], dim: 'overworld', hp: 20, food: 20, inWater: false, inLava: false },
      inventory: [], emptySlots: 30, nearby: { resources: [], passive: [], hostile: [], players: [] },
      time: { timeOfDay: 1000, phase: 'day' }, learn_candidates: [{ steps: 'gather:log → craft:oak_planks', times: 2 }] } as any };
}
const payload = (text: string) => JSON.parse(text.slice(text.indexOf('\n') + 1, text.lastIndexOf('\n')));

test('a named walking destination blocked by water can suggest a boat using the resolved target coordinates', () => {
  const self = { d: { adapter: { state: () => ({ inventory: [], food: 20, inWater: false }) } } };
  const repairSteps = (Executive.prototype as any).repairSteps;
  const steps = repairSteps.call(self, { task: { skill: 'goto', args: { target: 'base' } },
    result: { status: 'failed', failureCode: 'PATH_NOT_FOUND', summary: '眼前没有陆地落脚点',
      data: { waterAhead: true, target: { x: 123, y: 64, z: -45 } } } });
  assert.equal(steps?.[0].skill, 'boat');
  assert.deepEqual(steps[0].args.to, { x: 123, z: -45 });
});

test('small decisions retain actionable archive defects and pickup facts within a bounded result payload', (t) => {
  const memory = new WorldMemory(null); t.after(() => memory.close());
  const ctx = context();
  const pos = { x: -224, y: 87, z: 11 };
  ctx.results = [
    { skill: 'gather', status: 'failed', data: { shortfall: '木料还差约 2 块原木', missingMaterials: { oak_planks: 8 } } },
    { skill: 'pickup_items', status: 'failed', failureCode: 'NOT_FOUND', data: { collected: 0, gained: [], blockTarget: { name: 'white_bed', pos } } },
    { skill: 'building_archive', status: 'succeeded', summary: '作品档案', data: { project: {
      id: 'known-project', status: 'incomplete', origin: pos, dimension: 'overworld',
      versions: [{ version: 1, spec: 'HUGE_DESIGN'.repeat(10000) }],
      inspections: [{ complete: false, checked: 200, defects: Array.from({ length: 100 }, () => ({ cellId: 'clear:0,0,0', pos,
        kind: 'obstruction', actual: 'cobblestone', expected: 'air' })) }],
    } } },
  ];
  const result = payload(lightUserPrompt(ctx, memory)).last_results;
  assert.equal(result.length, 3);
  assert.equal(result[0].data.shortfall, '木料还差约 2 块原木');
  assert.equal(result[1].failureCode, 'NOT_FOUND');
  assert.equal(result[1].data.collected, 0);
  assert.deepEqual(result[1].data.blockTarget.pos, pos);
  assert.equal(result[2].data.project.historical, true);
  assert.equal(result[2].data.inspection.defectCount, 100);
  assert.deepEqual(result[2].data.inspection.defects[0].pos, pos);
  assert.equal(result[2].data.inspection.defects.length, 3);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 4800);
  assert.ok(result.every((r: any) => !r.data || Buffer.byteLength(JSON.stringify(r.data)) <= 1800));
  assert.doesNotMatch(JSON.stringify(result), /HUGE_DESIGN/);
});

test('routine decisions keep general inputs and current evidence, with learning and workflow context available on demand', (t) => {
  const memory = new WorldMemory(null); t.after(() => memory.close());
  const ctx = context();
  ctx.mySkills = [{ name: 'trial:wood:v1', status: 'candidate', description: '木料组合' }];
  const body = payload(lightUserPrompt(ctx, memory));
  assert.equal(body.state.learn_candidates, undefined);
  assert.equal(body.my_skills, undefined);
  const system = lightSystemPrompt('player');
  assert.match(system, /不会为赶路拆墙、挖地或垫高/);
  assert.match(system, /^- dig .*target/m);
  assert.match(system, /^- interact_block /m);
  assert.match(system, /^- ride /m);
  assert.doesNotMatch(system, /white_bed|^- boat |^- experiment_method /m);
  assert.match(system, /need_full_context/);
});

test('targeted pickup requires a real inventory increase; an optional empty sweep remains harmless', async () => {
  const pos = { x: 2, y: 64, z: 0 };
  for (const [item, increase, expected] of [
    ['white_bed', undefined, 'failed'],
    ['white_bed', 'dirt', 'failed'],
    ['white_bed', 'white_bed', 'succeeded'],
    [undefined, undefined, 'succeeded'],
  ] as const) {
    let reads = 0;
    const ctx = { adapter: { state: () => ({ inventory: ++reads > 1 && increase ? [{ name: increase, count: 1 }] : [] }) },
      senses: { refresh() {}, perceivedEntities: () => [], knownBlocks: () => [{ name: 'white_bed', pos }] },
      signal: new AbortController().signal, deadline: Date.now() + 1000, progress() {} } as unknown as SkillCtx;
    const result = await pickupItems.run(ctx, { radius: 8, ...(item ? { item } : {}) });
    assert.equal(result.status, expected);
    assert.equal(result.data?.collected, increase === item && item ? 1 : 0);
    if (expected === 'failed') {
      assert.equal(result.failureCode, 'NOT_FOUND');
      assert.deepEqual((result.data?.blockTarget as any).pos, pos);
      assert.match(result.summary, /先精确挖下该方块/);
    }
  }
});
