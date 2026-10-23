import path from 'node:path';
import { clearAllMemory, inspectAllMemory } from '../memory/clear-external.ts';
import type { MemoryBackendRegistration } from '../memory/registry.ts';
import type { MemoryBackend, MemorySettings } from '../memory/types.ts';
import { assertResetOffline, type ResetEndpoint } from './offline.ts';
import { inspectWorldReset, resetWorld } from './world-reset.ts';

export interface ResetOptions {
  dataDir: string;
  projectDir: string;
  memory: MemorySettings;
  full?: boolean;
  dryRun?: boolean;
  serverDir?: string;
  endpoints?: ResetEndpoint[];
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

/** All local preflight is read-only; a remote failure cannot modify the world or its seed. */
export async function resetTestSession(options: ResetOptions, dependencies: {
  backendFactory?: (registration: MemoryBackendRegistration) => Pick<MemoryBackend, 'clear'>;
  ensureOffline?: typeof assertResetOffline;
} = {}) {
  const memory = inspectAllMemory(options.dataDir, options.projectDir, options.memory);
  const world = options.full ? inspectWorldReset(options.serverDir ?? path.join(options.projectDir, 'world'), options.projectDir) : null;
  if (world && (contains(memory.directory, world.directory) || contains(world.directory, memory.directory))) {
    throw new Error('DATA_DIR 与服务器目录不能相互包含，拒绝完整重置。');
  }
  const plan = { memory: { directory: memory.directory, banks: memory.banks }, world };
  if (options.dryRun) return { dryRun: true, plan, result: null };
  if (world && memory.banks.some((bank) => bank.baseUrl !== options.memory.baseUrl)) {
    throw new Error('完整重置前请先按历史登记分别配置 HINDSIGHT_URL 清理其他服务；世界与种子保持不变。');
  }
  await (dependencies.ensureOffline ?? assertResetOffline)([
    ...(options.endpoints ?? []),
    ...(world ? [{ host: world.serverHost, port: world.serverPort, label: 'Minecraft 服务器' }] : []),
  ]);
  const clearedMemory = await clearAllMemory(options.dataDir, options.projectDir, options.memory, dependencies.backendFactory);
  const clearedWorld = world ? resetWorld(world.directory, options.projectDir) : null;
  return { dryRun: false, plan, result: { memory: clearedMemory, world: clearedWorld } };
}
