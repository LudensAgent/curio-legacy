import type { Vec3Like } from '../adapter/types.ts';
import { AbortedError, dist3, sleep, throwIfAborted } from '../util.ts';
import { codeFromError, fail, isAbort, obj, ok, type Skill } from './types.ts';

/** An explicit observed edge; the model chooses the landing, never this primitive. */
export const descend: Skill<{ target: Vec3Like }> = {
  name: 'descend',
  description: '向自己明确选择的相邻较低落点下行；重新核对当前可见落点、通道和存活余量，支持已看清至少两格深的水，不挖不搭不代选路线',
  argsDoc: '{"target":{"x":数值,"y":数值,"z":数值}}；须来自 assess_landings 的当前落点；水中抵达不代表上岸',
  timeoutMs: 15000,
  movement: true,
  outcomeBoundary: true,
  validate(raw) {
    const target = obj(obj(raw).target);
    if (![target.x, target.y, target.z].every((n) => typeof n === 'number' && Number.isFinite(n))
      || Math.abs(target.x) > 29_999_984 || Math.abs(target.z) > 29_999_984 || Math.abs(target.y) > 2048) return { ok: false, error: 'target 需要当前已观测落点的有限坐标' };
    return { ok: true, args: { target: { x: Math.floor(target.x) + 0.5, y: target.y, z: Math.floor(target.z) + 0.5 } } };
  },
  async run(ctx, args) {
    const { adapter, senses, signal } = ctx;
    throwIfAborted(signal);
    const initial = adapter.state();
    const refused = (message: string, code: 'BAD_ARGS' | 'NOT_FOUND' | 'LOW_HP' | 'NOT_CONNECTED' = 'BAD_ARGS') => fail(code, message, {
      target: args.target, effectEvidence: { verified: true, changed: false, reasons: ['没有执行下行动作'] },
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
    const option = senses.landingOptions(2).find((candidate) => dist3(candidate.target, args.target) <= 0.05);
    if (!option) return refused('选择的落点当前不可见；先查看 assess_landings 并明确选择落点', 'NOT_FOUND');
    const receipt = option.receipt, age = Date.now() - receipt.at;
    if (receipt.worldId !== initial.worldId || receipt.sessionId !== initial.sessionId || receipt.dimension !== initial.dim
      || receipt.observationId < initial.observationId || age < 0 || age > 1000 || dist3(receipt.from, initial.pos) > 0.35) return refused('落点观测已过期、站位改变或不在当前会话，未下行', 'NOT_FOUND');
    if (option.clearance !== 'clear' || option.corridor !== 'clear' || option.approach !== 'adjacent') return refused('入口、落体通道或落点净空尚未确认可通行，未下行');
    const target = option.target;
    if (Math.abs(Math.floor(initial.pos.x) - Math.floor(target.x)) + Math.abs(Math.floor(initial.pos.z) - Math.floor(target.z)) !== 1
      || Math.abs(target.y - Math.round(target.y)) > 0.01) return refused('当前寻路器只支持相邻四向、整数脚位的单步下落；此落点需要其他方式接近');
    const surfaceY = option.surface === 'water' ? option.support.pos.y + 1 : target.y, drop = initial.pos.y - surfaceY;
    if (!Number.isFinite(drop) || drop <= 0.25 || Math.abs(option.drop - drop) > 0.15 || drop > 24) return refused('没有确认此落点的有效下降高度，或超出单次下行范围');
    if (option.surface === 'water' && option.waterDepth !== 2) return refused('尚未亲眼确认目标水面及下方至少两格水，不能据此保证入水');
    if (option.surface === 'water' && option.support.name !== 'water') return refused('该水柱存在气泡等额外作用，当前没有确认其下行风险');
    // Deliberately overestimate ground impact; do not assume armor, enchantments or a perfect walk-off.
    const estimatedDamageUpperBound = option.surface === 'water' ? 0 : Math.ceil(drop) + 2;
    if (!Number.isFinite(initial.hp) || initial.hp - estimatedDamageUpperBound < 4) return refused(`当前生命 ${initial.hp} 不足以保守承受这次约 ${drop.toFixed(1)} 格落差并保留余量`, 'LOW_HP');
    const latest = check();
    if (dist3(latest.pos, receipt.from) > 0.35) return refused('观察后站位已经改变，需重新评估落点');
    if (!latest.connected || !latest.alive || !latest.observationReady || !latest.onGround || latest.inWater || latest.inLava
      || latest.hp - estimatedDamageUpperBound < 4) return refused('观察期间站稳状态或生命余量已改变，需重新评估');
    const end = Math.min(ctx.deadline, Date.now() + 12_000);
    if (end <= Date.now()) return refused('本次下行时间预算已用尽');
    try {
      await adapter.moveTo({ kind: 'xyz', ...target }, { signal, timeoutMs: end - Date.now(), constructionSafe: true,
        allowTerrainChanges: false, allowSwimming: option.surface === 'water', maxDropDown: Math.ceil(drop) + 1 });
      // Pathfinder can resolve within a block of its node; wait briefly for actual contact.
      const settle = Math.min(end, Date.now() + 800);
      let actual = check();
      const arrived = () => actual.connected && actual.alive && actual.observationReady && !actual.inLava && actual.hp > 0
        && Math.hypot(actual.pos.x - target.x, actual.pos.z - target.z) <= 0.6 && actual.pos.y < initial.pos.y - 0.25
        && (option.surface === 'water' ? actual.inWater && actual.pos.y >= target.y - 1 && actual.pos.y <= target.y + 1
          : actual.onGround && !actual.inWater && !actual.inLava && Math.abs(actual.pos.y - target.y) <= 0.3);
      while (!arrived() && actual.alive && actual.connected && Date.now() < settle) {
        await sleep(Math.min(50, settle - Date.now()), signal); actual = check();
      }
      senses.refresh();
      throwIfAborted(signal);
      const verified = actual.connected && actual.alive && actual.observationReady;
      const data = { target, support: option.support, surface: option.surface, drop, estimatedDamageUpperBound,
        position: { ...actual.pos }, inWater: actual.inWater, hp: actual.hp,
        effectEvidence: { verified, changed: verified && actual.pos.y < initial.pos.y - 0.25,
          reasons: [`实际脚位 ${initial.pos.y} → ${actual.pos.y}`, ...(actual.inWater ? ['当前实测已进入水中'] : [])] } };
      if (!arrived()) return fail('EFFECT_NOT_CONFIRMED', '下行寻路已结束，但没有确认在所选落点接触地面或进入水中', data);
      return ok(option.surface === 'water' ? '已进入选择的水面落点，尚未确认上岸' : '已落在选择的地面落点', data);
    } catch (error) {
      if (isAbort(error)) throw error;
      const actual = check();
      const verified = actual.connected && actual.alive && actual.observationReady;
      return fail(codeFromError(error), `下行没有完成：${(error as Error).message}`, { target, position: { ...actual.pos },
        effectEvidence: { verified, changed: verified && actual.pos.y < initial.pos.y - 0.25, reasons: [`实际脚位 ${initial.pos.y} → ${actual.pos.y}`] } });
    }
  },
};
