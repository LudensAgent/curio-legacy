import assert from 'node:assert/strict';
import { test } from 'node:test';
import { placeAt, primitiveSkills, stepTo } from '../src/skills/primitives.ts';
import { DEFAULT_VISION, Vision } from '../src/perception/vision.ts';
import { makeBridge } from '../src/codeskills/bridge.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx, observeAllBlocks } from './survival-helpers.ts';

test('a downward step reports the selected support cell without revealing an unseen block', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.removed.add('1,63,0');
  w.removed.add('1,62,0');
  let seeFloor = false;
  const ctx = makeCtx(w, { senses: { observeBlocks: (positions) => positions.filter((pos) => seeFloor || pos.y !== 62).map((pos) => ({
    name: w.blockAt(pos), pos, properties: {}, worldId: w.worldId, sessionId: w.sessionId,
    dimension: w.dim, observationId: 1, observedAt: Date.now(), source: 'vision' as const,
  })) } });
  t.after(() => ctx.memory.close());
  const move = t.mock.method(w, 'moveTo', async () => {});
  const bridge = makeBridge(ctx);
  const hidden = await bridge('stepTo', [1, 63, 0]) as { ok: boolean; summary: string; data: { landingSupport: { pos: unknown; observed: string | null } } };
  assert.equal(hidden.ok, false);
  assert.match(hidden.summary, /脚下 \(1,62,0\) 是 未看清的格子/);
  assert.deepEqual(hidden.data.landingSupport, { pos: { x: 1, y: 62, z: 0 }, at: [0, -2, 1], placeAtInRange: false, observed: null });
  assert.match(hidden.summary, /支撑格 \[0,-2,1\] 超出 place_at 上下 -1\.\.3 范围/);
  assert.match(hidden.summary, /脚部目标格 \[0,-1,1\] 须留空/);
  assert.equal(move.mock.callCount(), 0);

  seeFloor = true;
  const visible = await stepTo.run(ctx, { at: [1, -1, 0], facing: 'E' });
  assert.match(visible.summary, /脚下 \(1,62,0\) 是 air/);
  assert.deepEqual(visible.data?.landingSupport, { pos: { x: 1, y: 62, z: 0 }, at: [1, -2, 0], placeAtInRange: false, observed: 'air' });
  assert.match(visible.summary, /支撑格 \[1,-2,0\] 超出 place_at 上下 -1\.\.3 范围/);
  assert.equal(placeAt.validate({ at: [1, -2, 0], facing: 'E', item: 'cobblestone' }, w).ok, false);
  assert.equal(primitiveSkills.find((skill) => skill.name === 'place_at')!.validate({ xyz: [1, 62, 0], item: 'cobblestone' }, w).ok, false,
    'the reported placement range also applies to absolute targets');
  assert.equal(move.mock.callCount(), 0);
});

test('support feedback identifies the floor to fill while keeping the selected foot cell empty', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.speed = 100000;
  w.removed.add('0,63,-1');
  w.removed.add('0,62,-1');
  w.inv.set('cobblestone', 1);
  const ctx = makeCtx(w, { senses: { observeBlocks: (positions) => positions.map((pos) => ({
    name: w.blockAt(pos), pos, properties: {}, worldId: w.worldId, sessionId: w.sessionId,
    dimension: w.dim, observationId: 1, observedAt: Date.now(), source: 'vision' as const,
  })) } });
  t.after(() => ctx.memory.close());
  const blocked = await stepTo.run(ctx, { at: [1, 0, 0], facing: 'N' });
  assert.equal(blocked.status, 'failed');
  assert.deepEqual(blocked.data?.landingSupport, { pos: { x: 0, y: 63, z: -1 }, at: [1, -1, 0], placeAtInRange: true, observed: 'air' });
  assert.match(blocked.summary, /支撑格 \[1,-1,0\]；脚部目标格 \[1,0,0\] 须留空/);
  assert.deepEqual(w.actions, [], 'reporting a missing floor does not move or spend blocks');
  assert.equal(w.inv.get('cobblestone'), 1);
  const placed = await placeAt.run(ctx, { at: [1, -1, 0], facing: 'N', item: 'cobblestone' });
  assert.equal(placed.status, 'succeeded', placed.summary);
  const wrongHeight = await stepTo.run(ctx, { at: [1, -1, 0], facing: 'N' });
  assert.equal(wrongHeight.status, 'failed');
  assert.match(wrongHeight.summary, /目标格是 cobblestone/);
  const entered = await stepTo.run(ctx, { at: [1, 0, 0], facing: 'N' });
  assert.equal(entered.status, 'succeeded', entered.summary);
  assert.deepEqual(w.pos, { x: 0.5, y: 64, z: -0.5 });
});

