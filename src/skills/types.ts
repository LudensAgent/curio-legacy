import type { BlockHit, EntityInfo, GameAdapter, Vec3Like } from '../adapter/types.ts';
import type { EventBus } from '../events.ts';
import type { WorldMemory } from '../memory/store.ts';

export type FailureCode =
  | 'PATH_NOT_FOUND'
  | 'TIMEOUT'
  | 'NOT_FOUND'
  | 'TOOL_MISSING'
  | 'INVENTORY_FULL'
  | 'MISSING_MATERIALS'
  | 'NO_CRAFTING_TABLE'
  | 'UNKNOWN_ITEM'
  | 'BAD_ARGS'
  | 'NOT_CONNECTED'
  | 'STUCK'
  | 'TARGET_GONE'
  | 'NO_FOOD'
  | 'LOW_HP'
  | 'WRONG_DIMENSION'
  | 'ERROR';

export type SkillStatus = 'succeeded' | 'failed' | 'cancelled';

export interface SkillResult {
  status: SkillStatus;
  summary: string;
  failureCode?: FailureCode;
  data?: Record<string, unknown>;
}

/** 技能能用的“感官”：只有看见/听见/记得的东西，没有透视 */
export interface Senses {
  perceivedEntities(radius: number): EntityInfo[];
  knownBlocks(names: string[], maxDist: number): BlockHit[];
  /** 立即重新看一眼（转头之后调用） */
  refresh(): void;
  markSweep(): void;
  nearestLand?(here: Vec3Like, excluded?: Vec3Like[]): { dir: string; dist: number; pos: Vec3Like } | null;
}

export interface SkillCtx {
  adapter: GameAdapter;
  senses: Senses;
  memory: WorldMemory;
  bus: EventBus;
  signal: AbortSignal;
  deadline: number;
  taskId: string;
  /** 上报进度 0..1，供预规划和控制台使用 */
  progress(p: number, note?: string): void;
}

export type Validation<A> = { ok: true; args: A } | { ok: false; error: string };

export interface Skill<A = any> {
  name: string;
  /** 给 LLM 看的说明 */
  description: string;
  /** 给 LLM 看的参数格式 */
  argsDoc: string;
  timeoutMs: number;
  /** 是否属于移动型技能（用于卡死检测） */
  movement: boolean;
  /** Knowledge/archive queries do not count as failed physical project attempts. */
  readOnly?: boolean;
  validate(raw: unknown, adapter: GameAdapter): Validation<A>;
  run(ctx: SkillCtx, args: A): Promise<SkillResult>;
}

export const ok = (summary: string, data?: Record<string, unknown>): SkillResult => ({ status: 'succeeded', summary, data });
export const fail = (failureCode: FailureCode, summary: string, data?: Record<string, unknown>): SkillResult => ({
  status: 'failed',
  failureCode,
  summary,
  data,
});

/** 把底层异常归类为失败码。AbortedError 交给上层处理为 cancelled。 */
export function codeFromError(e: any): FailureCode {
  const name = String(e?.name ?? '');
  const msg = String(e?.message ?? e ?? '');
  if (name === 'TimeoutError' || /timeout/i.test(msg)) return 'TIMEOUT';
  if (/no ?path|NoPath|path was stopped|cannot reach|goal.*unreachable/i.test(msg)) return 'PATH_NOT_FOUND';
  if (/NOT_CONNECTED/.test(msg)) return 'NOT_CONNECTED';
  if (/ENTITY_GONE/.test(msg)) return 'TARGET_GONE';
  return 'ERROR';
}

export const isAbort = (e: any) => e?.name === 'AbortedError';

export function obj(raw: unknown): Record<string, any> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, any>) : {};
}

export function clampInt(v: unknown, min: number, max: number, def: number) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}
