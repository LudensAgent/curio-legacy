import fs from 'node:fs';
import path from 'node:path';

if (fs.existsSync('.env') && typeof (process as any).loadEnvFile === 'function') {
  (process as any).loadEnvFile('.env');
}

const str = (k: string, d = '') => (process.env[k] ?? d).trim();
const num = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && process.env[k] !== '' && process.env[k] !== undefined ? v : d;
};
const bool = (k: string, d: boolean) => {
  const v = process.env[k];
  if (v === undefined || v === '') return d;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
};

const observer = str('OBSERVER_PLAYER');

export const config = {
  mc: {
    host: str('MC_HOST', '127.0.0.1'),
    port: num('MC_PORT', 25565),
    version: str('MC_VERSION', '1.20.1'),
    username: str('BOT_USERNAME', 'Curio'),
  },
  observer: {
    player: observer,
    rconHost: str('RCON_HOST', '127.0.0.1'),
    rconPort: num('RCON_PORT', 25575),
    rconPassword: str('RCON_PASSWORD'),
    setupGamerules: bool('SETUP_GAMERULES', true),
    admins: [observer, ...str('ADMIN_PLAYERS').split(',')].map((s) => s.trim()).filter(Boolean),
  },
  llm: {
    /** 除 mock 以外的任何值（openai / deepseek / ollama …）都走 OpenAI 兼容接口 */
    provider: (str('LLM_PROVIDER', 'mock').toLowerCase() === 'mock' ? 'mock' : 'openai') as 'mock' | 'openai',
    providerLabel: str('LLM_PROVIDER', 'mock'),
    baseUrl: str('LLM_BASE_URL', 'https://api.openai.com/v1').replace(/\/+$/, ''),
    apiKey: str('LLM_API_KEY'),
    model: str('LLM_MODEL', 'gpt-4o-mini'),
    temperature: num('LLM_TEMPERATURE', 0.7),
    jsonMode: bool('LLM_JSON_MODE', true),
    timeoutMs: num('LLM_TIMEOUT_MS', 45000),
    maxCallsPerHour: num('LLM_MAX_CALLS_PER_HOUR', 90),
    fakeDelayMs: num('LLM_FAKE_DELAY_MS', 0),
  },
  persona: str(
    'AGENT_PERSONA',
    '你叫 Curio，一个好奇、谨慎、喜欢记录新发现的 Minecraft 探险家。',
  ),
  dashboard: {
    host: str('DASHBOARD_HOST', '127.0.0.1'),
    port: num('DASHBOARD_PORT', 3000),
  },
  vision: {
    // 0 或 auto = 跟随服务器 view-distance
    range: str('VISION_RANGE', 'auto').toLowerCase() === 'auto' ? 0 : num('VISION_RANGE', 0),
    hFov: num('VISION_FOV', 100),
    vFov: num('VISION_VFOV', 60),
    cols: num('VISION_COLS', 40),
    rows: num('VISION_ROWS', 24),
    hearRadius: num('VISION_HEAR', 10),
    bandCols: num('VISION_BAND_COLS', 160),
    bandRows: num('VISION_BAND_ROWS', 8),
  },
  viewerPort: num('VIEWER_PORT', 0),
  dataDir: path.resolve(str('DATA_DIR', './data')),
};

export type Config = typeof config;
