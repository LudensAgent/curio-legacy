import { createHash } from 'node:crypto';
import type { MemorySettings } from './types.ts';

/** 记忆服务只保管本世界、本角色的 bank；不允许配置任意服务端 bank 名。 */
export function memorySettings(env: NodeJS.ProcessEnv = process.env): MemorySettings {
  const value = (key: string, fallback = '') => (env[key] ?? fallback).trim();
  const provider = value('MEMORY_PROVIDER', 'local').toLowerCase();
  if (provider !== 'local' && provider !== 'hindsight') throw new Error('MEMORY_PROVIDER 必须为 local 或 hindsight');
  const worldId = value('MEMORY_WORLD_ID', `${value('MC_HOST', '127.0.0.1')}:${value('MC_PORT', '25565')}`);
  const agentId = value('BOT_USERNAME', 'Curio');
  if (!worldId || worldId.length > 160 || !agentId || agentId.length > 64) throw new Error('记忆世界或角色标识无效');
  const endpoint = new URL(value('HINDSIGHT_URL', 'http://127.0.0.1:8888'));
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('HINDSIGHT_URL 必须为不含凭证、查询或片段的 HTTP(S) 地址');
  }
  const bounded = (key: string, fallback: number, min: number, max: number) => {
    const raw = value(key);
    const n = raw === '' ? fallback : Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${key} 必须为 ${min}–${max} 的整数`);
    return n;
  };
  return {
    provider,
    worldId,
    agentId,
    baseUrl: endpoint.toString().replace(/\/+$/, ''),
    apiKey: value('HINDSIGHT_API_KEY'),
    bankId: `mc-${createHash('sha256').update(JSON.stringify([worldId, agentId])).digest('hex').slice(0, 32)}`,
    timeoutMs: bounded('MEMORY_TIMEOUT_MS', 1500, 100, 15000),
    retainTimeoutMs: bounded('MEMORY_RETAIN_TIMEOUT_MS', 60000, 100, 180000),
    maxContextBytes: bounded('MEMORY_CONTEXT_MAX_BYTES', 6000, 512, 32000),
  };
}
