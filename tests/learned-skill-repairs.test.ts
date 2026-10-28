import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { compileCheck, runSandboxed, VERIFY_METHODS, type SandboxHandler, type SandboxResult } from '../src/codeskills/sandbox.ts';
import { validateBehavior } from '../src/mind/behaviors.ts';
import { SKILLS } from '../src/skills/index.ts';
import { FakeAdapter } from './fake-adapter.ts';

type Repair = {
  name: string; expectedVersion: number; expectedHash: string; description?: string; body?: string;
  behavior: { code: string; verify: string; when?: unknown };
};
const directory = new URL('../maintenance/skill-repairs/2026-10-28/', import.meta.url);
const repairs = new Map(fs.readdirSync(directory).filter((name) => name.endsWith('.json')).map((name) => {
  const repair = JSON.parse(fs.readFileSync(new URL(name, directory), 'utf8')) as Repair;
  return [repair.name, repair];
}));
const state = { pos: { x: .5, y: 64, z: .5 }, feet: { x: 0, y: 64, z: 0 }, hp: 13, food: 18, oxygen: 20,
  onGround: true, inWater: false, inLava: false, facing: 'N', inventory: [] as { name: string; count: number }[], offHand: 'shield' };
const run = (name: string, args: unknown, handle: SandboxHandler, verify = false) => {
  const repair = repairs.get(name);
  assert.ok(repair, name);
  return runSandboxed(verify ? repair.behavior.verify : repair.behavior.code, args, handle, {
    signal: new AbortController().signal, deadline: Date.now() + 10_000,
  });
};
const resultOf = (outcome: SandboxResult) => {
  assert.equal(outcome.ok, true, outcome.error);
  assert.ok(outcome.result && typeof outcome.result === 'object' && !Array.isArray(outcome.result));
  return outcome.result as Record<string, unknown>;
};

/** A small palette can describe many cells; kinds is indexed by palette, never by cell. */
function region(bounds: unknown[], nameAt: (x: number, y: number, z: number) => string) {
  const [x1, y1, z1, x2, y2, z2] = bounds.map(Number);
  const size = [x2 - x1 + 1, y2 - y1 + 1, z2 - z1 + 1];
  const names = Array.from({ length: size[0] * size[1] * size[2] }, (_, i) =>
    nameAt(x1 + i % size[0], y1 + Math.floor(i / (size[0] * size[2])), z1 + Math.floor(i / size[0]) % size[2]));
  const palette = [...new Set(names)];
  const kinds = palette.map((name) => name === '?' ? 'unknown' : name === 'air' ? 'open' : ['water', 'lava'].includes(name) ? 'liquid' : 'solid');
  return { min: { x: x1, y: y1, z: z1 }, size, palette, kinds, data: names.map((name) => palette.indexOf(name)) };
}

test('十三份维护素材均有原始数据指纹、有效契约与静态通过的 code/verify', () => {
  assert.equal(repairs.size, 13);
  const adapter = new FakeAdapter();
  repairs.forEach((repair) => {
    assert.ok(Number.isInteger(repair.expectedVersion) && repair.expectedVersion > 0, repair.name);
    assert.match(repair.expectedHash, /^[a-f0-9]{64}$/, repair.name);
    const checked = validateBehavior({ name: repair.name, description: repair.description ?? repair.name, body: repair.body, ...repair.behavior }, adapter);
    assert.ok(!('error' in checked), `${repair.name}: ${'error' in checked ? checked.error : ''}`);
    assert.equal(compileCheck(repair.behavior.code), null, repair.name);
    assert.equal(compileCheck(repair.behavior.verify, { allowed: VERIFY_METHODS }), null, repair.name);
  });
});

test('移动恢复固定绝对目标，重新换算 step 相对参数，缺目标不走向世界原点', async () => {
  const name = 'goto-no-path-dig-through', calls: unknown[][] = [];
  let position = state;
  const target = { x: 1, y: 64, z: 0 };
  const restored = await run(name, { failure: { skill: 'step', target, args: { at: [1, 0, 0], facing: 'S', own: true } } }, async (method, values) => {
    if (method === 'state') return position;
    assert.equal(method, 'act'); calls.push(values);
    const request = values[1] as Record<string, unknown>;
    const parsed = SKILLS.step.validate(request, new FakeAdapter());
    assert.ok(parsed.ok, JSON.stringify(parsed));
    assert.deepEqual(request.at, [0, 0, 1]);
    assert.equal(request.facing, 'N');
    assert.equal(request.own, true);
    position = { ...state, pos: { x: 1.5, y: 64, z: .5 }, feet: target };
    return { ok: true };
  });
  assert.equal(resultOf(restored).retried, 'step');
  assert.equal(calls.length, 1);
  const skipped = await run(name, { failure: { skill: 'step', args: { at: [1, 0, 0] } } }, async () => { throw new Error('不得移动'); });
  assert.match(String(resultOf(skipped).skipped), /绝对/);
});

