import { clearMemory, inspectMemoryDirectory } from './clear.ts';
import { HindsightBackend } from './hindsight.ts';
import { readMemoryRegistry, unregisterMemoryBackend, type MemoryBackendRegistration } from './registry.ts';
import type { MemoryBackend, MemorySettings } from './types.ts';

/** Stop the Agent first; a remote failure preserves the local registry so cleanup can be retried. */
export async function clearAllMemory(
  dataDir: string,
  projectDir: string,
  settings: MemorySettings,
  backendFactory: (registration: MemoryBackendRegistration) => Pick<MemoryBackend, 'clear'> =
    (registration) => new HindsightBackend({ ...registration, apiKey: settings.apiKey }),
): Promise<{ directory: string; cleared: boolean; banksCleared: number }> {
  const local = inspectMemoryDirectory(dataDir, projectDir);
  const registered = readMemoryRegistry(local.directory);
  const targets = [...registered];
  if (settings.provider === 'hindsight') targets.push({ baseUrl: settings.baseUrl, bankId: settings.bankId });
  const unique = [...new Map(targets.map((target) => [`${target.baseUrl}\n${target.bankId}`, target])).values()];
  // Preflight every bank before deletion. Never send the configured key to a historical, different endpoint.
  for (const target of unique) {
    if (!/^mc-[a-f0-9]{32}$/.test(target.bankId)) throw new Error('历史记忆登记包含非本应用的 bank，拒绝清理。');
  }
  const matching = unique.filter((target) => target.baseUrl === settings.baseUrl);
  for (const target of matching) {
    await backendFactory(target).clear(AbortSignal.timeout(settings.retainTimeoutMs ?? 60_000));
    if (registered.some((entry) => entry.baseUrl === target.baseUrl && entry.bankId === target.bankId)) {
      unregisterMemoryBackend(local.directory, target);
    }
  }
  if (matching.length !== unique.length) {
    throw new Error('已清理当前服务；历史记忆还位于其他地址。请切换 HINDSIGHT_URL 后重试，剩余登记与本地历史已保留。');
  }
  const result = clearMemory(local.directory, projectDir);
  return { ...result, banksCleared: matching.length };
}
