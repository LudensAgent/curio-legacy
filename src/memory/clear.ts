import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROJECT_DIRS = ['.git', '.agents', '.codex', '.aws', 'src', 'scripts', 'tests', 'public', 'docs', 'node_modules', 'world'];

/** child 是否位于 parent 内（含自身），使用平台路径规则比较。 */
function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function validateDirectory(directory: string, projectDir: string) {
  if (directory === path.parse(directory).root || contains(directory, os.homedir()) || contains(directory, projectDir)) {
    throw new Error(`拒绝清空危险的 DATA_DIR：${directory}`);
  }
  if (PROJECT_DIRS.some((name) => contains(path.join(projectDir, name), directory))) {
    throw new Error(`DATA_DIR 不能位于项目源码、依赖或游戏存档目录：${directory}`);
  }
}

/** 在接触远程记忆前完成本地目录检查，不修改任何数据。 */
export function inspectMemoryDirectory(dataDir: string, projectDir: string): { directory: string; exists: boolean } {
  const directory = path.resolve(dataDir);
  const project = fs.realpathSync(projectDir);
  validateDirectory(directory, path.resolve(projectDir));
  validateDirectory(directory, project);

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(directory);
  } catch (e: any) {
    if (e.code === 'ENOENT') return { directory, exists: false };
    throw e;
  }
  if (stat.isSymbolicLink()) throw new Error(`DATA_DIR 不能是符号链接或 junction，请使用真实数据目录：${directory}`);
  if (!stat.isDirectory()) throw new Error(`DATA_DIR 不是目录：${directory}`);

  const realDirectory = fs.realpathSync(directory);
  validateDirectory(realDirectory, project);
  if (['.git', 'package.json', 'server.properties', 'level.dat'].some((name) => fs.existsSync(path.join(realDirectory, name)))) {
    throw new Error(`DATA_DIR 包含项目或 Minecraft 存档文件，拒绝清空：${realDirectory}`);
  }
  return { directory: realDirectory, exists: true };
}

/** 一局的复盘材料：清空前先拷进项目的 archives/（事件和 LLM 日志、分数、累计数字、技能成败、收获账本） */
const KEEP_FOR_REVIEW = ['logs', 'run-stats.json', 'scorecard.json', 'skill-stats.json', 'ledger.json', 'skills'];

export function archiveForReview(directory: string, projectDir: string, now = new Date()): string | null {
  const present = KEEP_FOR_REVIEW.filter((name) => fs.existsSync(path.join(directory, name)));
  if (!present.length) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const target = path.join(projectDir, 'archives', `run-before-clear-${stamp}`);
  fs.mkdirSync(target, { recursive: true });
  for (const name of present) fs.cpSync(path.join(directory, name), path.join(target, name), { recursive: true });
  return target;
}

/** 离线重置：清空数据目录，保留可能被终端或监控工具占用的根目录。Agent 必须先退出。清空前把这一局的日志和统计拷进 archives/。 */
export function clearMemory(dataDir: string, projectDir: string): { directory: string; cleared: boolean; archived?: string | null } {
  const result = inspectMemoryDirectory(dataDir, projectDir);
  if (!result.exists) return { directory: result.directory, cleared: false };
  let archived: string | null = null;
  try { archived = archiveForReview(result.directory, path.resolve(projectDir)); } catch (e) {
    throw new Error(`清空前没能把这一局的日志存进 archives/（${(e as Error).message}）；为了不丢复盘材料，先不清空`, { cause: e });
  }

  const entries = fs.readdirSync(result.directory);
  for (const entry of entries) {
    const target = path.resolve(result.directory, entry);
    if (target === result.directory || !contains(result.directory, target)) {
      throw new Error(`拒绝删除 DATA_DIR 以外的路径：${target}`);
    }
    try {
      // rm 不跟随链接；junction 也只删除入口，保留其指向的外部文件。
      const stat = fs.lstatSync(target);
      fs.rmSync(target, { recursive: !stat.isSymbolicLink(), force: true, maxRetries: 5, retryDelay: 100 });
    } catch (e: any) {
      // 与 Agent 并发删除同一条目时允许条目已经消失；结束时仍会核实目录为空。
      if (e.code === 'ENOENT') continue;
      if (['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(e.code)) {
        throw new Error(`无法清空历史记忆（${e.code}）：${target}。请先退出 Agent，并关闭占用该目录中文件的终端、编辑器或监控工具后重试。`, { cause: e });
      }
      throw e;
    }
  }
  if (fs.readdirSync(result.directory).length) {
    throw new Error(`DATA_DIR 清空后仍有文件：${result.directory}。请先退出 Agent，停止写入记忆或日志的程序后重试。`);
  }
  return { directory: result.directory, cleared: entries.length > 0, archived };
}
