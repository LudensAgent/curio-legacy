/** 只读检查 Hindsight 版本与数据库就绪状态，不创建 bank 或上传游戏历史。 */
import { createClient, createConfig, sdk } from '@vectorize-io/hindsight-client';
import { config } from '../src/config.ts';

if (config.memory.provider === 'local') {
  console.log('当前使用本地记忆。启用 MEMORY_PROVIDER=hindsight 后可检查 Hindsight 服务。');
} else {
  const signal = AbortSignal.timeout(Math.max(config.memory.timeoutMs, 10_000));
  const client = createClient(createConfig({
    baseUrl: config.memory.baseUrl,
    headers: config.memory.apiKey ? { Authorization: `Bearer ${config.memory.apiKey}` } : {},
  }));
  try {
    const [health, version] = await Promise.all([
      sdk.getReadiness({ client, signal }),
      sdk.getVersion({ client, signal }),
    ]);
    if (!health.response?.ok || !version.response?.ok) {
      console.error(`Hindsight 检查失败：就绪状态 HTTP ${health.response?.status ?? '无响应'}，版本 HTTP ${version.response?.status ?? '无响应'}。`);
      process.exitCode = 1;
    } else if (!version.data || typeof version.data.api_version !== 'string') {
      console.error('Hindsight 检查失败：服务返回的版本格式无效。');
      process.exitCode = 1;
    } else {
      const apiVersion = version.data.api_version.replace(/[^a-zA-Z0-9.+_-]/g, '').slice(0, 40);
      console.log(`Hindsight API ${apiVersion} 可达，数据库已就绪。`);
      console.log('这是只读连通检查；尚未验证 LLM 抽取、游戏经历写入或召回质量。');
    }
  } catch {
    // SDK/network error details can contain response bodies or endpoint credentials.
    console.error(signal.aborted
      ? 'Hindsight 检查超时；请确认服务已完成初始化。'
      : 'Hindsight 连接失败；请检查服务状态、HINDSIGHT_URL 和服务访问凭证。');
    process.exitCode = 1;
  }
}
