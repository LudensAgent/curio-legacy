import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { memorySettings } from './memory/settings.ts';

// CURIO_ROOT：env + 数据放在项目外（如 /path/to/curio）时，用裸关键字 live / local 定位 $CURIO_ROOT/.env.<mode>。
// 优先进程环境变量，其次读项目根目录 .env（与 scripts/supervise.mjs 保持一致）。
const curioRoot = (() => {
  const fromEnv = process.env.CURIO_ROOT?.trim();
  if (fromEnv) return fromEnv;
  const f = path.resolve('.env');
  return fs.existsSync(f) ? (parseEnv(fs.readFileSync(f, 'utf8')).CURIO_ROOT?.trim() ?? '') : '';
})();
const curioArg = process.argv.find((arg) => arg.startsWith('--curio='))?.slice('--curio='.length);
if (curioArg && curioArg !== 'live' && curioArg !== 'local') throw new Error(`--curio 只支持 live / local，收到：${curioArg}`);
const selectedEnvRaw = curioArg
  || process.execArgv.find((arg) => arg.startsWith('--env-file='))?.slice('--env-file='.length)
  || process.env.ENV_FILE?.trim();
const isBareMode = selectedEnvRaw === 'live' || selectedEnvRaw === 'local';
if (isBareMode && !curioRoot) throw new Error(`裸模式 ${selectedEnvRaw} 需要 CURIO_ROOT（进程环境变量或项目根目录 .env 里设置）`);
const selectedEnv = isBareMode ? path.join(curioRoot, `.env.${selectedEnvRaw}`) : selectedEnvRaw;
export const envFile = path.resolve(selectedEnv || '.env');
const hasEnv = fs.existsSync(envFile);
if (selectedEnvRaw && !hasEnv) throw new Error(`找不到配置文件：${envFile}`);