test('defend 恢复不换怪或同名ID，回执不把左键当击杀', async () => {
  const name = 'defend-not-found-look-around';
  const zombie = { how: 'seen', id: 2, name: 'zombie', kind: 'hostile', dist: 2, pos: { x: 2, y: 64, z: 0 } };
  const skipped = await run(name, { failure: { args: { target: 'skeleton' } } }, async (method) => {
    assert.equal(method, 'entities'); return [zombie];
  });
  assert.match(String(resultOf(skipped).skipped), /原目标/);
  const hits: unknown[][] = [];
  let sent = false;
  const fought = await run(name, { failure: { args: { target: 'zombie', entityId: 2 } } }, async (method, values) => {
    if (method === 'state') return state;
    if (method === 'entities') return sent ? [{ ...zombie, id: 3 }] : [zombie];
    assert.equal(method, 'act'); hits.push(values); sent = true;
    return { ok: true, data: { targetId: 2, sent: 1, healthDrops: 0, targetVisible: false } };
  });
  assert.deepEqual(hits, [['hit_entity', { entity: 2, hits: 1 }]]);
  assert.equal(resultOf(fought).defeatVerified, false);
});

test('堵水恢复不挖默认脚底，原目标重挖正确换算且不升级 wet 许可', async () => {
  const name = 'plug-water-around-pit-before-dig';
  const missing = await run(name, { failure: { skill: 'dig_at', args: { at: [1, 0, 0] } } }, async (method) => {
    assert.equal(method, 'state'); return state;
  });
  assert.match(String(resultOf(missing).skipped), /绝对目标/);
  let dug = false;
  const calls: unknown[][] = [];
  const target = { x: 1, y: 64, z: 0 };
  const restored = await run(name, { allowPlace: true, failure: { skill: 'dig_at', target, args: { at: [1, 0, 0], facing: 'S', own: true, wet: false } } }, async (method, values) => {
    if (method === 'state') return { ...state, inventory: [{ name: 'cobblestone', count: 8 }] };
    if (method === 'blockAt') return { name: dug && values.join(',') === '1,64,0' ? 'air' : 'stone', kind: dug && values.join(',') === '1,64,0' ? 'open' : 'solid' };
    if (method === 'sleep') return { ok: true };
    assert.equal(method, 'act'); calls.push(values);
    const request = values[1] as Record<string, unknown>;
    assert.deepEqual(request.at, [0, 0, 1]); assert.equal(request.facing, 'N');
    assert.equal(request.wet, false); assert.equal(request.own, true);
    assert.ok(SKILLS.dig_at.validate(request, new FakeAdapter()).ok);
    dug = true; return { ok: true };
  });
  assert.deepEqual(resultOf(restored).at, [1, 64, 0]);
  assert.equal(calls.length, 1);
});

test('竖井停顿不会触发 stall 引用错误，每次只挖脚下一格', async () => {
  let reads = 0, digs = 0;
  const outcome = await run('dig-shaft-down-to-y', { y: 63 }, async (method, values) => {
    if (method === 'state') { reads++; const y = reads >= 3 ? 63 : 64; return { ...state, pos: { x: .5, y, z: .5 }, feet: { x: 0, y, z: 0 } }; }
    if (method === 'blockAt') return { name: 'stone', kind: 'solid' };
    if (method === 'digAt') { assert.deepEqual(values.slice(0, 3), [0, 63, 0]); digs++; return { ok: true }; }
    if (method === 'drops') return [];
    assert.equal(method, 'sleep'); return { ok: true };
  });
  assert.equal(resultOf(outcome).y, 63); assert.equal(digs, 2);
});

