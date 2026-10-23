/** 先退出 Agent，保持 Hindsight 可访问；删除远程专属 bank 后清空 DATA_DIR。 */
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.ts';
import { resetTestSession } from '../src/maintenance/reset.ts';

try {
  const args = new Set(process.argv.slice(2));
  if ([...args].some((arg) => !['--full', '--dry-run', '--hindsight', '--help'].includes(arg))) {
    throw new Error('未知参数。支持 --full（同时重置世界）、--dry-run（只预览）、--hindsight（即使本地模式也清当前 Hindsight bank）。');
  }
  if (args.has('--help')) {
    console.log('npm run memory:clear [-- --full] [--dry-run] [--hindsight]；npm run memory:reset 为完整重置。先退出 Agent；完整重置还需停止 Minecraft 服务器，Hindsight 保持可用。');
  } else {
    const outcome = await resetTestSession({
      dataDir: config.dataDir,
      projectDir: fileURLToPath(new URL('../', import.meta.url)),
      memory: args.has('--hindsight') ? { ...config.memory, provider: 'hindsight' } : config.memory,
      full: args.has('--full'), dryRun: args.has('--dry-run'),
      endpoints: [{ host: config.dashboard.host, port: config.dashboard.port, label: 'Agent 控制台' }],
    });
    if (outcome.dryRun) {
      console.log('清理预览（未连接服务，未修改或删除任何文件）：');
      console.log(JSON.stringify(outcome.plan, null, 2));
    } else if (outcome.result) {
      const result = outcome.result.memory;
      console.log(result.cleared ? `已完全清空历史记忆：${result.directory}` : `历史记忆已为空：${result.directory}`);
      console.log('世界记忆、自学技能、历史日志及备份均已清空，保留空数据目录。');
      if (result.banksCleared) console.log(`已删除并验证 ${result.banksCleared} 个专属 Hindsight bank。`);
      if (outcome.result.world) console.log('已清理世界与运行数据，保留 EULA、配置、mods 和启动组件；下次启动创建随机种子的新世界。');
    }
  }
} catch (e: any) {
  console.error(`${process.argv.includes('--full') ? '完整重置失败' : '清空历史记忆失败'}：${e?.message ?? e}`);
  process.exitCode = 1;
}
