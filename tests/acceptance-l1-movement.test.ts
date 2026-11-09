/**
 * V4-QA-01 验收矩阵：L1 基础移动（v4 §7.5 / §14.1）。
 *
 * 每个测试直接对应 `workflow/cards/V4-QA-01.md` §2 L1 的一个条目，独立报告
 * PASS / FAIL / NOT_RUN。复用生产动作 `move_step`/`mine_cell`/`place_cell`/
 * `place_support`/`pillar_one` 与现有夹具 `FakeAdapter`/`makeCtx`；不新建身体、
 * 地图或第二套验证器。
 *
 * 离线/Fake 证据：FakeAdapter 的 `moveTo` 是连续插值并按实测位置验收，不是传送。
 * 实机 Java 1.20.1（真实物理、服务端位置纠正）一律 NOT_RUN，见 V4-QA-02。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Vec3Like } from '../src/adapter/types.ts';
import { mineCell, moveStep, pillarOne, placeCell, placeSupport } from '../src/skills/movement/index.ts';
import { FakeAdapter } from './fake-adapter.ts';
import { makeCtx } from './survival-helpers.ts';

function flat() {
  const w = new FakeAdapter();
  w.pos = { x: 0.5, y: 64, z: 0.5 };
  return w;
}

/** 只把显式放下的方块当作看得见；未显式观察的邻格保持 UNKNOWN。 */
function targetOnly(positions: Vec3Like[], cells: Vec3Like[]) {
  return positions
    .filter((p) => cells.some((c) => c.x === p.x && c.y === p.y && c.z === p.z))
    .map((pos) => ({ name: 'stone', pos, properties: {}, worldId: 'fake-world', sessionId: 'fake-session', dimension: 'overworld', observationId: 1, observedAt: Date.now(), source: 'vision' as const }));
}

/** 慢速连续身体：移动 1 格要 2 秒，用于观察有界超时/取消时的部分位移。 */
class SlowAdapter extends FakeAdapter {
  speed = 0.5;
}

test('L1-1 平地单步/转向/连续 20 步：实测位移与方向' , async (t) => {
  const w = flat();
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  let confirmed = 0;
  for (let i = 0; i < 20; i++) {
    const v = moveStep.validate({ to: [1, 0, 0], facing: 'E' }, w);
    if (!v.ok) assert.fail(v.error);
    const r = await moveStep.run(ctx, v.args);
    assert.equal(r.status, 'succeeded', `第 ${i + 1} 步：${r.summary}`);
    assert.deepEqual(r.data?.moved, [1, 0, 0], '每步回执的实测位移相对脚格');
    confirmed += 1;
  }
  assert.deepEqual({ x: Math.floor(w.pos.x), y: Math.floor(w.pos.y), z: Math.floor(w.pos.z) }, { x: 20, y: 64, z: 0 });
  assert.equal(w.pos.z, 0.5, '连续迈步不横向漂移');
  assert.equal(w.pos.y, 64, '连续迈步不累积脚高误差');
  // 转向：面北迈一步，脚格 z 从 0 到 -1。
  const turn = await moveStep.run(ctx, { at: [1, 0, 0], facing: 'N' });
  assert.equal(turn.status, 'succeeded', turn.summary);
  assert.deepEqual({ x: Math.floor(w.pos.x), z: Math.floor(w.pos.z) }, { x: 20, z: -1 });
  assert.equal(w.actions.every((action) => action.startsWith('moveTo:')), true, '只走相邻一步，不挖/不建/不寻路');
  t.diagnostic(`L1-1 confirmedSteps=${confirmed + 1} plannedSteps=${confirmed + 1} displacementCells=21`);
});

