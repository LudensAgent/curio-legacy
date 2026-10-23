import type { GameAdapter } from '../adapter/types.ts';
import type { Arbiter, Step } from '../arbiter/arbiter.ts';
import type { EventBus, Severity } from '../events.ts';
import type { Senses } from '../skills/types.ts';
import { hasPlaceable } from '../skills/survival.ts';
import { torchCount } from '../skills/light.ts';
import { effectiveLight, lightAround } from '../util.ts';
import { surroundings } from '../perception/surroundings.ts';

/** 这些动作进行中可以顺手插支火把（插完接着做） */
const TORCH_OK_DURING = new Set(['explore', 'goto', 'gather', 'wander', 'excavate_path', 'search_structure', 'look_around']);
/** 熟食、面包等正经食物（不含生肉生鱼） */
const GOOD_FOOD = /^(cooked_|baked_potato|bread|golden_carrot|golden_apple|pumpkin_pie|cookie|apple|carrot|melon_slice|sweet_berries|glow_berries|beetroot|dried_kelp|mushroom_stew|rabbit_stew|beetroot_soup|suspicious_stew|honey_bottle|cake)/;

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
    if (!this.enabled || this.arbiter.paused) return;
    const s = this.adapter.state();
    if (!s.connected || !s.alive || !s.observationReady) return;
    const cur = this.arbiter.info();
    // 只对看见/听见的威胁做反应（墙后的怪物不会触发反射）
    const hostiles = this.senses.perceivedEntities(12).filter((e) => e.kind === 'hostile' && !(cur?.skill === 'dragon_fight' && e.name === 'ender_dragon'));
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
    // 吃东西的反射分轻重：真饿（≤6）或掉血时饥饿不满，什么都吃、马上吃；
    // 只是有点饿（7–12）时，只在有熟食/面包这类“正经食物”时顺手吃，并且不打断打猎、战斗——
    // 手上只有生肉就留给决策去决定（先烤熟更划算），而不是一捡到生肉就吃掉
    const urgent = s.food <= 6 || (s.hp < 10 && s.food < 18);
    const peckish = s.food <= 12 || (s.hp < 14 && s.food < 18);
    const goodFood = s.inventory.some((i) => GOOD_FOOD.test(i.name));
    const busy = !!cur && ['hunt', 'defend', 'ranged_defend', 'flee', 'dragon_fight', 'craft', 'smelt', 'build', 'climb_up', 'dig', 'store_items', 'take_items', 'ride', 'use_item', 'interact', 'sleep'].includes(cur.skill);
    if (cur?.skill !== 'dragon_fight' && safe && this.adapter.hasFood() && (urgent || (peckish && goodFood && !busy)) && this.ready('eat', 15000)) {
      return this.fire({ skill: 'eat' }, 'P1', `饥饿 ${s.food} / 生命 ${s.hp}${urgent ? '（很饿了，有什么吃什么）' : ''}`);
    }

    this.autoTorch(s, cur, nearest?.dist ?? Infinity);
    this.checkStuck(s.pos, cur);
  }

  private lastTorch: { x: number; y: number; z: number } | null = null;
  private torchNear(x: number, y: number, z: number, r: number) {
    for (let dx = -r; dx <= r; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -r; dz <= r; dz++) {
      const n = this.adapter.blockAt({ x: x + dx, y: y + dy, z: z + dz });
      if (n === 'torch' || n === 'wall_torch') return true;
    }
    return false;
  }
  torchesPlaced = 0;

  /** 像真人下矿一样：在地下走到暗处就顺手插一支火把（不打断计划，计划会原样继续） */
  private autoTorch(s: ReturnType<GameAdapter['state']>, cur: ReturnType<Arbiter['info']>, nearestHostile: number) {
    if (s.inWater || nearestHostile < 5 || torchCount(s.inventory) === 0) return;
    // 只在“走路/挖矿”这类可以顺手停一下的动作里插火把；打猎、合成、建造、爬坑这些做到一半被打断会坏事
    if (cur && !TORCH_OK_DURING.has(cur.skill)) return;
    const x = Math.floor(s.pos.x), y = Math.floor(s.pos.y), z = Math.floor(s.pos.z);
    const l = lightAround(this.adapter, x, y, z);
    if (!l) return;
    const here = effectiveLight(l, s.timeOfDay);
    if (l.sky > 4 || here > 4) return; // 只在地下的暗处
    if (this.lastTorch && Math.hypot(x - this.lastTorch.x, y - this.lastTorch.y, z - this.lastTorch.z) < 5) return;
    if (!this.ready('torch', 6000)) return;
    // 身边已经有火把了（光照数据还没刷新，或者火把被挡住）：玩家不会紧挨着再插一支
    if (this.torchNear(x, y, z, 4)) return;
    this.lastTorch = { x, y, z };
    this.torchesPlaced++;
    this.triggers++;
    this.bus.publish('reflex', 'P3', `地下太暗（亮度 ${here}/15）→ 顺手插火把`);
    this.arbiter.start({ skill: 'place_torch', args: { count: 1 } }, 'reflex', { gentle: true });
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
      const around = surroundings(this.adapter, pos);
      this.bus.publish('stuck', 'P1', `${cur.skill} 20 秒内几乎没有移动（${moved.toFixed(1)} 格），判定卡死｜${around.text}`);
      this.arbiter.cancel(`卡死：20 秒没挪动，在 ${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}｜${around.text}`, 'STUCK');
      this.arbiter.start({ skill: 'unstuck' }, 'reflex');
    }
  }
}
