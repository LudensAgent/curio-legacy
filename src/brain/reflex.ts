import type { GameAdapter } from '../adapter/types.ts';
import type { Arbiter, Step, TaskInfo } from '../arbiter/arbiter.ts';
import type { EventBus, Severity } from '../events.ts';
import type { Senses } from '../skills/types.ts';
import { hasPlaceable } from '../skills/survival.ts';
import { measureLight, torchCount } from '../skills/light.ts';
import { isSoftBlock, surroundings } from '../perception/surroundings.ts';

/** 这些动作进行中可以顺手插支火把（插完接着做） */
const TORCH_OK_DURING = new Set(['explore', 'goto', 'gather', 'wander', 'excavate_path', 'search_structure']);
/** 熟食、面包等正经食物（不含生肉生鱼） */
const GOOD_FOOD = /^(cooked_|baked_potato|bread|golden_carrot|golden_apple|pumpkin_pie|cookie|apple|carrot|melon_slice|sweet_berries|glow_berries|beetroot|dried_kelp|mushroom_stew|rabbit_stew|beetroot_soup|suspicious_stew|honey_bottle|cake)/;

/** 后天学会的做法（行为技能）：先于本能判断，也可以把某个本能换掉 */
export interface LearnedBehaviors {
  tick(cur: TaskInfo | null): boolean;
  suppresses(instinct: string, cur: TaskInfo | null): boolean;
}