test('L1-2 半砖/雪层/地毯分数脚高：按碰撞顶面执行，不取整' , async (t) => {
  // 下半砖：格底 63、顶面 63.5。
  const slab = flat();
  slab.blocks.push({ name: 'stone_slab', pos: { x: 1, y: 63, z: 0 } });
  slab.blockProperties.set('1,63,0', { type: 'bottom' });
  const slabCtx = makeCtx(slab);
  t.after(() => slabCtx.memory.close());
  const down = await moveStep.run(slabCtx, { at: [1, -1, 0], facing: 'E' });
  assert.equal(down.status, 'succeeded', down.summary);
  assert.equal(slab.pos.y, 63.5, '下半砖脚高是 63.5');
  const abs = await moveStep.run(slabCtx, { at: [0, 0, 0] as [number, number, number], facing: 'E' as const, xyz: { x: 2, y: 64, z: 0 } });
  assert.equal(abs.status, 'succeeded', abs.summary);
  assert.equal(slab.pos.y, 64);

  // 雪层：4 层雪顶面 64.375。
  const snow = flat();
  snow.blocks.push({ name: 'snow', pos: { x: 1, y: 64, z: 0 } });
  snow.blockProperties.set('1,64,0', { layers: 4 });
  const snowCtx = makeCtx(snow);
  t.after(() => snowCtx.memory.close());
  const upSnow = await moveStep.run(snowCtx, { at: [1, 1, 0], facing: 'E' });
  assert.equal(upSnow.status, 'succeeded', upSnow.summary);
  assert.equal(snow.pos.y, 64.375, '雪层按层数解析分数脚高');

  // 地毯：顶面 64.0625。
  const carpet = flat();
  carpet.blocks.push({ name: 'white_carpet', pos: { x: 1, y: 64, z: 0 } });
  carpet.blockProperties.set('1,64,0', {});
  const carpetCtx = makeCtx(carpet);
  t.after(() => carpetCtx.memory.close());
  const upCarpet = await moveStep.run(carpetCtx, { at: [1, 1, 0], facing: 'E' });
  assert.equal(upCarpet.status, 'succeeded', upCarpet.summary);
  assert.equal(carpet.pos.y, 64.0625, '地毯按实际顶面解析分数脚高');
  t.diagnostic(`L1-2 footHeights slabDown=63.5 slabAbsolute=64 snow=${snow.pos.y} carpet=${carpet.pos.y}`);
});

test('L1-3 上/下 0.5–1 格：同一 move_step 边界' , async (t) => {
  // 上半砖 0.5 格向上。
  const upHalf = flat();
  upHalf.blocks.push({ name: 'stone_slab', pos: { x: 1, y: 64, z: 0 } });
  upHalf.blockProperties.set('1,64,0', { type: 'bottom' });
  const upHalfCtx = makeCtx(upHalf);
  t.after(() => upHalfCtx.memory.close());
  const halfUp = await moveStep.run(upHalfCtx, { at: [1, 1, 0], facing: 'E' });
  assert.equal(halfUp.status, 'succeeded', halfUp.summary);
  assert.equal(upHalf.pos.y, 64.5);

  // 整块 1 格向上。
  const upFull = flat();
  upFull.blocks.push({ name: 'stone', pos: { x: 1, y: 64, z: 0 } });
  const upFullCtx = makeCtx(upFull);
  t.after(() => upFullCtx.memory.close());
  const fullUp = await moveStep.run(upFullCtx, { at: [1, 1, 0], facing: 'E' });
  assert.equal(fullUp.status, 'succeeded', fullUp.summary);
  assert.equal(upFull.pos.y, 65);

  // 下半砖 0.5 格向下。
  const downHalf = flat();
  downHalf.blocks.push({ name: 'stone_slab', pos: { x: 1, y: 63, z: 0 } });
  downHalf.blockProperties.set('1,63,0', { type: 'bottom' });
  const downHalfCtx = makeCtx(downHalf);
  t.after(() => downHalfCtx.memory.close());
  const halfDown = await moveStep.run(downHalfCtx, { at: [1, -1, 0], facing: 'E' });
  assert.equal(halfDown.status, 'succeeded', halfDown.summary);
  assert.equal(downHalf.pos.y, 63.5);

  // 整块 1 格向下。
  const downFull = flat();
  downFull.removed.add('1,63,0');
  const downFullCtx = makeCtx(downFull);
  t.after(() => downFullCtx.memory.close());
  const fullDown = await moveStep.run(downFullCtx, { at: [1, -1, 0], facing: 'E' });
  assert.equal(fullDown.status, 'succeeded', fullDown.summary);
  assert.equal(downFull.pos.y, 63);
  t.diagnostic('L1-3 verticalAccepted halfUp=0.5 fullUp=1.0 halfDown=0.5 fullDown=1.0');
});