test('step does not auto-fill a shallow air gap; it reports the missing support without spending blocks', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.speed = 100000;
  w.removed.add('0,63,-1'); // 浅坑：目标格脚下是空气、再下面一格是实心
  w.inv.set('cobblestone', 1);
  const ctx = makeCtx(w, { senses: { observeBlocks: (positions) => positions.map((pos) => ({
    name: w.blockAt(pos), pos, properties: {}, worldId: w.worldId, sessionId: w.sessionId,
    dimension: w.dim, observationId: 1, observedAt: Date.now(), source: 'vision' as const,
  })) } });
  t.after(() => ctx.memory.close());
  const blocked = await stepTo.run(ctx, { at: [1, 0, 0], facing: 'N' });
  assert.equal(blocked.status, 'failed', blocked.summary);
  assert.equal(blocked.data?.movementNotAttempted, true);
  assert.match(blocked.summary, /无已确认支撑/);
  assert.deepEqual(w.actions, [], 'pure step must not place a scaffold or move');
  assert.equal(w.inv.get('cobblestone'), 1, 'pure step must not spend blocks');
  // 显式 place_at 之后，step 才迈得过去
  const placed = await placeAt.run(ctx, { at: [1, -1, 0], facing: 'N', item: 'cobblestone' });
  assert.equal(placed.status, 'succeeded', placed.summary);
  const stepped = await stepTo.run(ctx, { at: [1, 0, 0], facing: 'N' });
  assert.equal(stepped.status, 'succeeded', stepped.summary);
  assert.deepEqual(w.pos, { x: 0.5, y: 64, z: -0.5 });
  assert.equal(w.inv.get('cobblestone'), 0, 'the explicit place_at spends the block');
});

test('step rejects partial diagonal movement and reports actual location', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = makeCtx(w, { senses: { observeBlocks: observeAllBlocks(w) } });
  t.after(() => ctx.memory.close());
  const move = t.mock.method(w, 'moveTo', async () => { w.pos = { x: 1.5, y: 64, z: 0.5 }; });
  const r = await stepTo.run(ctx, { at: [1, 0, 1], facing: 'E' });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'EFFECT_NOT_CONFIRMED');
  assert.deepEqual(r.data?.targetCell, { x: 1, y: 64, z: 1 });
  assert.deepEqual(r.data?.position, { x: 1.5, y: 64, z: 0.5 });
  assert.equal(move.mock.callCount(), 1);
});

test('step confirms position even when movement resolves or rejects', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  const ctx = makeCtx(w, { senses: { observeBlocks: observeAllBlocks(w) } });
  t.after(() => ctx.memory.close());
  const move = t.mock.method(w, 'moveTo', async () => {});
  assert.equal((await stepTo.run(ctx, { at: [1, 0, 0], facing: 'E' })).status, 'failed');
  move.mock.mockImplementation(async () => { throw new Error('No path'); });
  assert.equal((await stepTo.run(ctx, { at: [1, 0, 0], facing: 'E' })).status, 'failed');
  move.mock.mockImplementation(async () => { w.pos = { x: 1.5, y: 64, z: 0.5 }; throw new Error('No path'); });
  assert.equal((await stepTo.run(ctx, { at: [1, 0, 0], facing: 'E' })).status, 'succeeded');
  move.mock.mockImplementation(async () => { throw Object.assign(new Error('cancelled'), { name: 'AbortedError' }); });
  await assert.rejects(stepTo.run(ctx, { at: [1, 0, 0], facing: 'E' }), { name: 'AbortedError' });
});

test('step looks at the selected obstruction without changing the target or digging', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.blocks.push({ name: 'stone', pos: { x: 1, y: 64, z: 0 } });
  let looked = false;
  const ctx = makeCtx(w, { senses: { observeBlocks: (positions) => looked ? positions.map((pos) => ({
    name: w.blockAt(pos), pos, properties: {}, worldId: w.worldId, sessionId: w.sessionId,
    dimension: w.dim, observationId: 1, observedAt: Date.now(), source: 'vision' as const,
  })) : [] } });
  t.after(() => ctx.memory.close());
  const look = t.mock.method(w, 'look', async () => { looked = true; });
  const move = t.mock.method(w, 'moveTo', async () => {});
  const dig = t.mock.method(w, 'dig', async () => ({ ok: true }));
  const r = await stepTo.run(ctx, { at: [1, 0, 0], facing: 'E' });
  assert.equal(r.status, 'failed');
  assert.match(r.summary, /stone/);
  assert.deepEqual(r.data?.targetCell, { x: 1, y: 64, z: 0 });
  assert.equal(look.mock.callCount(), 1);
  assert.equal(move.mock.callCount(), 0);
  assert.equal(dig.mock.callCount(), 0);
});