/**
 * 反射层：不依赖 LLM，按固定频率检查危险并直接抢占动作。
 * 这里的每条规则都是一个有名字的“本能”（见 mind/behaviors.ts 的 INSTINCTS）：
 * 自己写的行为技能先判断，条件成立就由技能接手；技能可以用 overrides 换掉除 lava/drowning 以外的本能。
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

  /** 最近几次 surface 失败的位置：同一处连着失败就换一种脱困打法，而不是重复同一套 */
  private surfaceFails: { t: number; x: number; y: number; z: number }[] = [];

  /** routineCare=false leaves ordinary care and recovery choices to the autonomous planner. */
  constructor(private adapter: GameAdapter, private arbiter: Arbiter, private bus: EventBus, private senses: Senses,
    private options: { routineCare?: boolean; habits?: () => { torch_every?: number; eat_below?: number }; behaviors?: LearnedBehaviors;
      /** builtin：躲苦力怕、逃跑、还手、饿了就吃写在代码里（旧行为）；skills：这些都交给技能书里的反射技能，代码只留岩浆和溺水两条底线 */
      instincts?: 'builtin' | 'skills' } = {}) {
    bus.on('event', (ev: { type: string; data?: Record<string, unknown> }) => {
      if (ev.type === 'hurt') { this.lastHurtAt = Date.now(); return; }
      if (ev.type !== 'task_end' || ev.data?.skill !== 'surface') return;
      if (ev.data.status === 'succeeded') { this.surfaceFails = []; return; }
      if (ev.data.status !== 'failed') return;
      const p = this.adapter.state().pos;
      this.surfaceFails = [...this.surfaceFails.filter((f) => Date.now() - f.t < 90_000), { t: Date.now(), x: p.x, y: p.y, z: p.z }].slice(-6);
    });
  }

  /** 防溺水：同一处（4 格内、90 秒内）已经失败过就换打法——第 1 次失败后找气穴/往上挖，第 2 次起让寻路带着往岸上走 */
  drowningStep(): Step {
    const p = this.adapter.state().pos;
    const here = this.surfaceFails.filter((f) => Date.now() - f.t < 90_000 && Math.hypot(f.x - p.x, f.y - p.y, f.z - p.z) <= 4).length;
    if (!here) return { skill: 'surface' };
    return { skill: 'surface', args: { escape: here === 1 ? 'dig' : here % 2 === 0 ? 'shore' : 'dig' } };
  }

  private fireDrown(s: { oxygen: number }) {
    const step = this.drowningStep();
    this.fire(step, 'P0', `氧气 ${s.oxygen}/20，有溺水风险${step.args ? `（这里上浮失败过，换打法：${(step.args as any).escape === 'dig' ? '找气穴/往上挖' : '让寻路往岸上走'}）` : ''}`);
  }

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

  private lastHurtAt = 0;
  private flees: number[] = [];
  private fleeGiveUpUntil = 0;

  /**
   * 身体此刻有多“安全”：四面（脚和头的高度）都是实心方块就是躲在坑里/洞里；头顶也封上就是完全藏好了。
   * 躲好了还往外跑，就是把自己从掩体里拽出去送死。
   */
  private cover(pos: { x: number; y: number; z: number }): 'sealed' | 'pit' | 'open' {
    const x = Math.floor(pos.x), y = Math.floor(pos.y + 0.05), z = Math.floor(pos.z);
    const solid = (dx: number, dy: number, dz: number) => {
      const n = this.adapter.blockAt({ x: x + dx, y: y + dy, z: z + dz });
      return !!n && !/^(air|cave_air|void_air|water|lava)$/.test(n) && !isSoftBlock(n);
    };
    const walls = [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dz]) => solid(dx, 0, dz) && solid(dx, 1, dz));
    if (!walls) return 'open';
    return solid(0, 2, 0) ? 'sealed' : 'pit';
  }

  /** 逃跑：同一波危险里连跑三次都甩不掉，就别再一直跑了，交给脑子想办法（垫高、堵路、打） */
  private flee(distance: number, why: string, sev: Severity = 'P0') {
    const now = Date.now();
    this.flees = [...this.flees.filter((t) => now - t < 30_000), now];
    if (this.flees.length > 3) {
      this.flees = [];
      this.fleeGiveUpUntil = now + 20_000;
      this.bus.publish('reflex_gaveup', 'P1', `连跑了几次都甩不掉（${why}），身体不再自己乱跑：想个办法——垫高、挖坑封顶、堵住路，或者打`, { why });
      return;
    }
    this.fire({ skill: 'flee', args: { distance } }, sev, why);
  }

  private fire(step: Step, sev: Severity, why: string, gentle = false) {
    this.triggers++;
    this.bus.publish('reflex', sev, `${why} → ${step.skill}`);
    this.arbiter.start(step, 'reflex', gentle ? { gentle: true } : {});
  }

  tick() {
    if (!this.enabled || this.arbiter.paused) return;
    const s = this.adapter.state();
    if (!s.connected || !s.alive || !s.observationReady) { this.darkSince = null; return; }
    const cur = this.arbiter.info();
    // 只对看见/听见的威胁做反应（墙后的怪物不会触发反射）
    const hostiles = this.senses.perceivedEntities(12).filter((e) => e.kind === 'hostile' && !(cur?.skill === 'dragon_fight' && e.name === 'ender_dragon'));
    const nearest = hostiles[0];
    // 苦力怕：打还是跑由脑子决定；身体只在来不及想的时候躲——它已经在嘶嘶作响，或者贴到眼前而自己并没有在跟它打
    const fighting = !!cur && cur.source !== 'reflex' && cur.source !== 'filler' && ['defend', 'hit_entity', 'ranged_defend'].includes(cur.skill);
    const creeper = hostiles.find((e) => e.name === 'creeper' && (e.fusing ? e.dist < 4 : !fighting && e.dist < 2.5));
    if (s.inWater || s.inLava || !s.onGround || (nearest && nearest.dist < 5) || (cur && !TORCH_OK_DURING.has(cur.skill))) this.darkSince = null;

    // 先处理真正的险情，吃饭/照明等反射也不能挡住它；已经在脱险就继续，别重新起跑。
    if (s.inLava) {
      if (cur?.skill !== 'flee' && this.ready('lava', 1500)) this.fire({ skill: 'flee', args: { distance: 8 } }, 'P0', '掉进岩浆');
      return;
    }
    // 只在水里才检查氧气：Mineflayer 在陆地上偶尔会报出不准的氧气值
    // 氧气 20 → 0 只要 15 秒左右：降到 10 才浮，深水里常常来不及（日志里浮了 20 秒还是淹死了）
    if (s.inWater && s.oxygen <= 14) {
      if (cur?.skill !== 'surface' && this.ready('drown', 4000)) this.fireDrown(s);
      return;
    }
    // 躲在避难所里：怪物进不来，不要出去打架/逃跑。
    if (cur?.skill === 'shelter') return;
    // 后天学会的做法先判断：条件成立就由技能接手（它可能正是用来代替下面某个本能的）
    const learned = this.options.behaviors;
    if (learned?.tick(cur)) return;
    const instinct = (name: string) => !learned?.suppresses(name, cur);
    const legacy = this.options.instincts !== 'skills';
    if (cur?.skill === 'surface' || cur?.skill === 'flee') return;
    if (cur?.skill === 'use_skill' && cur.source === 'reflex') { this.checkStuck(s.pos, cur); return; } // 身体正照着反射技能在做
    // 掩体：完全封好就不出去；在坑里或正在挖坑/垫高/封顶时，只有真的被打到、怪就在身边才动
    const cover = this.cover(s.pos);
    const fortifying = !!cur && cur.source !== 'reflex' && cur.source !== 'filler' && ['dig_at', 'place_at', 'climb_up', 'shelter', 'wait', 'use_skill', 'dig', 'descend', 'step'].includes(cur.skill);
    const hurtNow = Date.now() - this.lastHurtAt < 2500;
    const mustReact = (dist: number) => cover !== 'sealed' && (!(cover === 'pit' || fortifying) || (hurtNow && dist < 4));
    const canFlee = Date.now() >= this.fleeGiveUpUntil;
    if (legacy) {
    if (creeper && instinct('creeper') && cover !== 'sealed') {
      // 正在跟它打：后撤几步躲开爆炸就行，不跑远；没在打：跑开
      if (cur?.skill !== 'flee' && this.ready('creeper', 1500)) this.fire({ skill: 'flee', args: { distance: fighting ? 6 : 12 } }, 'P0', `苦力怕${creeper.fusing ? '在嘶嘶作响，' : ''}距离 ${creeper.dist.toFixed(1)}`);
      return;
    }
    // 判断正在做什么，而不是谁发起的：主动战斗、换气和撤离同样不需要重启。
    if (cur?.skill === 'defend' || cur?.skill === 'ranged_defend') {
      if (s.hp <= 6 && instinct('losing-fight') && canFlee && this.ready('escalate', 3000)) this.flee(20, `战斗中生命 ${s.hp}`);
      return;
    }
    // 夜里低血量且身上有方块：就地挖坑封顶，比被追着跑更安全
    if (this.options.routineCare !== false && cur?.source !== 'reflex' && cur?.skill !== 'eat' && !s.isDay && s.hp <= 8 && (!nearest || nearest.dist > 4) && !s.inWater && hasPlaceable(s.inventory) && instinct('night-shelter') && this.ready('shelter', 90000)) {
      return this.fire({ skill: 'shelter', args: { until: 'day' } }, 'P0', `夜里生命只有 ${Math.round(s.hp)}`);
    }
    // 血少时逃：只为看得见、或已经贴到身边（<4 格）的怪跑；只是听见远处有动静不跑
    const threat = nearest && (nearest.perception !== 'heard' || nearest.dist < 4) ? nearest : undefined;
    if (s.hp <= 6 && threat && threat.dist < 10 && instinct('low-hp-flee') && canFlee && mustReact(threat.dist) && this.ready('lowhp', 4000)) {
      return this.flee(24, `生命 ${Math.round(s.hp * 10) / 10}，${threat.name} 在 ${threat.dist.toFixed(1)} 格`);
    }
    if (threat && threat.dist < 4 && threat.name !== 'creeper' && instinct('fight-back') && mustReact(threat.dist) && this.ready('defend', 4000)) {
      // 有武器才敢硬打；空手只在血很多时还手，否则交给脑子（垫高、堵路、跑）
      const armed = s.inventory.some((i) => /_(sword|axe)$/.test(i.name));
      if (s.hp > 8 && (armed || s.hp > 14)) return this.fire({ skill: 'defend', args: { entityId: threat.id } }, 'P1', `${threat.name} 贴近（${threat.dist.toFixed(1)} 格）`);
      if (s.hp <= 8 && canFlee) return this.flee(18, `${threat.name} 贴近且生命 ${Math.round(s.hp * 10) / 10}`, 'P1');
    }
    }
    // 非紧急动作不互相抢占，尤其不要把已经开始吃的一口掐断，再重新吃同一顿。
    if (cur?.source === 'reflex' || cur?.skill === 'eat') return;
    const safe = !nearest || nearest.dist > 8;
    // 吃东西的反射分轻重：真饿（≤6）或掉血时饥饿不满，什么都吃、马上吃；
    // 只是有点饿（7–12）时，只在有熟食/面包这类“正经食物”时顺手吃，并且不打断打猎、战斗——
    // 手上只有生肉就留给决策去决定（先烤熟更划算），而不是一捡到生肉就吃掉
    const urgent = legacy && (s.food <= 6 || (s.hp < 10 && s.food < 18));
    const eatBelow = this.options.habits?.().eat_below;
    const peckish = eatBelow ? s.food <= eatBelow : s.food <= 12 || (s.hp < 14 && s.food < 18);
    const goodFood = s.inventory.some((i) => GOOD_FOOD.test(i.name));
    const busy = !!cur && ['hunt', 'defend', 'ranged_defend', 'flee', 'dragon_fight', 'craft', 'smelt', 'build', 'climb_up', 'dig', 'store_items', 'take_items', 'ride', 'use_item', 'interact', 'sleep', 'look_around'].includes(cur.skill);
    const routineWindow = !cur || cur.source === 'filler' || (Date.now() - cur.startedAt >= 1500 && cur.progress < 0.85);
    if (cur?.skill !== 'dragon_fight' && safe && this.adapter.hasFood() && (urgent || ((this.options.routineCare !== false || !!eatBelow) && peckish && goodFood && !busy && routineWindow)) && instinct('eat') && this.ready('eat', 15000)) {
      return this.fire({ skill: 'eat' }, 'P1', `饥饿 ${s.food} / 生命 ${s.hp}${urgent ? '（很饿了，有什么吃什么）' : ''}`, !urgent);
    }

    if ((this.options.routineCare !== false || this.options.habits?.().torch_every) && instinct('torch')) this.autoTorch(s, cur, nearest?.dist ?? Infinity);
    this.checkStuck(s.pos, cur);
  }

  private lastTorch: { x: number; y: number; z: number } | null = null;
  private darkSince: number | null = null;
  private torchNear(x: number, y: number, z: number, r: number) {
    for (let dx = -r; dx <= r; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -r; dz <= r; dz++) {
      const n = this.adapter.blockAt({ x: x + dx, y: y + dy, z: z + dz });
      if (n === 'torch' || n === 'wall_torch') return true;
    }
    return false;
  }
  torchesPlaced = 0;

  /** 走进有遮蔽的暗处就顺手补一支火把（不打断计划，计划会原样继续） */
  private autoTorch(s: ReturnType<GameAdapter['state']>, cur: ReturnType<Arbiter['info']>, nearestHostile: number) {
    if (s.inWater || !s.onGround || nearestHostile < 5 || torchCount(s.inventory) === 0) { this.darkSince = null; return; }
    // 只在“走路/挖矿”这类可以顺手停一下的动作里插火把；打猎、合成、建造、爬坑这些做到一半被打断会坏事
    if (cur && (!TORCH_OK_DURING.has(cur.skill) || cur.progress >= 0.85)) { this.darkSince = null; return; }
    const x = Math.floor(s.pos.x), y = Math.floor(s.pos.y), z = Math.floor(s.pos.z);
    // 只在有遮蔽的暗处：头顶看得见天（尤其白天）不插；光照数据读不到/不可信时也不插
    const m = measureLight(this.adapter, s.pos, s.timeOfDay, s.isDay);
    if (m.sky !== false || m.level === null || m.level > 4) { this.darkSince = null; return; }
    // 从树荫/屋檐或跳跃里一闪而过不值得停下；闲着时可以直接照明，走路时先确认一直很暗。
    this.darkSince ??= Date.now();
    if (cur && Date.now() - this.darkSince < 750) return;
    const here = m.level;
    const spacing = this.options.habits?.().torch_every || 5;
    if (this.lastTorch && Math.hypot(x - this.lastTorch.x, y - this.lastTorch.y, z - this.lastTorch.z) < spacing) return;
    if (!this.ready('torch', 6000)) return;
    // 身边已经有火把了（光照数据还没刷新，或者火把被挡住）：玩家不会紧挨着再插一支
    if (this.torchNear(x, y, z, Math.max(4, spacing - 2))) return;
    this.lastTorch = { x, y, z };
    this.torchesPlaced++;
    this.triggers++;
    this.bus.publish('reflex', 'P3', `周围太暗（亮度 ${here}/15）→ 顺手插火把`);
    this.arbiter.start({ skill: 'place_torch', args: { count: 1, auto: true } }, 'reflex', { gentle: true });
  }

  /** 移动型任务 20 秒内位移 < 1.5 格且进度没有变化 → STUCK；自主模式交回决策，兼容模式自动脱困。 */
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
      if (this.options.routineCare !== false) this.arbiter.start({ skill: 'unstuck' }, 'reflex');
    }
  }
}