test('L1-4 >1 格拒绝并交接：不自动改落点、不执行移动' , async (t) => {
  const w = flat();
  for (const key of ['1,63,0', '1,62,0']) w.removed.add(key);
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const start = { ...w.pos };
  const drop = await moveStep.run(ctx, { at: [1, 0, 0], facing: 'E' });
  assert.equal(drop.status, 'failed');
  assert.equal(drop.failureCode, 'BAD_ARGS');
  assert.equal(drop.data?.unsupportedGeometry, true);
  assert.equal(drop.data?.movementNotAttempted, true);
  assert.deepEqual(w.pos, start, '拒绝时不移动身体');
  assert.equal(w.actions.length, 0, '拒绝时不调用任何身体动作');
  const remediation = drop.data?.remediation as { landing?: Vec3Like; drop?: number; descend?: { target?: Vec3Like }; stairs?: { mode?: string } } | undefined;
  assert.deepEqual(remediation?.landing, { x: 1, y: 62, z: 0 });
  assert.equal(remediation?.drop, 2);
  assert.deepEqual(remediation?.descend?.target, { x: 1, y: 62, z: 0 }, '把同一落点交给 descend_to');
  assert.equal(remediation?.stairs?.mode, 'stairs');
  assert.match(drop.summary, /descend_to/);
  assert.match(drop.summary, /excavate_run/);

  // 向上 2 格：同样拒绝并交阶梯开挖。
  const up = flat();
  up.blocks.push({ name: 'stone', pos: { x: 1, y: 64, z: 0 } }, { name: 'stone', pos: { x: 1, y: 65, z: 0 } });
  const upCtx = makeCtx(up);
  t.after(() => upCtx.memory.close());
  const rise = await moveStep.run(upCtx, { at: [1, 1, 0], facing: 'E' });
  assert.equal(rise.status, 'failed');
  assert.equal(rise.data?.movementNotAttempted, true);
  assert.equal((rise.data?.remediation as { stairs?: { mode?: string } } | undefined)?.stairs?.mode, 'stairs_up');
  assert.match(rise.summary, /excavate_run/);
  assert.equal(up.actions.length, 0);
  t.diagnostic('L1-4 rejectedDrop=2 rejectedRise=2 remediation=descend_to+excavate_run');
});

test('L1-5 绝对/相对坐标与负坐标：落在正确方块列' , async (t) => {
  const west = flat();
  const westCtx = makeCtx(west);
  t.after(() => westCtx.memory.close());
  const r = await moveStep.run(westCtx, { at: [1, 0, 0], facing: 'W' });
  assert.equal(r.status, 'succeeded', r.summary);
  assert.deepEqual({ x: Math.floor(west.pos.x), z: Math.floor(west.pos.z) }, { x: -1, z: 0 });

  const north = flat();
  const northCtx = makeCtx(north);
  t.after(() => northCtx.memory.close());
  const n = await moveStep.run(northCtx, { at: [1, 0, 0], facing: 'N' });
  assert.equal(n.status, 'succeeded', n.summary);
  assert.deepEqual({ x: Math.floor(north.pos.x), z: Math.floor(north.pos.z) }, { x: 0, z: -1 });

  const absolute = flat();
  const absoluteCtx = makeCtx(absolute);
  t.after(() => absoluteCtx.memory.close());
  const a = await moveStep.run(absoluteCtx, { at: [0, 0, 0] as [number, number, number], facing: 'W' as const, xyz: { x: -1, y: 64, z: 0 } });
  assert.equal(a.status, 'succeeded', a.summary);
  assert.deepEqual({ x: Math.floor(absolute.pos.x), z: Math.floor(absolute.pos.z) }, { x: -1, z: 0 });
  assert.deepEqual(a.data?.targetCell, { x: -1, y: 64, z: 0 }, '回执目标格与实际脚格一致，不偏移到 0');
  // 相对与前/右方向组合。
  const rel = flat();
  const relCtx = makeCtx(rel);
  t.after(() => relCtx.memory.close());
  const forward = await moveStep.run(relCtx, { at: [1, 0, 0], facing: 'E' });
  assert.equal(forward.status, 'succeeded', forward.summary);
  const right = await moveStep.run(relCtx, { at: [0, 0, 1], facing: 'E' });
  assert.equal(right.status, 'succeeded', right.summary);
  assert.deepEqual({ x: Math.floor(rel.pos.x), z: Math.floor(rel.pos.z) }, { x: 1, z: 1 });
  t.diagnostic('L1-5 coords relativeWest=-1,0 relativeNorth=0,-1 absolute=-1,0 diagonal=1,1');
});

