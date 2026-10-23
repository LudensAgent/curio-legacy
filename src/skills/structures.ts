import type { EntityInfo, Vec3Like } from '../adapter/types.ts';
import { dist3, sleep } from '../util.ts';
import { codeFromError, fail, isAbort, obj, ok, type Skill } from './types.ts';

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
    if (adapter.state().dim !== 'overworld') return fail('WRONG_DIMENSION', '末影之眼寻路仅在主世界进行');
    if (!adapter.useItem) return fail('ERROR', '适配器没有物品使用能力');
    const traces: { origin: Vec3Like; samples: Vec3Like[]; descent: boolean }[] = [];
    try {
      for (let attempt = 0; attempt < args.throws; attempt++) {
        senses.refresh();
        const frame = senses.knownBlocks(['end_portal_frame'], 32).find((b) => adapter.blockAt(b.pos) === 'end_portal_frame');
        if (frame) {
          ctx.memory.addLandmark('discovery', '实际末地门室门框', adapter.state().dim, frame.pos, 4);
          return ok('已实际观察到末地门框，找到门室线索', { structureVerified: true, marker: frame, traces });
        }
        const state = adapter.state();
        if (!(state.inventory.find((i) => i.name === 'ender_eye')?.count)) return fail('MISSING_MATERIALS', '缺少末影之眼，保留已有眼迹', { traces });
        const oldEyes = new Set(senses.perceivedEntities(64).filter((e) => e.name === 'eye_of_ender').map((e) => e.id));
        const eye = adapter.eye();
        await adapter.look(eye?.yaw ?? 0, 0.25);
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
            await adapter.look(Math.atan2(-delta.x, -delta.z), Math.atan2(delta.y, Math.hypot(delta.x, delta.z)));
          } else if (!samples.length && sample % 3 === 2) {
            const current = adapter.eye();
            await adapter.look((current?.yaw ?? 0) + Math.PI / 3, 0.3);
          }
        }
        if (samples.length < 2 || dist3(samples[0], samples[samples.length - 1]) < 1) return fail('NOT_FOUND', '没有获得足够的可见眼迹，不能猜测要塞方向', { traces });
        const last = samples[samples.length - 1];
        const descent = last.y < samples[0].y - 0.75;
        traces.push({ origin: state.pos, samples, descent });
        if (descent) {
          ctx.memory.addLandmark('waypoint', '末影之眼下降搜索点（尚未发现要塞）', state.dim, last, 8);
          return ok('末影之眼向地下移动，已记录实际搜索点；尚未实际发现要塞', { structureVerified: false, searchPosition: last, traces });
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

export const searchStructure: Skill<{ kind: 'stronghold' }> = {
  name: 'search_structure', description: '对已选择的要塞搜索执行眼迹探索；只依据实际观察，不制造固定地牢坐标或调用 /locate。', argsDoc: '{"kind":"stronghold"}', timeoutMs: 240000, movement: true,
  validate(raw) { return obj(raw).kind === 'stronghold' ? { ok: true, args: { kind: 'stronghold' } } : { ok: false, error: '当前支持 kind=stronghold' }; },
  run(ctx) { return findStronghold.run(ctx, { throws: 2, step: 48 }); },
};

export const structureSkills = { find_stronghold: findStronghold, search_structure: searchStructure };
