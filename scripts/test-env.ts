/**
 * test 环境入口（宿主运行环境，不等于单元测试进程）。
 *
 *   npm run test:config                    只读展示最终解析出的配置；不连接游戏、不启动服务器、不建库。
 *   npm run test:start                     走 scripts/supervise.mjs 的 Curio 实际启动入口。
 *
 * test 使用独立连接配置、世界副本与运行数据；冲突或缺少必要配置时在 config 加载阶段即失败，
 * 不会回退到 local/live 的地址、数据库或数据目录。
 *
 * 本分支尚未接入 SQLite 空间记忆库（世界记忆仍为 dataDir/world-memory.json），故不展示空间库路径。
 * 世界副本的初始化（--seed）不在本分支提供：测试服务端与测试世界需由操作者显式放置到 test 专属目录。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = fileURLToPath(new URL('../', import.meta.url));

async function showConfig(): Promise<void> {
  const { config, envFile } = await import('../src/config.ts');
  const rows: [string, string][] = [
    ['环境名称', config.mode],
    ['配置文件', envFile],
    ['游戏连接地址', `${config.mc.host}:${config.mc.port}`],
    ['RCON 地址', `${config.observer.rconHost}:${config.observer.rconPort}`],
    ['世界目录 (SERVER_DIR)', config.serverDir],
    ['Curio 数据目录 (DATA_DIR)', config.dataDir],
    ['角色档案目录 (AGENTS_DIR)', config.agentsDir],
    ['LLM 调用归档', config.llmArchiveDir],
    ['日志目录', path.join(config.dataDir, 'logs')],
    ['世界身份 (MEMORY_WORLD_ID)', config.memory.worldId],
    ['角色标识 (BOT_USERNAME)', config.mc.username],
  ];
  for (const [key, value] of rows) console.log(`${key}: ${value}`);
}

const cmd = process.argv.slice(2).find((a) => !a.startsWith('--'));

async function main(): Promise<void> {
  try {
    if (cmd === 'config') await showConfig();
    else {
      console.log('用法：npm run test:config | npm run test:start');
      process.exitCode = cmd ? 1 : 0;
    }
  } catch (e) {
    console.error(`test 环境操作失败：${(e as Error).message ?? e}`);
    process.exitCode = 1;
  }
}

void main();
