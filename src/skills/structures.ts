import type { BlockHit, EntityInfo, Vec3Like } from '../adapter/types.ts';
import { AbortedError, dist3, sleep, throwIfAborted } from '../util.ts';
import { EYE_DESCENT_LABEL, excavatePath, excavationSkill, trustedExcavationEntry, type ExcavationArgs } from './excavation.ts';
import { codeFromError, fail, isAbort, obj, ok, type Skill, type SkillCtx } from './types.ts';

/** Known blocks can include old, currently occluded memories. Structure proof
 * requires the current visual frame, followed by an actual block check. */
function currentPortalFrame(ctx: SkillCtx): BlockHit | undefined {
  const visible = (ctx.senses as typeof ctx.senses & { visibleNow?: Map<string, BlockHit> }).visibleNow;
  const state = ctx.adapter.state();
  if (!state.observationReady || !state.connected || !state.alive || !(visible instanceof Map)) return undefined;
  return [...visible.values()].find((block) => block.name === 'end_portal_frame' && dist3(block.pos, state.pos) <= 32 && ctx.adapter.blockAt(block.pos) === 'end_portal_frame');
}

export const findStronghold: Skill<{ throws: number; step: number }> = {
  name: 'find_stronghold',
  description: '在主世界投掷末影之眼，只跟随真实看见的眼迹移动；下降眼迹仅记录地下搜索点，必须实际看见末地门框才报告找到门室。不会调用定位作弊接口。',
  argsDoc: '{"throws"?:1-6,"step"?:8-64}', timeoutMs: 240000, movement: true,
  validate(raw) {
    const value = obj(raw), throws = value.throws ?? 2, step = value.step ?? 48;
    return Number.isInteger(throws) && throws >= 1 && throws <= 6 && Number.isInteger(step) && step >= 8 && step <= 64 ? { ok: true, args: { throws, step } } : { ok: false, error: 'throws 为 1-6，step 为 8-64' };
  },
  async run(ctx, args) {
    const { adapter, senses, signal } = ctx;
    throwIfAborted(signal);
    if (adapter.state().dim !== 'overworld') return fail('WRONG_DIMENSION', '末影之眼寻路仅在主世界进行');
    if (!adapter.useItem) return fail('ERROR', '适配器没有物品使用能力');
    if (!adapter.state().observationReady) return fail('NOT_CONNECTED', '需要有效观测才能搜索结构');
    ctx.memory.setWorld(adapter.state().worldId);
    const traces: { origin: Vec3Like; samples: Vec3Like[]; descent: boolean }[] = [];
    try {
      for (let attempt = 0; attempt < args.throws; attempt++) {
        senses.refresh();
        const frame = currentPortalFrame(ctx);
        if (frame) {
          ctx.memory.addLandmark('discovery', '实际末地门室门框', adapter.state().dim, frame.pos, 4);
          return ok('已实际观察到末地门框，找到门室线索', { structureVerified: true, marker: frame, traces });
        }
        const state = adapter.state();
        if (!(state.inventory.find((i) => i.name === 'ender_eye')?.count)) return fail('MISSING_MATERIALS', '缺少末影之眼，保留已有眼迹', { traces });
        const oldEyes = new Set(senses.perceivedEntities(64).filter((e) => e.name === 'eye_of_ender').map((e) => e.id));
        const eye = adapter.eye();
        await adapter.look(eye?.yaw ?? 0, 0.25, signal);
        const used = await adapter.useItem('ender_eye', signal);
        if (!used.ok) return fail('ERROR', `投掷末影之眼失败：${used.reason}`, { traces });
        const samples: Vec3Like[] = [];
        let tracked: EntityInfo | undefined;
        for (let sample = 0; sample < 18; sample++) {
          await sleep(150, signal);
          senses.refresh();
          const eyes = senses.perceivedEntities(64).filter((e) => e.name === 'eye_of_ender' && !oldEyes.has(e.id));
          tracked = tracked ? eyes.find((e) => e.id === tracked!.id) : eyes[0];
          if (tracked) {
            samples.push({ ...tracked.pos });
            const delta = { x: tracked.pos.x - adapter.state().pos.x, y: tracked.pos.y - adapter.state().pos.y - 1.62, z: tracked.pos.z - adapter.state().pos.z };
            await adapter.look(Math.atan2(-delta.x, -delta.z), Math.atan2(delta.y, Math.hypot(delta.x, delta.z)), signal);
          } else if (!samples.length && sample % 3 === 2) {
            const current = adapter.eye();
            await adapter.look((current?.yaw ?? 0) + Math.PI / 3, 0.3, signal);
          }
        }
        if (samples.length < 2 || dist3(samples[0], samples[samples.length - 1]) < 1) return fail('NOT_FOUND', '没有获得足够的可见眼迹，不能猜测要塞方向', { traces });
        const last = samples[samples.length - 1];
        const descent = last.y < samples[0].y - 0.75;
        traces.push({ origin: state.pos, samples, descent });
        if (descent) {
          const landmark = ctx.memory.addLandmark('waypoint', `${EYE_DESCENT_LABEL}（尚未发现要塞）`, state.dim, last, 8);
          const entryId = landmark?.id ?? ctx.memory.landmarks().find((entry) => entry.dim === state.dim && entry.label.startsWith(EYE_DESCENT_LABEL) && dist3(entry.pos, last) < 8)?.id;
          return ok('末影之眼向地下移动，已记录实际搜索点；尚未实际发现要塞。需要另行显式选择开挖/已知入口搜索方法', { structureVerified: false, searchPosition: last, entryId, traces });
        }
        const dx = last.x - state.pos.x, dz = last.z - state.pos.z;
        const horizontal = Math.hypot(dx, dz);
        if (horizontal < 2) return fail('NOT_FOUND', '眼迹水平位移太小，保留观察并等待其他方法', { traces });
        await adapter.moveTo({ kind: 'xz', x: state.pos.x + dx / horizontal * args.step, z: state.pos.z + dz / horizontal * args.step, range: 3 }, { signal, timeoutMs: 60000 });
        ctx.progress((attempt + 1) / args.throws, '根据实际眼迹探索');
      }
      return ok('已按实际眼迹推进搜索，尚未观察到末地门框', { structureVerified: false, traces });
    } catch (error) { if (isAbort(error)) throw error; return fail(codeFromError(error), `要塞搜索中断：${(error as Error).message}`, { traces }); }
  },
};

