/** 先退出 Agent，再运行 npm run memory:clear；彻底删除 DATA_DIR 下的全部数据。 */
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.ts';
import { clearMemory } from '../src/memory/clear.ts';

try {
  const result = clearMemory(config.dataDir, fileURLToPath(new URL('../', import.meta.url)));
  console.log(result.cleared ? `已完全清空历史记忆：${result.directory}` : `历史记忆已为空：${result.directory}`);
  console.log('世界记忆、自学技能、历史日志及备份均已清空，下次启动 Agent 将从零开始。');
} catch (e: any) {
  console.error(`清空历史记忆失败：${e?.message ?? e}`);
  process.exitCode = 1;
}