test('采矿素材不把 unknown 当矿石、支撑或浇水站位，count 是新增量', async () => {
  for (const name of ['mine-nearby-iron-ore', 'mine-obsidian-at-water-edge']) {
    const actions: string[] = [];
    const outcome = await run(name, { count: 2 }, async (method, values) => {
      if (method === 'state') return { ...state, inventory: [{ name: 'raw_iron', count: 3 }, { name: 'diamond_pickaxe', count: 1 }, { name: 'water_bucket', count: 1 }] };
      if (method === 'region') return region(values, () => '?');
      if (method === 'blockAt') return { name: null, kind: 'unknown' };
      if (method === 'equip') return { ok: true };
      actions.push(method); throw new Error(`未知地形不应执行 ${method}`);
    });
    assert.equal(outcome.ok, false, name);
    assert.deepEqual(actions, [], name);
  }
  const checked = await run('mine-nearby-iron-ore', { args: { count: 2 }, before: { inventory: [{ name: 'raw_iron', count: 3 }] } }, async () => ({ inventory: [{ name: 'raw_iron', count: 3 }] }), true);
  assert.match(String(checked.result), /新增 0\/2/);
});

test('黑曜石素材解码小palette，按可见岸边原方法采集并核对新增量', async () => {
  let pos = state.pos, poured = false, dug = false, collected = false;
  const outcome = await run('mine-obsidian-at-water-edge', { count: 1 }, async (method, values) => {
    if (method === 'state') return { ...state, pos, feet: { x: Math.floor(pos.x), y: pos.y, z: Math.floor(pos.z) },
      inventory: [{ name: 'diamond_pickaxe', count: 1 }, { name: 'water_bucket', count: 1 }, ...(collected ? [{ name: 'obsidian', count: 1 }] : [])] };
    if (method === 'region') return region(values, (x, y, z) => x === 3 && y === 63 && z === 0 ? 'lava' : y < 64 ? 'stone' : 'air');
    if (method === 'equip' || method === 'lookAt' || method === 'sleep') return { ok: true };
    if (method === 'moveTo') { pos = { x: Number(values[0]), y: Number(values[1]), z: Number(values[2]) }; if (dug) collected = true; return { ok: true }; }
    if (method === 'act') { assert.deepEqual(values, ['use_item', { item: 'water_bucket', on: 'lava' }]); poured = true; return { ok: true }; }
    if (method === 'blockAt') return { name: dug ? 'air' : poured ? 'obsidian' : 'lava', kind: dug ? 'open' : poured ? 'solid' : 'liquid' };
    if (method === 'digAt') { assert.deepEqual(values.slice(0, 3), [3, 63, 0]); dug = true; return { ok: true }; }
    assert.equal(method, 'drops'); return [{ item: 'obsidian', pos: { x: 3, y: 63, z: 0 }, dist: 2 }];
  });
  assert.equal(resultOf(outcome).made, 1);
});

test('战斗素材听到而未看见时不读 pos/id，挥击次数不伪装为击杀或位移', async () => {
  for (const name of ['shield-up-against-shooters', 'counter-melee-at-low-hp']) {
    const outcome = await run(name, {}, async (method) => {
      if (method === 'state') return state;
      assert.equal(method, 'entities'); return [{ how: 'heard', name: 'zombie', kind: 'hostile', dir: 'N', dist: 4 }];
    });
    assert.match(String(resultOf(outcome).skipped), /未看见/);
  }
  let attacked = false;
  const outcome = await run('shield-up-against-shooters', {}, async (method) => {
    if (method === 'state') return state;
    if (method === 'entities') return attacked ? [] : [{ how: 'seen', id: 7, name: 'skeleton', kind: 'hostile', dist: 2, pos: { x: 2, y: 64, z: 0 } }];
    if (method === 'attack') attacked = true;
    return { ok: true };
  });
  assert.equal(resultOf(outcome).hits, 1); assert.equal(resultOf(outcome).moved, 0);
});

