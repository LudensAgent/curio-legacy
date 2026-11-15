import type { Vec3Like } from '../adapter/types.ts';
import { blockCollidesBody, bodyBoxAt, bodyCells, estimatedFallDamage, supportTop } from '../perception/geometry.ts';
import { AbortedError, dist3, sleep, throwIfAborted } from '../util.ts';
import { codeFromError, fail, isAbort, obj, ok, type Skill } from './types.ts';

/** 落地后允许的服务端位置修正；方块顶面是精确的 /16 值，不需要更宽的容差。 */
const ARRIVAL_FOOT_TOLERANCE = 0.05;

/** An explicit observed edge; the model chooses the landing, never this primitive. */
export const descend: Skill<{ target: Vec3Like; allowUnknownCorridor?: boolean }> = {
  name: 'descend',
  description: '向自己明确选择的相邻较低落点下行；重新核对当前可见落点、通道和存活余量，支持已看清至少两格深的水；落点/净空已确认但落体通道没全部看清时，可用 allowUnknownCorridor 明确承担这部分未知；不挖不搭不代选路线',
  argsDoc: '{"target":{"x":数值,"y":数值,"z":数值},"allowUnknownCorridor"?:boolean}；target 须来自 assess_landings 的当前落点；水中抵达不代表上岸',
  timeoutMs: 15000,
  movement: true,
  outcomeBoundary: true,
  validate(raw) {
    const value = obj(raw), target = obj(value.target);
    if (value.mode !== undefined || value.nearest !== undefined) {
      return { ok: false, error: 'descend_to 不接受 mode/nearest；请把 assess_landings 的 options[].target（或 options[].descend.target）原样放进 {"target":{"x":数值,"y":数值,"z":数值}}' };
    }
    if (![target.x, target.y, target.z].every((n) => typeof n === 'number' && Number.isFinite(n))
      || Math.abs(target.x) > 29_999_984 || Math.abs(target.z) > 29_999_984 || Math.abs(target.y) > 2048) {
      return { ok: false, error: 'target 需要当前已观测落点的有限坐标；请从 assess_landings 的 options[].target（或 options[].descend.target）复制，例如 {"target":{"x":1.5,"y":64,"z":0.5}}' };
    }
    if (value.allowUnknownCorridor !== undefined && typeof value.allowUnknownCorridor !== 'boolean') return { ok: false, error: 'allowUnknownCorridor 需要布尔值' };
    return { ok: true, args: { target: { x: Math.floor(target.x) + 0.5, y: target.y, z: Math.floor(target.z) + 0.5 }, ...(value.allowUnknownCorridor === true ? { allowUnknownCorridor: true } : {}) } };
  },
  async run(ctx, args) {
    const { adapter, senses, signal } = ctx;
    throwIfAborted(signal);
    const initial = adapter.state();
    const refused = (message: string, code: 'BAD_ARGS' | 'NOT_FOUND' | 'LOW_HP' | 'NOT_CONNECTED' = 'BAD_ARGS', details: Record<string, unknown> = {}) => fail(code, message, {
      target: args.target, ...details, effectEvidence: { verified: true, changed: false, reasons: ['没有执行下行动作'] },
    });
    if (!initial.connected || !initial.alive || !initial.observationReady) return refused('下行前没有有效的存活观测', 'NOT_CONNECTED');
    if (!initial.onGround || initial.riding || initial.inWater || initial.inLava) return refused('下行需要先在干燥支撑面站稳，不能从乘骑、游泳或下落中再次起跳');
    if (!senses.landingOptions) return refused('当前没有可见落点评估接口，不能凭坐标下落', 'NOT_FOUND');
    const check = () => {
      throwIfAborted(signal);
      const state = adapter.state();
      if (state.worldId !== initial.worldId || state.sessionId !== initial.sessionId || state.dim !== initial.dim) throw new AbortedError('descent session changed');
      return state;
    };
    senses.refresh();
    const candidates = senses.landingOptions(2);
    const option = candidates.find((candidate) => dist3(candidate.target, args.target) <= 0.05);
    if (!option) {
      const available = candidates.slice(0, 4).map((candidate) => ({
        target: candidate.target, drop: candidate.drop, approach: candidate.approach,
        clearance: candidate.clearance, corridor: candidate.corridor,
      }));
      const preview = available.map((candidate) => `${JSON.stringify(candidate.target)} drop${candidate.drop} ${candidate.approach}/${candidate.clearance}/${candidate.corridor}`).join('；');
      return refused(available.length
        ? `选择的落点当前不可见；2 格内可见落点：${preview}。请把某个 target 原样复制给 descend_to；若都不是 adjacent/clear，先 move_step 靠近或开挖/补台阶`
        : '2 格内没有可见落点；先 assess_landings 看清，或用 move_step 靠近；脚下超过 1 格落差可用 excavate_run/mine_cell 开台阶，或 place_support 补一级', 'NOT_FOUND', { available });
    }
    const receipt = option.receipt, age = Date.now() - receipt.at;
    if (receipt.worldId !== initial.worldId || receipt.sessionId !== initial.sessionId || receipt.dimension !== initial.dim
      || receipt.observationId < initial.observationId || age < 0 || age > 1000 || dist3(receipt.from, initial.pos) > 0.35) return refused('落点观测已过期、站位改变或不在当前会话，未下行', 'NOT_FOUND');
    const unknownCorridorAccepted = option.corridor === 'unknown' && args.allowUnknownCorridor === true;
    if (option.clearance !== 'clear' || option.approach !== 'adjacent'
      || (option.corridor !== 'clear' && !unknownCorridorAccepted)) {
      const geometry = { clearance: option.clearance, corridor: option.corridor, approach: option.approach, unknowns: option.unknowns };
      const state = (v: 'clear' | 'blocked' | 'unknown') => v === 'clear' ? '已确认畅通' : v === 'blocked' ? '观察到阻挡' : '未看清';
      const retry = option.clearance === 'clear' && option.corridor === 'unknown' && option.approach === 'adjacent' && !unknownCorridorAccepted
        ? '；若接受"落点已确认、落体通道未看清"，可显式加 allowUnknownCorridor:true' : '';
      return refused(`未下行：落点净空${state(option.clearance)}，落体通道${state(option.corridor)}，落点${option.approach === 'adjacent' ? '在相邻位置' : '不在相邻位置'}${retry}`, 'BAD_ARGS', { geometry });
    }
    const target = option.target;
    // 与 step/excavation 同一套碰撞顶面：地面落点必须是已观察支撑方块的真实站立面，
    // 不能把半格/窄条顶面按整数脚高硬套（水落点另由水深检查）。
    if (option.surface === 'ground') {
      const supportState = adapter.blockStateAt?.(option.support.pos);
      const name = supportState?.name ?? option.support.name;
      const top = supportTop(name, supportState?.properties ?? {});
      if (top === null) return refused(`落点支撑 ${name} 没有可站立顶面，不能按地面落点下行`, 'BAD_ARGS', { support: option.support });
      const surface = option.support.pos.y + top;
      if (Math.abs(surface - option.surfaceY) > 0.01 || Math.abs(target.y - surface) > 0.01) {
        return refused(`落点支撑面按碰撞形状在 y=${surface.toFixed(2)}，与所选脚高 y=${target.y.toFixed(2)} 不符`, 'BAD_ARGS', { support: option.support, surface });
      }
    }
    if (Math.abs(Math.floor(initial.pos.x) - Math.floor(target.x)) + Math.abs(Math.floor(initial.pos.z) - Math.floor(target.z)) !== 1
      || Math.abs(target.y - Math.round(target.y)) > 0.01) return refused('当前寻路器只支持相邻四向、整数脚位的单步下落；此落点需要其他方式接近');
    const surfaceY = option.surface === 'water' ? option.support.pos.y + 1 : target.y, drop = initial.pos.y - surfaceY;
    if (!Number.isFinite(drop) || drop <= 0.25 || Math.abs(option.drop - drop) > 0.15 || drop > 24) return refused('没有确认此落点的有效下降高度，或超出单次下行范围');
    if (option.surface === 'water' && option.waterDepth !== 2) return refused('尚未亲眼确认目标水面及下方至少两格水，不能据此保证入水');
    if (option.surface === 'water' && option.support.name !== 'water') return refused('该水柱存在气泡等额外作用，当前没有确认其下行风险');
    // 原版摔伤从 >3 格才开始；护甲/附魔只会减少伤害，不会增加。用同一套 estimatedFallDamage
    // 做上限，别把 1–3 格的安全落差估成 ceil(drop)+2 点而挡住低血时的正常下行。
    const estimatedDamageUpperBound = option.surface === 'water' ? 0 : estimatedFallDamage(drop);
    if (!Number.isFinite(initial.hp) || initial.hp - estimatedDamageUpperBound < 4) return refused(`当前生命 ${initial.hp} 不足以保守承受这次约 ${drop.toFixed(1)} 格落差并保留余量`, 'LOW_HP');
    const latest = check();
    if (dist3(latest.pos, receipt.from) > 0.35) return refused('观察后站位已经改变，需重新评估落点');
    if (!latest.connected || !latest.alive || !latest.observationReady || !latest.onGround || latest.inWater || latest.inLava
      || latest.hp - estimatedDamageUpperBound < 4) return refused('观察期间站稳状态或生命余量已改变，需重新评估');
    const end = Math.min(ctx.deadline, Date.now() + 12_000);
    if (end <= Date.now()) return refused('本次下行时间预算已用尽');
    try {
      await adapter.moveTo({ kind: 'xyz', ...target }, { signal, timeoutMs: end - Date.now(),
        allowSwimming: option.surface === 'water', maxDropDown: Math.ceil(drop) + 1 });
      // Pathfinder can resolve within a block of its node; wait briefly for actual contact.
      const settle = Math.min(end, Date.now() + 800);
      let actual = check();
      // 到达必须是所选方块列，不是“离落点中心 0.6 格内”（那会包含相邻列）；
      // 地面落点还要求实测脚高与所选脚高一致，不能把低 0.2–0.3 格的另一支撑当成功。
      const inTargetColumn = () => Math.floor(actual.pos.x) === Math.floor(target.x) && Math.floor(actual.pos.z) === Math.floor(target.z);
      // 落地后重新采样支撑顶面与身体空间；支撑被换掉、脚格/头格被填、或读不到状态都不能算 ARRIVED。
      const geometryNow = () => {
        const p = actual.pos, cx = Math.floor(p.x), cz = Math.floor(p.z), body = bodyBoxAt(p.y, cx, cz);
        const states = bodyCells(p.y, cx, cz).map((cell) => {
          const name = adapter.blockAt(cell);
          return name === null ? null : { cell, name, properties: adapter.blockStateAt?.(cell)?.properties ?? {} };
        });
        const bodySpace = states.some((s) => s === null) ? 'unknown' as const
          : states.some((s) => s !== null && blockCollidesBody(s.name, s.properties, s.cell, body)) ? 'blocked' as const : 'clear' as const;
        const supportState = option.surface === 'water' ? null
          : adapter.blockStateAt?.(option.support.pos) ?? (() => {
            const name = adapter.blockAt(option.support.pos);
            return name === null ? null : { name, properties: {} };
          })();
        const top = supportState ? supportTop(supportState.name, supportState.properties ?? {}) : null;
        const supportAfter = option.surface === 'water' ? null
          : top !== null && Math.abs(option.support.pos.y + top - target.y) <= 0.01;
        return { bodySpace, supportAfter };
      };
      const arrived = () => {
        if (!actual.connected || !actual.alive || !actual.observationReady || actual.inLava || actual.hp <= 0
          || !inTargetColumn() || actual.pos.y >= initial.pos.y - 0.25) return false;
        const geometry = geometryNow();
        if (geometry.bodySpace !== 'clear') return false;
        return option.surface === 'water'
          ? actual.inWater && actual.pos.y >= target.y - 1 && actual.pos.y <= target.y + 1
          : actual.onGround && !actual.inWater && !actual.inLava
            && Math.abs(actual.pos.y - target.y) <= ARRIVAL_FOOT_TOLERANCE && geometry.supportAfter === true;
      };
      while (!arrived() && actual.alive && actual.connected && Date.now() < settle) {
        await sleep(Math.min(50, settle - Date.now()), signal); actual = check();
      }
      senses.refresh();
      throwIfAborted(signal);
      const verified = actual.connected && actual.alive && actual.observationReady;
      const settled = arrived();
      const landingGeometry = geometryNow();
      const data = { target, support: option.support, surface: option.surface, drop, estimatedDamageUpperBound,
        corridor: option.corridor, unknownCorridorAccepted,
        position: { ...actual.pos }, inWater: actual.inWater, hp: actual.hp, measuredAt: Date.now(),
        arrival: { mode: 'exact_cell', required: { target: { ...target }, surface: option.surface },
          measured: { position: { ...actual.pos }, onGround: actual.onGround, inWater: actual.inWater, bodySpace: landingGeometry.bodySpace, supportAfter: landingGeometry.supportAfter }, satisfied: settled },
        effectEvidence: { verified, changed: verified && actual.pos.y < initial.pos.y - 0.25,
          reasons: [`实际脚位 ${initial.pos.y} → ${actual.pos.y}`, ...(actual.inWater ? ['当前实测已进入水中'] : [])] } };
      if (!settled) return fail('EFFECT_NOT_CONFIRMED', '下行寻路已结束，但没有确认在所选落点接触地面或进入水中', data);
      const summary = option.surface === 'water' ? '已进入选择的水面落点，尚未确认上岸' : '已落在选择的地面落点';
      return ok(unknownCorridorAccepted ? `${summary}（落体通道此前未看清，已按显式委托执行）` : summary, data);
    } catch (error) {
      if (isAbort(error)) throw error;
      const actual = check();
      const verified = actual.connected && actual.alive && actual.observationReady;
      return fail(codeFromError(error), `下行没有完成：${(error as Error).message}`, { target, corridor: option.corridor, unknownCorridorAccepted, position: { ...actual.pos },
        effectEvidence: { verified, changed: verified && actual.pos.y < initial.pos.y - 0.25, reasons: [`实际脚位 ${initial.pos.y} → ${actual.pos.y}`] } });
    }
  },
};