test('L1-6 起点漂移：计划检查后脚位/会话变化即拒绝旧计划' , async (t) => {
  const w = flat();
  const ctx = makeCtx(w);
  t.after(() => ctx.memory.close());
  const v = moveStep.validate({ to: [1, 0, 0], facing: 'E' }, w);
  if (!v.ok) assert.fail(v.error);
  const drifted = { ...w.pos, x: w.pos.x + 0.06 };
  w.pos = drifted;
  const r = await moveStep.run(ctx, v.args);
  assert.equal(r.status, 'failed');
  assert.equal(r.failureCode, 'BAD_ARGS');
  assert.equal((r.data?.problem as { kind?: string } | undefined)?.kind, 'START_CHANGED');
  assert.equal(r.data?.movementNotAttempted, true);
  assert.deepEqual(w.pos, drifted, '拒绝时不移动身体');
  assert.equal(w.actions.length, 0, '旧计划不得调用身体');
  assert.ok((r.data?.positionDrift as number) >= 0.05);

  // 会话变化：即使坐标未变，旧计划也不再成立。
  const w2 = flat();
  const ctx2 = makeCtx(w2);
  t.after(() => ctx2.memory.close());
  const v2 = moveStep.validate({ to: [1, 0, 0], facing: 'E' }, w2);
  if (!v2.ok) assert.fail(v2.error);
  w2.sessionId = 'fake-session-2';
  const changed = await moveStep.run(ctx2, v2.args);
  assert.equal(changed.status, 'failed');
  assert.equal((changed.data?.problem as { kind?: string } | undefined)?.kind, 'START_CHANGED');
  assert.equal(w2.actions.length, 0);
  t.diagnostic('L1-6 startDriftRejected=2 (position 0.06, session change)');
});

test('L1-7 服务端位置纠正', { skip: 'FakeAdapter 无服务端权威位置/纠正通道；实机 Java 1.20.1 服务端纠正只能由 V4-QA-02 验证' }, async () => {});

test('L1-8 部分移动/取消/超时：保留实测部分位移' , async (t) => {
  // 超时：1 格要 50 秒，身体在 1 秒期限后停在部分位置。
  const slow = new SlowAdapter();
  slow.pos = { x: 0.5, y: 64, z: 0.5 };
  const timeoutCtx = { ...makeCtx(slow, { deadlineMs: 1000 }), signal: new AbortController().signal };
  t.after(() => timeoutCtx.memory.close());
  const timedOut = await moveStep.run(timeoutCtx, { at: [1, 0, 0], facing: 'E' });
  assert.equal(timedOut.status, 'failed');
  assert.equal(timedOut.failureCode, 'TIMEOUT');
  const partialTimeout = timedOut.data?.position as Vec3Like;
  assert.ok(partialTimeout.x > 0.5 && partialTimeout.x < 1.5, `超时保留已走的实测位置：x=${partialTimeout.x}`);
  assert.equal(timedOut.data?.movementAttempted, true);
  assert.equal(timedOut.data?.moved, true);
  assert.deepEqual({ ...slow.pos }, { ...partialTimeout }, '回执位置=身体最后实测位置，不是计划终点');
  assert.equal(slow.stopAllCount, 1, '超时必须停止底层移动');

  // 取消：移动途中 abort，AbortedError 带同一份部分位移，身体不再前进。
  const cancel = new SlowAdapter();
  cancel.pos = { x: 0.5, y: 64, z: 0.5 };
  const controller = new AbortController();
  const cancelCtx = { ...makeCtx(cancel, { deadlineMs: 60_000 }), signal: controller.signal };
  t.after(() => cancelCtx.memory.close());
  const running = moveStep.run(cancelCtx, { at: [1, 0, 0], facing: 'E' });
  setTimeout(() => controller.abort('qa-cancel'), 120);
  await assert.rejects(running, (error: Error & { partial?: { position?: Vec3Like } }) => {
    assert.equal(error.name, 'AbortedError');
    const partial = error.partial?.position;
    assert.ok(partial && partial.x > 0.5 && partial.x < 1.5, `取消保留已走的实测位置：${JSON.stringify(partial)}`);
    assert.deepEqual({ ...cancel.pos }, { ...partial }, '取消回执位置=身体最后实测位置');
    return true;
  });
  const frozen = { ...cancel.pos };
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(cancel.pos, frozen, '取消后身体不再继续前进');
  assert.equal(cancel.stopAllCount, 1, '取消必须停止底层移动');
  t.diagnostic(`L1-8 timeoutPartial=${partialTimeout.x.toFixed(3)} cancelPartial=${frozen.x.toFixed(3)}`);
});

