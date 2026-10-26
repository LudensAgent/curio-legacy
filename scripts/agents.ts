/**
 * 角色档案：npm run agents:list | agents:save | agents:new [名字] | agents:switch <ID或名字>
 * 存档 / 新建 / 切换前先退出 Agent、停掉 Minecraft 服务器；用 Hindsight 时让它保持运行（要导出、恢复记忆）。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.ts';
import { adoptCurrent, listAgents, newAgent, saveActive, switchAgent, worldEntries, type AgentPaths } from '../src/maintenance/agents.ts';
import { assertResetOffline } from '../src/maintenance/offline.ts';
import { inspectWorldReset } from '../src/maintenance/world-reset.ts';
import { hindsightBankOps } from '../src/memory/hindsight.ts';
import { legacyBankId } from '../src/memory/settings.ts';

const projectDir = fileURLToPath(new URL('../', import.meta.url));
const paths: AgentPaths = {
  projectDir, dataDir: config.dataDir,
  serverDir: path.resolve(process.env.SERVER_DIR?.trim() || path.join(projectDir, 'world')),
  agentsDir: path.resolve(process.env.AGENTS_DIR?.trim() || path.join(projectDir, 'agents')),
};
const ident = { worldId: config.memory.worldId, botUsername: config.memory.agentId, legacyBankId: legacyBankId(config.memory.worldId, config.memory.agentId) };
const log = (s: string) => console.log(`· ${s}`);
const [cmd, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const words = rest.filter((a) => !a.startsWith('--'));
const bank = config.memory.provider === 'hindsight' || flags.has('--hindsight') ? hindsightBankOps(config.memory) : undefined;

async function offline() {
  const world = inspectWorldReset(paths.serverDir, paths.projectDir);
  await assertResetOffline([
    { host: config.dashboard.host, port: config.dashboard.port, label: 'Agent 控制台' },
    { host: world.serverHost, port: world.serverPort, label: 'Minecraft 服务器' },
  ]);
}

const when = (t?: number) => t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '—';

try {
  if (cmd === 'list') {
    const all = listAgents(paths);
    if (!all.length) console.log('还没有角色档案（第一次 save / new / switch 时会把现在的 data/ 收编成一个）');
    for (const a of all) {
      console.log(`${a.active ? '▶' : ' '} ${a.id}${a.label ? `  ${a.label}` : ''}`);
      console.log(`    创建 ${when(a.createdAt)}  上次存档 ${when(a.savedAt)}  世界 ${a.hasWorld ? '有' : '无'}  Hindsight 导出 ${a.hasBankArchive ? '有' : '无'}${a.stats ? `  玩了 ${a.stats.uptimeH} 小时` : ''}`);
    }
  } else if (cmd === 'save') {
    if (!flags.has('--live')) await offline();
    else console.log('（--live：Agent 或服务器还在跑，存下的世界和数据可能不完全一致）');
    const m = await saveActive(paths, ident, { bank, withRecordings: flags.has('--with-recordings'), log });
    console.log(`已存档：${m.id}`);
  } else if (cmd === 'new') {
    await offline();
    const { from, to } = await newAgent(paths, ident, { label: words.join(' ') || undefined, bank, log });
    console.log(`旧角色 ${from.id} 已归档；新角色 ${to.id} 已就绪，启动服务器和 Agent 就是全新的开始`);
  } else if (cmd === 'switch') {
    if (!words[0]) {
      console.log('要切到哪个角色？npm run agents:switch -- <ID或名字>；现有：');
      for (const a of listAgents(paths)) console.log(`${a.active ? '▶' : ' '} ${a.id}${a.label ? `  ${a.label}` : ''}`);
      process.exitCode = 1;
    } else {
      await offline();
      const { from, to } = await switchAgent(paths, words[0], ident, { bank, log });
      console.log(`已从 ${from.id} 切到 ${to.id}；启动服务器和 Agent 就回到它的世界和记忆`);
    }
  } else if (cmd === 'adopt') {
    const m = adoptCurrent(paths, ident, log);
    console.log(`当前角色：${m.id}（世界条目：${worldEntries(paths).join('、')}）`);
  } else {
    console.log('用法：npm run agents:list | agents:save [-- --live --with-recordings] | agents:new [-- 名字] | agents:switch -- <ID或名字>');
    process.exitCode = cmd ? 1 : 0;
  }
} catch (e: any) {
  console.error(`角色档案操作失败：${e?.message ?? e}`);
  process.exitCode = 1;
}
