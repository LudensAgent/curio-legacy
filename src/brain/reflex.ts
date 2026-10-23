import type { GameAdapter } from '../adapter/types.ts';
import type { Arbiter, Step } from '../arbiter/arbiter.ts';
import type { EventBus, Severity } from '../events.ts';
import type { Senses } from '../skills/types.ts';
import { hasPlaceable } from '../skills/survival.ts';

/**
 * 反射层：不依赖 LLM，按固定频率检查危险并直接抢占动作。
 * 同时负责卡死检测（移动型任务长时间没有位移）。
 * 威胁来自 Vision：看见的，或近距离听见的。
 */
export class Reflex {
  private timer: NodeJS.Timeout | null = null;
  private cooldown = new Map<string, number>();
  private trail: { t: number; x: number; z: number; y: number; taskId: string; progress: number }[] = [];
  stuckCount = 0;
  triggers = 0;
  enabled = true;

  constructor(private adapter: GameAdapter, private arbiter: Arbiter, private bus: EventBus, private senses: Senses) {}

  start(intervalMs = 250) {
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (e: any) {
        this.bus.publish('reflex_error', 'P1', String(e?.message ?? e));
      }
    }, intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private ready(key: string, ms: number) {
    const t = this.cooldown.get(key) ?? 0;
    if (Date.now() < t) return false;
    this.cooldown.set(key, Date.now() + ms);
    return true;
  }

  private fire(step: Step, sev: Severity, why: string) {
    this.triggers++;
    this.bus.publish('reflex', sev, `${why} → ${step.skill}`);
    this.arbiter.start(step, 'reflex');
  }

  tick() {
    if (!this.enabled) return;
    const s = this.adapter.state();
    if (!s.connected || !s.alive) return;
    const cur = this.arbiter.info();
    // 只对看见/听见的威胁做反应（墙后的怪物不会触发反射）
    const hostiles = this.senses.perceivedEntities(12).filter((e) => e.kind === 'hostile');
    const nearest = hostiles[0];
    const creeper = hostiles.find((e) => e.name === 'creeper' && e.dist < 5);

    // 躲在避难所里：怪物进不来，不要出去打架/逃跑，只防溺水
    if (cur?.skill === 'shelter') {
      if (s.inWater && s.oxygen <= 10 && this.ready('drown', 4000)) this.fire({ skill: 'surface' }, 'P0', `氧气 ${s.oxygen}/20，有溺水风险`);
      return;
    }

    // 反射任务进行中：只处理升级（战斗中生命过低 → 撤离；任何反射中快溺水 → 换气）
    if (cur?.source === 'reflex') {
      if (cur.skill !== 'surface' && s.inWater && s.oxygen <= 6 && this.ready('drown', 3000)) {
        this.fire({ skill: 'surface' }, 'P0', `氧气 ${s.oxygen}/20，有溺水风险`);
        return;
      }
      if (cur.skill === 'defend' && (s.hp <= 6 || creeper) && this.ready('escalate', 3000)) {
        this.fire({ skill: 'flee', args: { distance: 20 } }, 'P0', `战斗中生命 ${s.hp}${creeper ? '，苦力怕靠近' : ''}`);
      }
      return;
    }

    if (s.inLava && this.ready('lava', 1500)) return this.fire({ skill: 'flee', args: { distance: 8 } }, 'P0', '掉进岩浆');
    // 只在水里才检查氧气：Mineflayer 在陆地上偶尔会报出不准的氧气值
    if (s.inWater && s.oxygen <= 10 && this.ready('drown', 4000)) return this.fire({ skill: 'surface' }, 'P0', `氧气 ${s.oxygen}/20，有溺水风险`);
    if (creeper && this.ready('creeper', 3000)) return this.fire({ skill: 'flee', args: { distance: 16 } }, 'P0', `苦力怕距离 ${creeper.dist.toFixed(1)}`);
    // 夜里低血量且身上有方块：就地挖坑封顶，比被追着跑更安全
    if (!s.isDay && s.hp <= 8 && (!nearest || nearest.dist > 4) && !s.inWater && hasPlaceable(s.inventory) && this.ready('shelter', 90000)) {
      return this.fire({ skill: 'shelter', args: { until: 'day' } }, 'P0', `夜里生命只有 ${Math.round(s.hp)}`);
    }
    if (s.hp <= 6 && nearest && nearest.dist < 10 && this.ready('lowhp', 4000)) {
      return this.fire({ skill: 'flee', args: { distance: 24 } }, 'P0', `生命 ${s.hp}，${nearest.name} 在 ${nearest.dist.toFixed(1)} 格`);
    }
    if (nearest && nearest.dist < 4 && nearest.name !== 'creeper' && this.ready('defend', 4000)) {
      if (s.hp > 8) return this.fire({ skill: 'defend', args: { entityId: nearest.id } }, 'P1', `${nearest.name} 贴近（${nearest.dist.toFixed(1)} 格）`);
      return this.fire({ skill: 'flee', args: { distance: 18 } }, 'P1', `${nearest.name} 贴近且生命 ${s.hp}`);
    }
    const safe = !nearest || nearest.dist > 8;
    if (safe && (s.food <= 12 || (s.hp < 14 && s.food < 18)) && this.adapter.hasFood() && this.ready('eat', 15000)) {
      return this.fire({ skill: 'eat' }, 'P1', `饥饿 ${s.food} / 生命 ${s.hp}`);
    }

    this.checkStuck(s.pos, cur);
  }

  /** 移动型任务 20 秒内位移 < 1.5 格且进度没有变化 → 判定卡死，取消任务（计为 STUCK 失败）并执行脱困。 */
  private checkStuck(pos: { x: number; y: number; z: number }, cur: ReturnType<Arbiter['info']>) {
    const now = Date.now();
    if (!cur || !cur.movement) {
      this.trail = [];
      return;
    }
    const last = this.trail[this.trail.length - 1];
    if (!last || now - last.t >= 1000) this.trail.push({ t: now, x: pos.x, y: pos.y, z: pos.z, taskId: cur.id, progress: cur.progress });
    this.trail = this.trail.filter((p) => p.taskId === cur.id && now - p.t <= 20000);
    const first = this.trail[0];
    if (!first || now - first.t < 19000 || now - cur.startedAt < 20000) return;
    const moved = Math.max(...this.trail.map((p) => Math.hypot(p.x - first.x, p.z - first.z) + Math.abs(p.y - first.y)));
    // 原地连续挖同一棵树/往下挖时位置不怎么变，但进度在涨，不算卡死
    const progressed = Math.max(...this.trail.map((p) => p.progress)) - Math.min(...this.trail.map((p) => p.progress)) > 0.001;
    if (moved < 1.5 && !progressed) {
      this.stuckCount++;
      this.trail = [];
      this.bus.publish('stuck', 'P1', `${cur.skill} 20 秒内几乎没有移动（${moved.toFixed(1)} 格），判定卡死`);
      this.arbiter.cancel('卡死', 'STUCK');
      this.arbiter.start({ skill: 'unstuck' }, 'reflex');
    }
  }
}
