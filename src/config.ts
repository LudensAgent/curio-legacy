import fs from 'node:fs';
import path from 'node:path';
import { memorySettings } from './memory/settings.ts';

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
    /** 死亡不掉落。默认关闭：死了要自己回去捡（更像真人玩） */
    keepInventory: bool('KEEP_INVENTORY', false),
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
    timeoutMs: num('LLM_TIMEOUT_MS', 120000),
    maxTokens: num('LLM_MAX_TOKENS', 16384),
    /** Conservative serialized prompt budget, checked after memory/tool/retry messages. */
    maxPromptTokens: num('LLM_MAX_PROMPT_TOKENS', 128000),
    /** Soft compaction starts before either the input budget or model context is full. */
    contextWindowTokens: num('LLM_CONTEXT_WINDOW_TOKENS', 1000000),
    compactAtRatio: num('LLM_COMPACT_AT_RATIO', 0.75),
    maxRecallRounds: num('LLM_MAX_RECALL_ROUNDS', 2),
    /** Enable only for a configured model that accepts image_url inputs. */
    visionInput: bool('LLM_VISION_INPUT', false),
    /** 流式请求：控制台能实时看到模型的输出；服务端不支持会自动回退 */
    stream: bool('LLM_STREAM', true),
    /** 小决策是否让模型先长篇思考：auto = DeepSeek 时关闭（小决策要快，信息才不会过时）；on = 不干预；off = 总是发送关闭思考的参数 */
    lightThinking: str('LLM_LIGHT_THINKING', 'auto').toLowerCase(),
    /** 认真想时的推理力度（DeepSeek：low|high|max）；auto = DeepSeek 用 low，其他不发。建筑设计固定用 high */
    reasoningEffort: str('LLM_REASONING_EFFORT', 'auto').toLowerCase(),
    maxCallsPerHour: num('LLM_MAX_CALLS_PER_HOUR', 90),
    fakeDelayMs: num('LLM_FAKE_DELAY_MS', 0),
    /** 价格覆盖（每百万 token：命中,未命中,输出[,币种]）；不写就用内置的 DeepSeek 价格表 */
    price: str('LLM_PRICE'),
    /** 按闲时价算的法定节假日（北京时间日期，逗号分隔），DeepSeek 高峰价只在工作日生效 */
    priceHolidays: str('LLM_PRICE_HOLIDAYS').split(',').map((s) => s.trim()).filter(Boolean),
  },
  /**
   * 后台写代码用的模型（造技能、改进代码技能）：不赶时间，可以用更强、更慢的模型。
   * 不设 CODER_LLM_MODEL 就和主心智用同一个模型；没写的项沿用 LLM_*。
   */
  coder: {
    model: str('CODER_LLM_MODEL'),
    baseUrl: str('CODER_LLM_BASE_URL').replace(/\/+$/, ''),
    apiKey: str('CODER_LLM_API_KEY'),
    reasoningEffort: str('CODER_LLM_REASONING_EFFORT', 'high').toLowerCase(),
    maxTokens: num('CODER_LLM_MAX_TOKENS', 32768),
    timeoutMs: num('CODER_LLM_TIMEOUT_MS', 300000),
    maxCallsPerHour: num('CODER_LLM_MAX_CALLS_PER_HOUR', 1000),
    price: str('CODER_LLM_PRICE'),
  },
  persona: str(
    'AGENT_PERSONA',
    '你叫 Curio，一个好奇、谨慎、喜欢记录新发现的 Minecraft 探险家。',
  ),
  memory: memorySettings(),
  /** 心智层：像真人一样一段一段地玩、边做边想 */
  mind: {
    /** 性格关键词（逗号分隔），会进入每次思考，也保存在 data/mind.json */
    traits: str('AGENT_TRAITS', '好奇,谨慎,喜欢记录新发现,有点恋家').split(/[,，]/).map((s) => s.trim()).filter(Boolean),
    /** 身体习惯：饿了顺手吃、黑了顺手插火把、卡住自己挣脱（像真人一样不用过脑子） */
    bodyHabits: bool('MIND_BODY_HABITS', false),
    /** 一段活做了多久没抬头，就看一眼（秒） */
    checkInSec: num('MIND_CHECK_IN_SEC', 100),
    /** 只瞥一眼多久之后要认真想想全局（秒） */
    deliberateEverySec: num('MIND_DELIBERATE_EVERY_SEC', 360),
    /** 代码技能后台改进的最小间隔（分钟）：默认 0 不限频，同一时间只改一份 */
    skillImproveGapMin: num('SKILL_IMPROVE_GAP_MIN', 0),
  },
  learning: {
    /** Only explicitly designated isolated worlds may provide candidate promotion evidence. */
    testWorldIds: str('LEARNING_TEST_WORLD_IDS').split(',').map((s) => s.trim()).filter(Boolean),
  },
  /** 直播间接入：弹幕作为“观众的声音”给决策参考（不可信的外部信息，不会当作指令） */
  live: {
    bilibili: {
      enabled: bool('BILIBILI_ENABLED', false),
      /** web：直播间号（免登录可用，昵称会被打码）；open：B 站直播开放平台 + 主播身份码（官方互动玩法接口） */
      mode: (str('BILIBILI_MODE', 'web').toLowerCase() === 'open' ? 'open' : 'web') as 'web' | 'open',
      roomId: num('BILIBILI_ROOM_ID', 0),
      /** 可选：登录 cookie（SESSDATA=…; buvid3=…），能看到观众昵称；不会写进日志 */
      cookie: str('BILIBILI_COOKIE'),
      uid: num('BILIBILI_UID', 0),
      open: {
        appId: num('BILIBILI_OPEN_APP_ID', 0),
        accessKey: str('BILIBILI_OPEN_ACCESS_KEY'),
        accessSecret: str('BILIBILI_OPEN_ACCESS_SECRET'),
        code: str('BILIBILI_OPEN_CODE'),
      },
    },
    audience: {
      /** 仅 danmaku 事件携带清洗后的昵称；游戏 LLM 始终只见匿名代号 */
      showNames: bool('LIVE_SHOW_NAMES', false),
      maxInPrompt: num('AUDIENCE_MAX_IN_PROMPT', 6),
      windowSec: num('AUDIENCE_WINDOW_SEC', 180),
      perUserGapSec: num('AUDIENCE_PER_USER_GAP_SEC', 8),
      blockWords: str('AUDIENCE_BLOCK_WORDS').split(',').map((s) => s.trim()).filter(Boolean),
    },
  },
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
  /** Curio Observer 模组数据流（/api/observer/stream）。合成节奏由 UI_PACING_MS 等环境变量控制 */
  observerFeed: bool('OBSERVER_FEED', true),
  viewerPort: num('VIEWER_PORT', 0),
  actionChat: { enabled: bool('CHAT_ACTIONS', true), minIntervalMs: num('CHAT_ACTION_INTERVAL_MS', 1800) },
  dataDir: path.resolve(str('DATA_DIR', './data')),
  /** 每次 LLM 调用的完整记录（提示词、思考过程、完整回复）：放在数据目录外面，清空记忆、重置世界都不会删 */
  llmArchiveDir: path.resolve(str('LLM_ARCHIVE_DIR', './archives/llm-calls')),
  /** 收到的每条弹幕（含被拦下的）按天存档，方便复盘和找观众的问题：同样放在数据目录外 */
  danmakuArchiveDir: path.resolve(str('DANMAKU_ARCHIVE_DIR', './archives/danmaku')),
  /** 观察者模组 HUD 的布局和开关（控制台「直播」页修改）：直播设置，不跟着角色存档走 */
  observerHudConfig: path.resolve(str('OBSERVER_HUD_CONFIG', './live/observer-hud.json')),
};

export type Config = typeof config;