test('step keeps an obstructed target unknown if looking does not reveal it', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.blocks.push({ name: 'stone', pos: { x: 1, y: 64, z: 0 } });
  const ctx = makeCtx(w, { senses: { observeBlocks: () => [] } });
  t.after(() => ctx.memory.close());
  const look = t.mock.method(w, 'look', async () => {});
  const r = await stepTo.run(ctx, { at: [1, 0, 0], facing: 'E' });
  assert.equal(r.status, 'failed');
  assert.doesNotMatch(r.summary, /stone/);
  assert.equal(look.mock.callCount(), 1);
});

test('ladder step rejects a higher position in a different column', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.blocks.push({ name: 'ladder', pos: { x: 0, y: 64, z: 0 } });
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  t.mock.method(w, 'moveTo', async () => { w.pos = { x: 1.5, y: 65, z: 0.5 }; });
  const r = await stepTo.run(ctx, { at: [0, 1, 0], facing: 'N' });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'EFFECT_NOT_CONFIRMED');
  assert.deepEqual(r.data?.targetCell, { x: 0, y: 65, z: 0 });
});

test('water step does not claim to land on the selected bank when it lands adjacent', async (t) => {
  const w = new FakeAdapter();
  w.groundY = 59;
  w.pos = { x: 0.5, y: 62.4, z: 0.5 };
  w.inWater = true;
  w.blocks.push({ name: 'stone', pos: { x: 1, y: 63, z: 0 } });
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  t.mock.method(w, 'swimTo', async () => { w.pos = { x: 1.5, y: 64, z: 1.5 }; w.inWater = false; return { ok: true, landed: true, oxygen: 20 }; });
  const r = await stepTo.run(ctx, { at: [1, 0, 0], facing: 'E' });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'EFFECT_NOT_CONFIRMED');
  assert.deepEqual(r.data?.targetCell, { x: 1, y: 64, z: 0 });
  assert.deepEqual(r.data?.position, { x: 1.5, y: 64, z: 1.5 });
});

test('an upward step turns to confirm its own head space before moving', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.speed = 100000;
  w.blocks.push({ name: 'stone', pos: { x: 1, y: 64, z: 0 } }); // 目标脚格下方可站立的支撑
  const vision = new Vision(w);
  const ownHead = { x: 0, y: 66, z: 0 };
  const observations: { positions: { x: number; y: number; z: number }[]; out: ReturnType<Vision['observeBlocks']> }[] = [];
  const looks: { yaw: number; pitch: number }[] = [];
  let sawOwnHead = false, ownHeadBeforeMove = false;
  const ctx = makeCtx(w, { senses: {
    refresh: () => vision.refresh(),
    markSweep: () => vision.markSweep(),
    observeBlocks: (positions) => {
      const out = vision.observeBlocks(positions);
      observations.push({ positions: positions.map((p) => ({ ...p })), out });
      if (out.some((b) => b.pos.x === ownHead.x && b.pos.y === ownHead.y && b.pos.z === ownHead.z)) sawOwnHead = true;
      return out;
    },
  } });
  t.after(() => ctx.memory.close());
  assert.deepEqual(vision.observeBlocks([ownHead]), [], 'own head starts outside the actual view cone');
  const originalLook = w.look.bind(w);
  t.mock.method(w, 'look', async (yaw: number, pitch: number) => {
    looks.push({ yaw, pitch });
    return originalLook(yaw, pitch);
  });
  const moves: unknown[] = [];
  const originalMove = w.moveTo.bind(w);
  t.mock.method(w, 'moveTo', async (target, opts) => {
    ownHeadBeforeMove = sawOwnHead;
    moves.push(target);
    return originalMove(target, opts);
  });
  const r = await stepTo.run(ctx, { at: [1, 1, 0], facing: 'E' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.deepEqual(r.data?.targetCell, { x: 1, y: 65, z: 0 });
  assert.deepEqual(w.pos, { x: 1.5, y: 65, z: 0.5 });
  assert.equal(moves.length, 1, 'the step moved once to the selected cell');
  assert.ok(sawOwnHead, 'the step actually observed its own overhead cell');
  assert.ok(ownHeadBeforeMove, 'that observation happened before movement');
  assert.ok(looks.some((l) => l.pitch > 1.2), 'the step turned upward to look at its own head space');
  const read = observations.find((o) => o.positions.length === 1 && o.positions[0].x === ownHead.x && o.positions[0].y === ownHead.y && o.positions[0].z === ownHead.z);
  assert.ok(read, 'the upward turn was followed by a bounded reread of that cell');
  assert.deepEqual(read.out.map((b) => b.name), ['air']);
  assert.deepEqual(w.actions.filter((a) => a.startsWith('dig')), []);
});

test('an upward step stays unknown when the overhead turn reveals nothing', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.blocks.push({ name: 'stone', pos: { x: 1, y: 64, z: 0 } });
  const vision = new Vision(w);
  const ownHead = { x: 0, y: 66, z: 0 };
  const observations: { positions: { x: number; y: number; z: number }[]; out: ReturnType<Vision['observeBlocks']> }[] = [];
  const ctx = makeCtx(w, { senses: {
    refresh: () => vision.refresh(),
    markSweep: () => vision.markSweep(),
    observeBlocks: (positions) => {
      const out = vision.observeBlocks(positions);
      observations.push({ positions: positions.map((p) => ({ ...p })), out });
      return out;
    },
  } });
  t.after(() => ctx.memory.close());
  assert.deepEqual(vision.observeBlocks([ownHead]), [], 'own head starts outside the actual view cone');
  let overheadLookAttempted = false;
  const originalLook = w.look.bind(w);
  t.mock.method(w, 'look', async (yaw: number, pitch: number) => {
    if (pitch > 1.2) { overheadLookAttempted = true; return; } // 只压制竖直头顶这一转，其余目标转头照常生效
    return originalLook(yaw, pitch);
  });
  const move = t.mock.method(w, 'moveTo', async () => {});
  const dig = t.mock.method(w, 'dig', async () => ({ ok: true }));
  const r = await stepTo.run(ctx, { at: [1, 1, 0], facing: 'E' });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'PATH_NOT_FOUND');
  assert.match(r.summary, /未看清的格子/);
  assert.match(r.summary, /无法确认跳跃空间/);
  assert.ok(overheadLookAttempted, 'the step actually tried to turn upward');
  const read = observations.find((o) => o.positions.length === 1 && o.positions[0].x === ownHead.x && o.positions[0].y === ownHead.y && o.positions[0].z === ownHead.z);
  assert.ok(read, 'the step reread its own head cell after the turn');
  assert.deepEqual(read.out, [], 'actual Vision still returns nothing for it');
  assert.equal(move.mock.callCount(), 0);
  assert.equal(dig.mock.callCount(), 0);
  assert.deepEqual(w.actions, []);
  assert.doesNotMatch(r.summary, /头顶上方是 (air|stone)/);
});