test('L1-9 放置/支撑/垫高：成功、材料消耗与失败分类' , async (t) => {
  // place_cell：成功放下一块，背包净消耗 1。
  const place = flat();
  place.inv.set('cobblestone', 2);
  const placeCtx = makeCtx(place);
  t.after(() => placeCtx.memory.close());
  const placed = await placeCell.run(placeCtx, { at: [1, 0, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(placed.status, 'succeeded', placed.summary);
  assert.equal(place.blockAt({ x: 1, y: 64, z: 0 }), 'cobblestone');
  assert.equal(place.inv.get('cobblestone'), 1);
  assert.equal((placed.data?.inventory as { consumed?: number } | undefined)?.consumed, 1);
  const occupied = await placeCell.run(placeCtx, { at: [1, 0, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(occupied.data?.noop, true, '同一材料已占据时如实报 noop，不重复消耗');
  assert.equal(place.inv.get('cobblestone'), 1);
  const wrong = await placeCell.run(placeCtx, { at: [1, 0, 0], facing: 'E', item: 'dirt' });
  assert.equal(wrong.status, 'failed', '不同材料占据时拒绝');
  assert.match(wrong.summary, /占据/);
  assert.equal(place.blockAt({ x: 1, y: 64, z: 0 }), 'cobblestone', '失败请求没有覆盖已有方块');
  assert.equal(place.inv.get('cobblestone'), 1, '失败请求不消耗材料');

  // place_support：空支撑格消耗 1；已有顶面不消耗。
  const support = flat();
  support.inv.set('cobblestone', 2);
  const supportCtx = makeCtx(support);
  t.after(() => supportCtx.memory.close());
  const existing = await placeSupport.run(supportCtx, { at: [1, -1, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(existing.data?.noop, true);
  assert.equal(support.inv.get('cobblestone'), 2);
  support.removed.add('1,63,0');
  const formed = await placeSupport.run(supportCtx, { at: [1, -1, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(formed.status, 'succeeded', formed.summary);
  assert.equal(support.blockAt({ x: 1, y: 63, z: 0 }), 'cobblestone');
  assert.equal(support.inv.get('cobblestone'), 1);

  // pillar_one：垫高 +1 并消耗材料；实际材料与回执不符时按失败分类结算。
  const pillar = new FakeAdapter();
  pillar.pos = { x: 0.5, y: 60, z: 0.5 };
  pillar.removed.add('0,60,0');
  pillar.removed.add('0,61,0');
  pillar.removed.add('0,62,0');
  pillar.inv.set('cobblestone', 1);
  const pillarCtx = makeCtx(pillar);
  t.after(() => pillarCtx.memory.close());
  const up = await pillarOne.run(pillarCtx, { item: 'cobblestone' });
  assert.equal(up.status, 'succeeded', up.summary);
  assert.equal(pillar.pos.y, 61);
  assert.equal(pillar.inv.get('cobblestone'), 0);

  const noMaterial = flat();
  noMaterial.removed.add('1,63,0');
  const noMaterialCtx = makeCtx(noMaterial);
  t.after(() => noMaterialCtx.memory.close());
  const missing = await placeSupport.run(noMaterialCtx, { at: [1, -1, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(missing.status, 'failed');
  assert.equal(missing.failureCode, 'MISSING_MATERIALS', '无材料是材料缺口，不是几何/参数错误');
  assert.equal(noMaterial.blockAt({ x: 1, y: 63, z: 0 }), 'air', '失败后没有残留方块');

  // 回滚：适配器回执 ok 但世界没变时不得算成功，也不得消耗材料或留下方块。
  class NoOpSupportWorld extends FakeAdapter {
    override async placeBlockAt() { return { ok: true as const }; }
  }
  const rollback = new NoOpSupportWorld();
  rollback.pos = { x: 0.5, y: 64, z: 0.5 };
  rollback.removed.add('1,63,0');
  rollback.inv.set('cobblestone', 1);
  const rollbackCtx = makeCtx(rollback);
  t.after(() => rollbackCtx.memory.close());
  const rolledBack = await placeSupport.run(rollbackCtx, { at: [1, -1, 0], facing: 'E', item: 'cobblestone' });
  assert.equal(rolledBack.status, 'failed', rolledBack.summary);
  assert.equal(rolledBack.failureCode, 'EFFECT_NOT_CONFIRMED');
  assert.equal(rollback.blockAt({ x: 1, y: 63, z: 0 }), 'air', '无实际支撑时不留下方块');
  assert.equal(rollback.inv.get('cobblestone'), 1, '没有实际放置就不扣材料');
  t.diagnostic('L1-9 materialAccounting place=-1 support=-1 pillar=-1 rollback=no_residual; wrongMaterial=MISSING_MATERIALS');
});

test('L1-10 确定性失败不重试；未知邻格默认拒绝' , async (t) => {
  const w = flat();
  w.blocks.push({ name: 'stone', pos: { x: 1, y: 64, z: 0 } });
  const observed = [{ x: 1, y: 64, z: 0 }];
  const ctx = makeCtx(w, { senses: { observeBlocks: (positions) => targetOnly(positions, observed) } });
  t.after(() => ctx.memory.close());
  const denied = await mineCell.run(ctx, { at: [1, 0, 0], facing: 'E' });
  assert.equal(denied.status, 'failed');
  assert.equal((denied.data?.problem as { kind?: string } | undefined)?.kind, 'UNKNOWN_ADJACENT_UNAUTHORIZED');
  const unknown = denied.data?.unknownAdjacent as unknown[];
  assert.ok(Array.isArray(unknown) && unknown.length > 0, '未观察的邻格必须列出');
  assert.equal(w.blockAt({ x: 1, y: 64, z: 0 }), 'stone', '默认不挖未知邻格');
  assert.equal(w.actions.length, 0);
  // 同一确定性失败再调用一次：动作与事实不变，不自动重试/不自动授权。
  const repeated = await mineCell.run(ctx, { at: [1, 0, 0], facing: 'E' });
  assert.equal(repeated.status, 'failed');
  assert.equal((repeated.data?.problem as { kind?: string } | undefined)?.kind, 'UNKNOWN_ADJACENT_UNAUTHORIZED');
  assert.deepEqual(repeated.data?.unknownAdjacent, unknown, '同一证据下失败事实一致');
  assert.equal(w.actions.length, 0, '确定性失败不产生新的身体动作');
  // 只有 Agent 显式授权才挖。
  const allowed = await mineCell.run(ctx, { at: [1, 0, 0], facing: 'E', allowUnknownAdjacent: true });
  assert.equal(allowed.status, 'succeeded', allowed.summary);
  assert.equal(w.blockAt({ x: 1, y: 64, z: 0 }), 'air');
  t.diagnostic('L1-10 unauthorizedAttempts=2 repeatedUnchanged=1 actionsBeforeExplicitAuth=0');
});