// 公共 .env + 模式覆盖文件（.env.local / .env.live / 自定义）合并。
// 优先级：进程环境变量 > 模式文件 > 公共 .env（process.loadEnvFile 会覆盖已存在的变量，故手动合并再按序回填）。
const readVars = (file: string) => (fs.existsSync(file) ? parseEnv(fs.readFileSync(file, 'utf8')) : {});
const merged = { ...readVars(path.join(path.dirname(envFile), '.env')), ...readVars(envFile) };
for (const [k, v] of Object.entries(merged)) {
  if (v !== undefined && process.env[k] === undefined) process.env[k] = v;
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
const configuredMode = str('CURIO_MODE', 'local');
if (configuredMode !== 'local' && configuredMode !== 'live') throw new Error('CURIO_MODE 必须为 local 或 live');
const mode = path.basename(envFile) === '.env.live' ? 'live' : configuredMode;
const dataDir = path.resolve(str('DATA_DIR') || `./data/${mode}`);

export const config = {
  mode,
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
    /** 模型上下文窗口大小，用作 maxPromptTokens 的上界（当前没有压缩机制，只做硬上限） */
    contextWindowTokens: num('LLM_CONTEXT_WINDOW_TOKENS', 1000000),
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
    /**
     * 写代码的推理力度（DeepSeek：low|high|max）。默认 low：两天的调用记录对比下来，想得越久写出的技能反而越差
     * （改进时想 2–10K token 的新版 76% 不比旧版差，想 13K+ 的只有 58%），长思考大多花在反复重写同一段代码上。
     * 三类调用可以分别覆盖：CODER_LLM_REASONING_EFFORT_FORGE（总结新技能）/ _IMPROVE（改进）/ _CURATE（整理技能库）。
     */
    reasoningEffort: str('CODER_LLM_REASONING_EFFORT', 'low').toLowerCase(),
    reasoningEffortBy: {
      forge: str('CODER_LLM_REASONING_EFFORT_FORGE').toLowerCase(),
      improve: str('CODER_LLM_REASONING_EFFORT_IMPROVE').toLowerCase(),
      curate: str('CODER_LLM_REASONING_EFFORT_CURATE').toLowerCase(),
    } as Record<string, string>,
    maxTokens: num('CODER_LLM_MAX_TOKENS', 32768),
    timeoutMs: num('CODER_LLM_TIMEOUT_MS', 300000),
    maxCallsPerHour: num('CODER_LLM_MAX_CALLS_PER_HOUR', 1000),
    price: str('CODER_LLM_PRICE'),
  },
  persona: str(
    'AGENT_PERSONA',
    '你叫 Muses，一个目标明确、喜欢记录新发现的 Minecraft 探险家，一路从空手求生走向打败末影龙：砍树做工具、下矿炼铁、进下界拿烈焰棒、合成末影之眼找到要塞，最后在末地解放末影龙。',
  ),
  memory: memorySettings({ ...process.env, DATA_DIR: dataDir }),
  /** 心智层：像真人一样一段一段地玩、边做边想 */
  mind: {
    /** 性格关键词（逗号分隔），会进入每次思考，也保存在 DATA_DIR/mind.json */
    traits: str('AGENT_TRAITS', '好奇,谨慎,喜欢记录新发现,目标明确,喜欢升级装备,向往打败末影龙').split(/[,，]/).map((s) => s.trim()).filter(Boolean),
    /** 身体习惯：饿了顺手吃、卡住自己挣脱；自动照明由 Agent 的 torch_every 习惯单独选择。 */
    bodyHabits: bool('MIND_BODY_HABITS', false),
    /** 一段活做了多久没抬头，就看一眼（秒） */
    checkInSec: num('MIND_CHECK_IN_SEC', 100),
    /** 只瞥一眼多久之后要认真想想全局（秒） */
    deliberateEverySec: num('MIND_DELIBERATE_EVERY_SEC', 360),
    /** 代码技能后台改进的最小间隔（分钟）：默认 0 不限频，同一时间只改一份 */
    skillImproveGapMin: num('SKILL_IMPROVE_GAP_MIN', 0),
    /** 后台改进代码技能每小时最多几次 */
    skillImproveMaxPerHour: num('SKILL_IMPROVE_MAX_PER_HOUR', 12),
    /** 同一份代码技能最多改几轮：改了这么多版还不可靠就收起，别再无休止地改（上次测试有一份改了 34 次） */
    skillImproveMaxRounds: num('SKILL_IMPROVE_MAX_ROUNDS', 5),
    /** 后台写技能每小时最多请模型几次（死亡不算）；同一件事多少分钟内不再请第二次 */
    skillForgeMaxPerHour: num('SKILL_FORGE_MAX_PER_HOUR', 24),
    skillForgeRepeatMin: num('SKILL_FORGE_REPEAT_MIN', 20),
    /** 后台写技能攒批：第一件事进队后等多少秒，把这段时间的事一次请模型看完（死亡不等）；0 = 不攒 */
    skillForgeBatchSec: num('SKILL_FORGE_BATCH_SEC', 180),
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
      /** 是否把弹幕纳入思考（进入 LLM 上下文）；关掉后弹幕仍显示/存档/参与「房子够了」共识，只是不再喂给模型 */
      inPrompt: bool('AUDIENCE_IN_PROMPT', true),
      maxInPrompt: num('AUDIENCE_MAX_IN_PROMPT', 6),
      windowSec: num('AUDIENCE_WINDOW_SEC', 180),
      perUserGapSec: num('AUDIENCE_PER_USER_GAP_SEC', 8),
      blockWords: str('AUDIENCE_BLOCK_WORDS').split(',').map((s) => s.trim()).filter(Boolean),
    },
  },
  dashboard: {
    host: str('DASHBOARD_HOST', '127.0.0.1'),
    port: num('DASHBOARD_PORT', mode === 'live' ? 3000 : 3001),
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
    /** 身边方块图（localMap）的水平半径：2=5×5，4=9×9，最大 8=17×17 */
    localRadius: num('LOCAL_MAP_RADIUS', 4),
  },
  /** Curio Observer 模组数据流（/api/observer/stream） */
  observerFeed: bool('OBSERVER_FEED', true),
  /** 界面点击、打开和关闭的等待；逐次点击默认约 300ms，模拟真实玩家节奏（0 关闭）。 */
  ui: { pacingMs: num('UI_PACING_MS', 300), openHoldMs: num('UI_OPEN_HOLD_MS', 600), closeHoldMs: num('UI_CLOSE_HOLD_MS', 800) },
  viewerPort: num('VIEWER_PORT', 0),
  actionChat: { enabled: bool('CHAT_ACTIONS', true), minIntervalMs: num('CHAT_ACTION_INTERVAL_MS', 1800) },
  dataDir,
  /** 堆用到这么多 MB 时写一份堆快照到 DATA_DIR/logs（每个进程一次），查内存是谁占的；0 = 不写。平时堆只有一两百 MB */
  heapSnapshotMb: num('HEAP_SNAPSHOT_MB', 1024),
  /** 每次 LLM 调用的完整记录（提示词、思考过程、完整回复）：放在数据目录外面，清空记忆、重置世界都不会删 */
  llmArchiveDir: path.resolve(str('LLM_ARCHIVE_DIR', `./archives/${mode}/llm-calls`)),
  /** 收到的每条弹幕（含被拦下的）按天存档，方便复盘和找观众的问题：同样放在数据目录外 */
  danmakuArchiveDir: path.resolve(str('DANMAKU_ARCHIVE_DIR', `./archives/${mode}/danmaku`)),
  /** 记忆服务（Hindsight）所用模型的价格覆盖，格式同 LLM_PRICE；不写就按它上报的模型名查内置价格表 */
  memoryLlmPrice: str('MEMORY_LLM_PRICE'),
  /** 观察者模组 HUD 的布局和开关（控制台「直播」页修改）：直播设置，不跟着角色存档走 */
  observerHudConfig: path.resolve(str('OBSERVER_HUD_CONFIG', mode === 'live' ? './live/observer-hud.json' : './live/observer-hud.local.json')),
};

export type Config = typeof config;

export function requireLocalMode(action: string) {
  if (config.mode === 'live') throw new Error(`直播配置不执行${action}，请使用本地配置。`);
}
