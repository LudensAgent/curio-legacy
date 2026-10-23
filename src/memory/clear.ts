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

/** 离线重置：删除整个数据目录，包括记忆、技能、日志、备份和诊断。Agent 必须先退出。 */
export function clearMemory(dataDir: string, projectDir: string): { directory: string; cleared: boolean } {
  const result = inspectMemoryDirectory(dataDir, projectDir);
  if (result.exists) fs.rmSync(result.directory, { recursive: true });
  return { directory: result.directory, cleared: result.exists };
}
