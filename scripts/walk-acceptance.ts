/**
 * walk_route 联机验收入口：连接 test 服务器，用真实 MineflayerAdapter + Arbiter + Vision
 * 从 Arbiter 入口发起 walk_route，断言到达、取消与最终控制状态，并保存结构化结果。
 *
 *   运行：node --import tsx scripts/walk-acceptance.ts --curio=test
 *
 * 只读/只走，不挖、不放、不绕路。任一场景失败即以非 0 退出码结束。
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.ts';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { Vision } from '../src/perception/vision.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { EventBus } from '../src/events.ts';

const results: Record<string, unknown> = { mode: config.mode, worldId: config.memory.worldId, startedAt: Date.now() };

function fail(msg: string): never {
  console.error(`[accept] 失败：${msg}`);
  results.failed = msg;
  results.failedAt = Date.now();
  writeResults();
  process.exit(1);
}

function writeResults() {
  const dir = path.join(config.dataDir, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `walk-acceptance-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(results, null, 2) + '\n');
  console.log(`[accept] 结果已保存：${file}`);
}

function timeout(ms: number, label: string): Promise<never> {
  return new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`超时：${label}`)), ms));
}

function waitFor(cond: () => boolean, ms: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (cond()) { clearInterval(iv); resolve(); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error(`超时：${label}`)); }
    }, 100);
  });
}

const dist2 = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

async function main() {
  if (config.mode !== 'test') fail(`联机验收只允许在 test 环境运行，当前 ${config.mode}`);

  const bus = new EventBus();
  const adapter = new MineflayerAdapter(config, bus);
  const vision = new Vision(adapter, config.vision);
  const memory = new WorldMemory(path.join(config.dataDir, 'world-memory.json'));
  const arbiter = new Arbiter(adapter, memory, bus, vision);

  console.log(`[accept] 环境 ${config.mode} | 连接 ${config.mc.host}:${config.mc.port} | 世界身份 ${config.memory.worldId}`);

  const spawned = new Promise<void>((resolve, reject) => {
    adapter.on('spawn', () => resolve());
    adapter.on('disconnected', (reason: string) => reject(new Error(`spawn 前断线：${reason}`)));
  });
  adapter.connect();
  await Promise.race([spawned, timeout(30_000, 'spawn')]);
  await waitFor(() => adapter.state().observationReady, 30_000, 'observationReady');

  const s = adapter.state();
  console.log(`[accept] 已就绪：脚位 (${s.pos.x.toFixed(2)}, ${s.pos.y.toFixed(2)}, ${s.pos.z.toFixed(2)}) dim=${s.dim}`);

  // ---- 场景 1：同高三段含转弯到达 ----
  const p = s.pos;
  const y = p.y;
  const route1 = [
    { x: p.x, y, z: p.z },
    { x: p.x + 1, y, z: p.z },
    { x: p.x + 1, y, z: p.z + 1 },
    { x: p.x + 2, y, z: p.z + 1 },
  ];
  const done1 = new Promise<TaskOutcome>((r) => arbiter.once('done', r));
  arbiter.start({ skill: 'walk_route', args: { points: route1 } }, 'user');
  const o1 = await Promise.race([done1, timeout(40_000, 'walk_route 到达')]);
  const nav1 = o1.result.data?.nav as { outcome: string; confirmed?: boolean; lastPosition?: { x: number; y: number; z: number }; message: string } | undefined;
  if (o1.result.status !== 'succeeded' || nav1?.outcome !== 'ARRIVED') {
    fail(`场景1 未到达：status=${o1.result.status} outcome=${nav1?.outcome} 摘要=${o1.result.summary}`);
  }
  const finalTarget = route1[route1.length - 1]!;
  const finalPos = nav1!.lastPosition!;
  if (nav1!.confirmed !== true) fail(`场景1 到达但未 confirmed：${o1.result.summary}`);
  const err1 = dist2(finalPos, finalTarget);
  if (err1 > 0.12) fail(`场景1 末位误差 ${err1.toFixed(3)} 超出容差 0.12`);
  if (Math.abs(finalPos.y - y) > 0.05) fail(`场景1 脚高 ${finalPos.y.toFixed(2)} 偏离预期 ${y.toFixed(2)} 超过 0.05`);
  results.scenario1 = { outcome: nav1!.outcome, confirmed: nav1!.confirmed, lastPosition: finalPos, error: Number(err1.toFixed(3)), feetError: Number(Math.abs(finalPos.y - y).toFixed(3)) };
  console.log(`[accept] 场景1 到达：outcome=ARRIVED confirmed=${nav1!.confirmed} 末位=(${finalPos.x.toFixed(2)},${finalPos.y.toFixed(2)},${finalPos.z.toFixed(2)}) 误差=${err1.toFixed(3)} 脚高误差=${Math.abs(finalPos.y - y).toFixed(3)}`);

  // ---- 场景 2：中途取消，不复活，迟到回调不影响后续控制 ----
  const p2 = adapter.state().pos;
  const route2 = Array.from({ length: 6 }, (_, i) => ({ x: p2.x + i, y: p2.y, z: p2.z }));
  const done2 = new Promise<TaskOutcome>((r) => arbiter.once('done', r));
  arbiter.start({ skill: 'walk_route', args: { points: route2 } }, 'user');
  // 等身体真正开始移动（位移超过半格）再取消，覆盖移动期而非初始化期。
  const moveStart = adapter.state().pos;
  await waitFor(() => dist2(adapter.state().pos, moveStart) > 0.5, 15_000, 'walk 开始移动');
  const movedBeforeCancel = dist2(adapter.state().pos, moveStart);
  arbiter.cancel('联机验收取消');
  const o2 = await Promise.race([done2, timeout(20_000, '取消收尾')]);
  if (o2.result.status !== 'cancelled') fail(`场景2 未以 cancelled 结束：status=${o2.result.status} 摘要=${o2.result.summary}`);
  const cancelPos = adapter.state().pos;
  // 等一个迟到帧窗口（约 1s），确认旧执行不复活、不再移动。
  await new Promise((r) => setTimeout(r, 1000));
  const afterPos = adapter.state().pos;
  const driftAfter = dist2(afterPos, cancelPos);
  if (driftAfter > 0.1) fail(`场景2 取消后仍移动 ${driftAfter.toFixed(3)} 格，旧执行复活`);
  results.scenario2 = { status: o2.result.status, movedBeforeCancel: Number(movedBeforeCancel.toFixed(2)), driftAfterCancel: Number(driftAfter.toFixed(3)) };
  console.log(`[accept] 场景2 取消：status=cancelled 取消前位移=${movedBeforeCancel.toFixed(2)} 取消后漂移=${driftAfter.toFixed(3)}`);

  adapter.stopAll();
  results.ok = true;
  results.finishedAt = Date.now();
  writeResults();
  console.log('[accept] 完成：两场景通过');
  process.exit(0);
}

main().catch((e) => {
  fail((e as Error).message ?? String(e));
});