test('an observed solid overhead blocker stops the upward step with its actual name', async (t) => {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  w.blocks.push({ name: 'stone', pos: { x: 1, y: 64, z: 0 } });
  w.blocks.push({ name: 'stone', pos: { x: 0, y: 66, z: 0 } }); // 只有转头后才会进入实际视野的头顶实心块
  // 收窄水平视锥：目标列抬头时不会顺带看到头顶块的近角，必须单独竖直转头才能看见。
  const vision = new Vision(w, { ...DEFAULT_VISION, hFov: 60 });
  const ownHead = { x: 0, y: 66, z: 0 };
  const observations: { positions: { x: number; y: number; z: number }[]; out: ReturnType<Vision['observeBlocks']> }[] = [];
  const ctx = makeCtx(w, { senses: {
    refresh: () => vision.refresh(),
    markSweep: () => vision.markSweep(),
    observeBlocks: (positions) => {
      const out = vision.observeBlocks(positions);
      observations.push({ positions: positions.map((p) => ({ ...p })), out });
      return out;
    },
  } });
  t.after(() => ctx.memory.close());
  assert.deepEqual(vision.observeBlocks([ownHead]), [], 'own head starts outside the actual view cone');
  let turnedUp = false;
  const originalLook = w.look.bind(w);
  t.mock.method(w, 'look', async (yaw: number, pitch: number) => {
    if (pitch > 1.2) turnedUp = true;
    return originalLook(yaw, pitch);
  });
  const move = t.mock.method(w, 'moveTo', async () => {});
  const dig = t.mock.method(w, 'dig', async () => ({ ok: true }));
  const r = await stepTo.run(ctx, { at: [1, 1, 0], facing: 'E' });
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'PATH_NOT_FOUND');
  assert.match(r.summary, /头顶上方是 stone/);
  assert.ok(turnedUp, 'the step turned toward its own head before reporting the blocker');
  const read = observations.find((o) => o.positions.length === 1 && o.positions[0].x === ownHead.x && o.positions[0].y === ownHead.y && o.positions[0].z === ownHead.z);
  assert.ok(read, 'the step reread its own head cell after the turn');
  assert.deepEqual(read.out.map((b) => b.name), ['stone']);
  assert.equal(move.mock.callCount(), 0);
  assert.equal(dig.mock.callCount(), 0);
  assert.deepEqual(w.actions, []);
});
