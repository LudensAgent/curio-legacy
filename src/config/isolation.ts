/**
 * test 环境的隔离校验。纯函数，不连接游戏、不启动服务器、不建库、不写盘。
 *
 * 目标：test 是宿主运行环境（不等于单元测试进程），必须使用独立的连接配置、世界副本和运行状态，
 * 不能复用 local/live 的地址、数据库或数据目录。校验在 config 加载阶段完成，早于任何有副作用的初始化。
 *
 * 空间记忆库在本分支仍是 JSON 文件（world-memory.json，落在 dataDir 内），故这里只比较最终解析出的可写路径与端口，
 * 不引入尚未接线的 SQLite 空间库分支。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

export type EnvMode = 'local' | 'live' | 'test';

const ENV_MODES: readonly EnvMode[] = ['local', 'live', 'test'];

/** 一个环境最终解析出的布局：全部为绝对路径。 */
export interface Layout {
  mode: EnvMode;
  /** Curio 运行数据（记忆、账本、技能、日志、任务恢复）根目录。 */
  dataDir: string;
  /** Minecraft 服务器根目录（含世界与 server.properties）。 */
  serverDir: string;
  /** 角色档案目录。 */
  agentsDir: string;
  /** LLM 调用完整归档目录。 */
  llmArchiveDir: string;
  /** 弹幕归档目录。 */
  danmakuArchiveDir: string;
  /** 观察者 HUD 配置文件（单个文件）。 */
  observerHudConfig: string;
  /** 世界身份：空间记录按它分区，重启必须保持稳定。 */
  worldId: string;
  mcHost: string;
  mcPort: number;
  rconHost: string;
  rconPort: number;
  dashboardPort: number;
}

/** 该布局的可写目录（数据、世界、角色、归档）。 */
export function writableDirsOf(layout: Layout): string[] {
  return [layout.dataDir, layout.serverDir, layout.agentsDir, layout.llmArchiveDir, layout.danmakuArchiveDir];
}

/** 相对路径按 baseDir 解析；数字与默认值口径和 config.ts 保持一致。 */
export function resolveLayout(mode: EnvMode, vars: Record<string, string | undefined>, baseDir: string): Layout {
  const v = (key: string) => (vars[key] ?? '').trim();
  const num = (key: string, d: number) => {
    const n = Number(vars[key]);
    return Number.isFinite(n) && vars[key] !== undefined && vars[key] !== '' ? n : d;
  };
  const res = (value: string) => path.resolve(baseDir, value);
  const dataDir = res(v('DATA_DIR') || path.join('data', mode));
  const hudName = mode === 'live' ? 'observer-hud.json' : `observer-hud.${mode}.json`;
  return {
    mode,
    dataDir,
    serverDir: res(v('SERVER_DIR') || 'world'),
    agentsDir: res(v('AGENTS_DIR') || path.join('agents', mode)),
    llmArchiveDir: res(v('LLM_ARCHIVE_DIR') || path.join('archives', mode, 'llm-calls')),
    danmakuArchiveDir: res(v('DANMAKU_ARCHIVE_DIR') || path.join('archives', mode, 'danmaku')),
    observerHudConfig: res(v('OBSERVER_HUD_CONFIG') || path.join('live', hudName)),
    worldId: v('MEMORY_WORLD_ID') || `${v('MC_HOST') || '127.0.0.1'}:${num('MC_PORT', 25565)}`,
    mcHost: v('MC_HOST') || '127.0.0.1',
    mcPort: num('MC_PORT', 25565),
    rconHost: v('RCON_HOST') || '127.0.0.1',
    rconPort: num('RCON_PORT', 25575),
    dashboardPort: num('DASHBOARD_PORT', mode === 'live' ? 3000 : mode === 'test' ? 3002 : 3001),
  };
}

function readVars(file: string): Record<string, string | undefined> {
  return fs.existsSync(file) ? parseEnv(fs.readFileSync(file, 'utf8')) : {};
}

/** 读取当前模式之外其它环境的最终布局（公共 .env + 模式文件合并，不含本进程变量覆盖）。 */
export function peerLayouts(projectDir: string, curioRoot: string, currentMode: EnvMode): Layout[] {
  const out: Layout[] = [];
  for (const mode of ENV_MODES) {
    if (mode === currentMode) continue;
    const modeFile = curioRoot ? path.join(curioRoot, `.env.${mode}`) : path.join(projectDir, `.env.${mode}`);
    if (!fs.existsSync(modeFile)) continue;
    const vars = { ...readVars(path.join(path.dirname(modeFile), '.env')), ...readVars(modeFile) };
    out.push(resolveLayout(mode, vars, projectDir));
  }
  return out;
}

/** parent 与 child 相同，或 child 位于 parent 内部。 */
function sameOrNested(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function normalizeHost(host: string): string {
  let h = host.toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h === '0.0.0.0') h = '127.0.0.1';
  if (h === '::') h = '::1';
  return h;
}

/**
 * test 与已配置环境冲突时拒绝启动。调用方须在游戏连接、数据库打开等有副作用的初始化之前执行。
 * 只比较最终解析出的路径与端口，不做网络探测。
 */
export function assertTestIsolation(test: Layout, peers: Layout[], opts: { worldIdExplicit: boolean }): void {
  if (!opts.worldIdExplicit) {
    throw new Error('test 环境必须显式配置 MEMORY_WORLD_ID（不能沿用公共 .env 的默认值），否则无法保证独立的世界身份。');
  }
  const testDirs = writableDirsOf(test);
  for (const peer of peers) {
    for (const dir of testDirs) {
      for (const peerDir of writableDirsOf(peer)) {
        if (sameOrNested(peerDir, dir) || sameOrNested(dir, peerDir)) {
          throw new Error(`test 可写目录与 ${peer.mode} 冲突：${dir} 与 ${peerDir} 相同或相互包含。`);
        }
      }
    }
    if (test.observerHudConfig === peer.observerHudConfig) {
      throw new Error(`test 的 OBSERVER_HUD_CONFIG 与 ${peer.mode} 相同：${test.observerHudConfig}`);
    }
    if (test.worldId === peer.worldId) {
      throw new Error(`test 的 MEMORY_WORLD_ID 与 ${peer.mode} 相同：${test.worldId}`);
    }
    if (normalizeHost(test.mcHost) === normalizeHost(peer.mcHost) && test.mcPort === peer.mcPort) {
      throw new Error(`test 的游戏连接地址与 ${peer.mode} 冲突：${test.mcHost}:${test.mcPort}`);
    }
    if (normalizeHost(test.rconHost) === normalizeHost(peer.rconHost) && test.rconPort === peer.rconPort) {
      throw new Error(`test 的 RCON 地址与 ${peer.mode} 冲突：${test.rconHost}:${test.rconPort}`);
    }
    if (test.dashboardPort === peer.dashboardPort) {
      throw new Error(`test 的控制台端口与 ${peer.mode} 冲突：${test.dashboardPort}`);
    }
  }
}
