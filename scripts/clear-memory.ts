/** 先退出 Agent，保持 Hindsight 可访问；删除远程专属 bank 后清空 DATA_DIR。 */
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.ts';
import { clearAllMemory } from '../src/memory/clear-external.ts';

try {
  const result = await clearAllMemory(config.dataDir, fileURLToPath(new URL('../', import.meta.url)), config.memory);
  console.log(result.cleared ? `已完全清空历史记忆：${result.directory}` : `历史记忆已为空：${result.directory}`);
  console.log('世界记忆、自学技能、历史日志及备份均已清空，下次启动 Agent 将从零开始。');
  if (result.banksCleared) console.log(`已删除并验证 ${result.banksCleared} 个专属 Hindsight bank。`);
} catch (e: any) {
  console.error(`清空历史记忆失败：${e?.message ?? e}`);
  process.exitCode = 1;
}
