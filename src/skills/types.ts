import type { BlockHit, BlockObservation, EntityInfo, GameAdapter, Vec3Like } from '../adapter/types.ts';
import type { EventBus } from '../events.ts';
import type { WorldMemory } from '../memory/store.ts';
import type { RecoveryContext } from './recovery.ts';

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
  /** 动作成功但附带、需要心智掂量的事实（如“这格是人造建材，可能是村庄房子”）。
   *  不进摘要：摘要会被 160/80 字符截断、又在活动收工时被通用句替换，进不了决策提示词；
   *  caveat 单独透给决策提示词，避免被截断或埋进活动摘要。 */
  caveat?: string;
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
  /** 这一格认得出是什么：刚看见或之前亲眼见过的；没见过就 null（不透视） */
  recognizedAt?(pos: Vec3Like): string | null;
  /** 最近亲眼看见的某类生物的最后位置 */
  lastSighting?(match: (name: string) => boolean, maxAgeMs?: number): { id: number; name: string; pos: Vec3Like; ageMs: number } | null;
  /** 最近亲眼看见过、现在不在视野里的掉落物 */
  recentDrops?(maxAgeMs?: number): { id: number; name: string; pos: Vec3Like; ageMs: number }[];
  forgetDrop?(id: number): void;
}

export interface SkillCtx {
  adapter: GameAdapter;
  /** Task ownership guard before per-skill preparation permissions are applied. */
  actionAdapter?: GameAdapter;
  /** Only true authorizes preparation; false also forbids nested opt-in. */
  make?: boolean;
  senses: Senses;
  memory: WorldMemory;
  bus: EventBus;
  signal: AbortSignal;
  deadline: number;
  taskId: string;
  /** Original delegation inherited by recovery and nested learned skills. */
  recovery?: RecoveryContext;
  /** 上报进度 0..1，供预规划和控制台使用 */
  progress(p: number, note?: string): void;
  /** Bounded stationary work suspends only the movement stall check, including nested calls. */
  setStationaryWait?(waiting: boolean): void;
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

/** Preserve shared execution options even when a skill normalizes its own arguments. */
export function validateSkill<A>(skill: Skill<A>, raw: unknown, adapter: GameAdapter): Validation<A & { make?: boolean }> {
  const options = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  if (options.make !== undefined && typeof options.make !== 'boolean') return { ok: false, error: 'make 必须是 boolean' };
  const validation = skill.validate(raw, adapter);
  if (!validation.ok) return validation;
  return { ok: true, args: { ...validation.args, ...(options.make !== undefined ? { make: options.make as boolean } : {}) } };
}

/** Bind preparation to this explicit action, preserving the task guard across nested calls. */
export function runSkill<A>(ctx: SkillCtx, skill: Skill<A>, args: A & { make?: boolean }): Promise<SkillResult> {
  if (ctx.make === false && args.make === true) return Promise.resolve(fail('BAD_ARGS', '外层动作已指定 make:false，嵌套动作不能开启自动准备'));
  const make = args.make ?? ctx.make;
  const actionAdapter = ctx.actionAdapter ?? ctx.adapter;
  const adapter = new Proxy(actionAdapter, {
    get(target, property) {
      if (property === 'craft') return (...call: Parameters<GameAdapter['craft']>) => {
        if (skill.name !== 'craft' && make !== true) throw new Error(`NO_MAKE: 未授权自动准备（make:true），不顺手做 ${call[0]}`);
        return target.craft(call[0], call[1], call[2], { ...call[3], prepare: make === true });
      };
      if (property === 'smelt') return (...call: Parameters<GameAdapter['smelt']>) => target.smelt(call[0], call[1], call[2], call[3], { ...call[4], prepare: make === true });
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return skill.run({ ...ctx, adapter, actionAdapter, make }, args).catch((error: unknown) => {
    if (isAbort(error)) throw error;
    return fail(codeFromError(error), error instanceof Error ? error.message : String(error));
  });
}

export const ok = (summary: string, data?: Record<string, unknown>, caveat?: string): SkillResult => ({ status: 'succeeded', summary, data, ...(caveat ? { caveat } : {}) });
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