test('放船只右键现有船，不自动制作、拾取、乘坐或行驶', async () => {
  const name = 'place-boat-at-shore-water', actions: unknown[][] = [];
  let placed = false, feet = state.feet;
  const before = { ...state, inventory: [{ name: 'oak_boat', count: 1 }] };
  const handle: SandboxHandler = async (method, values) => {
    if (method === 'state') return { ...state, feet, pos: { x: feet.x + .5, y: feet.y, z: feet.z + .5 }, inventory: placed ? [] : before.inventory };
    if (method === 'region') return region(values, (x, y) => y < 63 ? 'stone' : y === 63 ? x >= 1 ? 'water' : 'stone' : 'air');
    if (method === 'moveTo') { feet = { x: Math.floor(Number(values[0])), y: Number(values[1]), z: Math.floor(Number(values[2])) }; return { ok: true }; }
    if (method === 'lookAt' || method === 'sleep') return { ok: true };
    if (method === 'entities') return placed ? [{ how: 'seen', id: 91, name: 'boat', kind: 'other', dist: 2, pos: { x: 1.5, y: 63, z: .5 } }] : [];
    if (method === 'blockAt') return { name: 'water', kind: 'liquid' };
    assert.equal(method, 'act');
    assert.ok(SKILLS.interact_block.validate(values[1], new FakeAdapter()).ok, '放船仍使用实际支持的方块交互契约');
    actions.push(values); placed = true; return { ok: true };
  };
  const outcome = await run(name, {}, handle);
  const result = resultOf(outcome);
  assert.equal(actions.length, 1); assert.equal(actions[0][0], 'interact_block');
  assert.equal((actions[0][1] as { item: string }).item, 'oak_boat');
  const checked = await run(name, { before, result }, handle, true);
  assert.equal(checked.result, true);
  const missing = await run(name, {}, async (method) => { assert.equal(method, 'state'); return state; });
  assert.equal(missing.ok, false); assert.match(missing.error!, /没有原有的船/);
});

test('换视野搜索只查调用方目标，在指定范围内一次移动，未找到明确报告', async () => {
  let x = .5;
  const actions: unknown[][] = [];
  const outcome = await run('look-around-not-found-expand-search', { target: 'cow', direction: 'E', distance: 24 }, async (method, values) => {
    if (method === 'state') return { ...state, pos: { ...state.pos, x } };
    assert.equal(method, 'act'); actions.push(values);
    if (values[0] === 'goto') { x += 24; return { ok: true }; }
    return { ok: false, code: 'NOT_FOUND', summary: '未见 cow' };
  });
  assert.equal(resultOf(outcome).ok, false);
  assert.deepEqual(actions, [['look_around', { for: 'cow', seconds: 2 }], ['goto', { target: 'E 24' }], ['look_around', { for: 'cow', seconds: 2 }]]);
});

test('进食保持六种触发食物，满食不触发，食物减少不能替代真实恢复', async () => {
  const name = 'eat-to-recover-when-hurt', when = repairs.get(name)!.behavior.when as { food_below: number; any: { has: { item: string } }[] };
  assert.equal(when.food_below, 20);
  assert.deepEqual(when.any.map((condition) => condition.has.item), ['mutton', 'beef', 'cooked_beef', 'cooked_mutton', 'bread', 'baked_potato']);
  const noGain = await run(name, { before: { food: 18, hp: 8 }, result: { ate: 1 } }, async () => ({ food: 18, hp: 8 }), true);
  assert.match(String(noGain.result), /都未增加/);
  const fed = await run(name, { before: { food: 18, hp: 8 }, result: { ate: 1 } }, async () => ({ food: 20, hp: 8 }), true);
  assert.equal(fed.result, true);
});

test('离开岩浆进入水可验收，阶梯局部44格空列不能验收为天空', async () => {
  const escaped = await run('escape-lava-by-pillar', {}, async () => ({ hp: 8, inLava: false, inWater: true }), true);
  assert.equal(escaped.result, true);
  let stepped = false;
  const steps: unknown[][] = [];
  const stairs = await run('dig-stairway-up-to-sky', {}, async (method, values) => {
    if (method === 'state') return { ...state, feet: stepped ? { x: 0, y: 65, z: -1 } : state.feet };
    if (method === 'region') return region(values, () => stepped ? 'air' : 'stone');
    if (method === 'stepTo') { stepped = true; steps.push(values); return { ok: true }; }
    assert.equal(method, 'digAt', '正确解码实心支撑，不应额外垫块'); return { ok: true };
  });
  assert.deepEqual(steps, [[0, 65, -1]], 'N缩写仍朝北，不回退朝南');
  assert.equal(resultOf(stairs).ok, false);
  assert.match(String(resultOf(stairs).limitation), /天空|见天/);
});
