import type { BlockHit, BlockObservation, EntityInfo, GameAdapter, Vec3Like } from '../adapter/types.ts';
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
  | 'EFFECT_NOT_CONFIRMED'
  | 'ERROR';

export type SkillStatus = 'succeeded' | 'failed' | 'cancelled';

export interface SkillResult {
  status: SkillStatus;
  summary: string;
  failureCode?: FailureCode;
  data?: Record<string, unknown>;
}

export interface LandingOption {
  /** Feet/node position; water uses the surface water cell's integer y. */
  target: Vec3Like;
  support: { pos: Vec3Like; name: string };
  surface: 'ground' | 'water';
  surfaceY: number;
  horizontalDistance: number;
  /** Free fall to the surface, before entering water. */
  drop: number;
  clearance: 'clear' | 'blocked' | 'unknown';
  corridor: 'clear' | 'blocked' | 'unknown';
  approach: 'adjacent' | 'distant';
  waterDepth: 2 | 'unknown';
  unknowns: string[];
  receipt: { worldId: string; sessionId: string; dimension: string; observationId: number; at: number; from: Vec3Like; onGround?: boolean };
}

/** 技能能用的“感官”：只有看见/听见/记得的东西，没有透视 */
export interface Senses {
  perceivedEntities(radius: number): EntityInfo[];
  knownBlocks(names: string[], maxDist: number): BlockHit[];
  /** Fresh visible state only; occluded, unloaded and out-of-view targets are absent. */
  observeBlocks?(positions: Vec3Like[]): BlockObservation[];
  /** Bounded landing geometry from freshly visible surfaces, never hidden map queries. */
  landingOptions?(maxHorizontal?: number): LandingOption[];
  /** 立即重新看一眼（转头之后调用） */
  refresh(): void;
  markSweep(): void;
  nearestLand?(here: Vec3Like, excluded?: Vec3Like[]): { dir: string; dist: number; pos: Vec3Like } | null;
  /** 刚亲眼看到的落脚点；只给出短程引导，未观察的地形不能当作已知路。 */
  navigationWaypoint?(target: Vec3Like, maxDistance: number, excluded: Vec3Like[]): Vec3Like | null;
  /** 自己走过的落脚点里更靠近目标的一个（来时的路）；只用亲身到过的位置 */
  rememberedWaypoint?(target: Vec3Like, maxDistance: number, excluded: Vec3Like[]): Vec3Like | null;
  /** 最近亲眼看见的某类生物的最后位置 */
  lastSighting?(match: (name: string) => boolean, maxAgeMs?: number): { id: number; name: string; pos: Vec3Like; ageMs: number } | null;
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
  /** 下一步取决于本次实际发现/产出；自主计划在结果返回后重新选择，不能预设成功后的尾部。 */
  outcomeBoundary?: boolean;
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
  if (/no ?path|NoPath|path was stopped|cannot reach|goal.*unreachable|took to+ long to decide path/i.test(msg)) return 'PATH_NOT_FOUND';
  if (/NOT_CONNECTED/.test(msg)) return 'NOT_CONNECTED';
  if (/NO_EFFECT|NOT_CONFIRMED|STATE_UNCHANGED|INVENTORY_UNCHANGED|NO_PLACEMENT_FACE/.test(msg)) return 'EFFECT_NOT_CONFIRMED';
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
