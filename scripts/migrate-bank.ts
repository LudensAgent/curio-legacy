/**
 * Hindsight bank 迁移（Docker → 原生/GPU）。
 *
 * 迁移前（Docker 还在跑）：
 *   npx tsx scripts/migrate-bank.ts --export
 * 停 Docker、起原生服务后：
 *   npx tsx scripts/migrate-bank.ts --import
 *
 * 可选覆盖：--bank <bankId>  --url <baseUrl>  --key <apiKey>  --file <path>
 * 默认从 data/<mode>/memory/backends.json 读已登记的 bank，找不到再退回 config.memory。
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.ts';
import { hindsightBankOps } from '../src/memory/hindsight.ts';

const args = process.argv.slice(2);
const cmd = args.find((a) => a === '--export' || a === '--import');
const get = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
};

/** 从已登记的 backends.json 里读当前 URL 对应的 bank（比 config.memory 更可靠，跨 URL 切换也认得） */
function registeredBankId(baseUrl: string): string | undefined {
  try {
    const file = path.join(config.dataDir, 'memory', 'backends.json');
    if (!fs.existsSync(file)) return undefined;
    const rows = JSON.parse(fs.readFileSync(file, 'utf8')) as { baseUrl?: string; bankId?: string }[];
    return rows.find((r) => r.baseUrl === baseUrl)?.bankId;
  } catch {
    return undefined;
  }
}

const baseUrl = get('--url') ?? config.memory.baseUrl;
const apiKey = get('--key') ?? config.memory.apiKey;
const bankId = get('--bank') ?? registeredBankId(baseUrl) ?? config.memory.bankId;
const file = get('--file') ?? 'bank.zip';

if (!cmd || !bankId) {
  console.log('Hindsight bank 迁移工具');
  console.log(`  url:  ${baseUrl}`);
  console.log(`  bank: ${bankId ?? '（未找到，请用 --bank 指定）'}`);
  console.log('');
  console.log('用法：');
  console.log('  迁移前：npx tsx scripts/migrate-bank.ts --export [--file bank.zip]');
  console.log('  切原生后：npx tsx scripts/migrate-bank.ts --import [--file bank.zip]');
  console.log('  覆盖：--bank <bankId> --url <baseUrl> --key <apiKey>');
  process.exit(bankId ? 0 : 1);
}

const bank = hindsightBankOps({ baseUrl, apiKey });

if (cmd === '--export') {
  console.log(`导出 bank → ${file} …`);
  const bytes = await bank.exportTo(bankId, file);
  console.log(`完成：${bytes} bytes 已写入 ${file}`);
} else {
  if (!fs.existsSync(file)) {
    console.error(`找不到 ${file}；请先 --export 生成它。`);
    process.exit(1);
  }
  console.log(`导入 ${file} → bank ${bankId} …`);
  await bank.importFrom(file, bankId);
  console.log('已提交导入；服务端在后台重新算向量（可能几分钟），期间逐步可用');
}
