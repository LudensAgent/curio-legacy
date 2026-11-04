/**
 * walk_route 联机验收入口：连接 test 服务器，用真实 MineflayerAdapter + Arbiter + Vision
 * 从 Arbiter 入口发起 walk_route，记录到达、取消与最终控制状态。
 *
 *   运行：node --import tsx scripts/walk-acceptance.ts --curio=test
 *
 * 只读/只走，不挖、不放、不绕路。结果打印到 stdout，便于重复执行与记录。
 */
import path from 'node:path';
import { config } from '../src/config.ts';
import { MineflayerAdapter } from '../src/adapter/mineflayer.ts';
import { Vision } from '../src/perception/vision.ts';
import { WorldMemory } from '../src/memory/store.ts';
import { Arbiter, type TaskOutcome } from '../src/arbiter/arbiter.ts';
import { EventBus } from '../src/events.ts';

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

async function main() {
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
  const nav1 = o1.result.data?.nav as { outcome: string; lastPosition?: { x: number; y: number; z: number }; message: string } | undefined;
  console.log(`[accept] 场景1 到达：status=${o1.result.status} code=${o1.result.failureCode ?? '—'} outcome=${nav1?.outcome} 末位=(${nav1?.lastPosition ? `${nav1.lastPosition.x.toFixed(2)},${nav1.lastPosition.y.toFixed(2)},${nav1.lastPosition.z.toFixed(2)}` : '—'}) 摘要=${o1.result.summary}`);

  // ---- 场景 2：中途取消，不复活 ----
  const p2 = adapter.state().pos;
  const route2 = Array.from({ length: 6 }, (_, i) => ({ x: p2.x + i, y: p2.y, z: p2.z }));
  const done2 = new Promise<TaskOutcome>((r) => arbiter.once('done', r));
  arbiter.start({ skill: 'walk_route', args: { points: route2 } }, 'user');
  await new Promise((r) => setTimeout(r, 3000));
  arbiter.cancel('联机验收取消');
  const o2 = await Promise.race([done2, timeout(20_000, '取消收尾')]);
  const nav2 = o2.result.data?.nav as { outcome: string; lastPosition?: { x: number; y: number; z: number } } | undefined;
  const final = adapter.state().pos;
  console.log(`[accept] 场景2 取消：status=${o2.result.status} code=${o2.result.failureCode ?? '—'} outcome=${nav2?.outcome} 末位=(${nav2?.lastPosition ? `${nav2.lastPosition.x.toFixed(2)},${nav2.lastPosition.y.toFixed(2)},${nav2.lastPosition.z.toFixed(2)}` : '—'}) 实测脚位=(${final.x.toFixed(2)},${final.y.toFixed(2)},${final.z.toFixed(2)}) 摘要=${o2.result.summary}`);

  adapter.stopAll();
  console.log('[accept] 完成');
  process.exit(0);
}

main().catch((e) => {
  console.error(`[accept] 失败：${(e as Error).message ?? e}`);
  process.exit(1);
});