interface StructureSearchArgs {
  kind: 'stronghold';
  method?: 'eye' | 'excavate' | 'room_search';
  entry?: string;
  direction?: ExcavationArgs['direction'];
  steps?: number;
}
export const searchStructure: Skill<StructureSearchArgs> = {
  name: 'search_structure', description: '模型显式选择眼迹、从可信下降/已探索入口挖阶梯，或在当前层开挖单条门室搜索通道。后两种每次最多8格，不保证覆盖地下；只有当前实际看到末地门框才确认结构。', argsDoc: '{"kind":"stronghold","method"?:"eye|excavate|room_search","entry"?:"<waypointId>","direction"?:"north|east|south|west","steps"?:1-8}', timeoutMs: 240000, movement: true,
  validate(raw, adapter) {
    const value = obj(raw), method = value.method ?? 'eye';
    if (value.kind !== 'stronghold' || !['eye', 'excavate', 'room_search'].includes(method)) return { ok: false, error: 'kind=stronghold；method=eye|excavate|room_search' };
    if (method === 'eye') return { ok: true, args: { kind: 'stronghold', method } };
    const validation = excavationSkill.validate({ entry: value.entry, direction: value.direction, steps: value.steps, mode: method === 'excavate' ? 'stairs' : 'tunnel' }, adapter);
    if (!validation.ok) return validation;
    if (validation.args.entry === 'current') return { ok: false, error: '要塞地下搜索需要眼迹下降点或实际探索入口ID，不能凭空选择坐标' };
    return { ok: true, args: { kind: 'stronghold', method, entry: validation.args.entry, direction: validation.args.direction, steps: validation.args.steps } };
  },
  async run(ctx, args) {
    throwIfAborted(ctx.signal);
    if (!['eye', 'excavate', 'room_search'].includes(args.method ?? 'eye')) return fail('BAD_ARGS', '必须显式选择受支持的结构搜索方法', { structureVerified: false });
    if (!args.method || args.method === 'eye') return findStronghold.run(ctx, { throws: 2, step: 48 });
    const state = ctx.adapter.state();
    if (state.dim !== 'overworld') return fail('WRONG_DIMENSION', '要塞地下搜索仅在主世界进行');
    if (!state.observationReady || !state.connected || !state.alive) return fail('NOT_CONNECTED', '需要有效观测才能搜索结构');
    ctx.memory.setWorld(state.worldId);
    if (!args.entry || !trustedExcavationEntry(ctx, args.entry, true)) return fail('BAD_ARGS', '没有当前世界的实际眼迹下降点或已探索入口，未开始地下开挖', { structureVerified: false });
    const validation = excavationSkill.validate({ entry: args.entry, direction: args.direction, steps: args.steps, mode: args.method === 'excavate' ? 'stairs' : 'tunnel' }, ctx.adapter);
    if (!validation.ok) return fail('BAD_ARGS', validation.error, { structureVerified: false });
    let frame: BlockHit | undefined;
    const result = await excavatePath(ctx, validation.args, () => { frame = currentPortalFrame(ctx); return !!frame; });
    throwIfAborted(ctx.signal);
    const current = ctx.adapter.state();
    if (state.worldId !== current.worldId || state.dim !== current.dim || state.sessionId !== current.sessionId) throw new AbortedError('structure search session changed');
    if (frame) frame = currentPortalFrame(ctx);
    if (!frame) return result;
    ctx.memory.addLandmark('discovery', '实际末地门室门框', state.dim, frame.pos, 4);
    return ok('地下搜索中已实际观察到末地门框；仅确认门框所在结构线索', { ...result.data, structureVerified: true, marker: frame });
  },
};

export const structureSkills = { find_stronghold: findStronghold, search_structure: searchStructure };
