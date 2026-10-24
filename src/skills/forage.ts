import type { BlockHit } from '../adapter/types.ts';
import { lookAround } from './movement.ts';
import { clampInt, fail, isAbort, obj, ok, type Skill, type SkillCtx } from './types.ts';

/**
 * forage：没有动物可打时像玩家一样采野果——只采【看得见】的东西：
 * - 浆果丛（sweet_berry_bush，长到 age≥2 才有果）、洞穴藤蔓上的发光浆果（cave_vines 带 berries）：空手右键摘
 * - 西瓜方块：打掉掉 3–7 片西瓜片
 * - 橡树 / 深色橡树的树叶：打掉有很小概率（约 1/200）掉苹果，只能多打几片碰运气
 */
const FOODS = new Set(['apple', 'sweet_berries', 'glow_berries', 'melon_slice']);
const BERRY = new Set(['sweet_berry_bush', 'cave_vines', 'cave_vines_plant']);
const LEAVES = new Set(['oak_leaves', 'dark_oak_leaves']);
const TARGETS = [...BERRY, 'melon', ...LEAVES];
const WATERY = new Set(['water', 'lava', 'bubble_column']);
const MAX_LEAVES = 32;

const foodCounts = (ctx: SkillCtx) => {
  const m = new Map<string, number>();
  for (const i of ctx.adapter.state().inventory) if (FOODS.has(i.name)) m.set(i.name, (m.get(i.name) ?? 0) + i.count);
  return m;
};
const key = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`;

/** 这一块现在能不能采：浆果要熟了才摘，叶子只打站在地上够得着的（不为一个苹果搭柱子上树） */
function ripe(ctx: SkillCtx, h: BlockHit, feetY: number): boolean {
  const { adapter } = ctx;
  if (adapter.blockAt(h.pos) !== h.name) return false;
  if (ctx.memory.hazardAt?.(h.pos, adapter.state().dim, ['drowning', 'lava'])) return false;
  if (WATERY.has(adapter.blockAt({ ...h.pos, y: h.pos.y - 1 }) ?? 'air') && h.pos.y < feetY - 1) return false;
  const props = adapter.blockStateAt?.(h.pos)?.properties ?? {};
  if (h.name === 'sweet_berry_bush') return adapter.blockStateAt ? Number(props.age ?? 0) >= 2 : true;
  if (h.name === 'cave_vines' || h.name === 'cave_vines_plant') return String(props.berries) === 'true';
  if (LEAVES.has(h.name)) return h.pos.y <= feetY + 4 && h.pos.y >= feetY - 3 && String(props.persistent ?? 'false') !== 'true';
  return true;
}

const priority = (name: string) => (BERRY.has(name) ? 0 : name === 'melon' ? 1 : 2);

export const forage: Skill<{ count: number }> = {
  name: 'forage',
  description: '采野果充饥（没有动物可打、背包没吃的时候）：摘看得见的熟浆果丛/发光浆果、打西瓜，或多打几片橡树/深色橡树叶碰运气掉苹果（掉率很低）。只采视野里看得见的',
  argsDoc: '{"count"?: 1-16（想要几个食物）}',
  timeoutMs: 120000,
  movement: true,
  outcomeBoundary: true,
  validate(raw) {
    return { ok: true, args: { count: clampInt(obj(raw).count, 1, 16, 4) } };
  },
  async run(ctx, args) {
    const { adapter, senses, signal } = ctx;
    if (!adapter.state().connected) return fail('NOT_CONNECTED', '连接断开');
    if (adapter.state().inWater) return fail('ERROR', '人在水里，先上岸再去采野果');
    const before = foodCounts(ctx);
    const gained = () => {
      const now = foodCounts(ctx);
      return [...now].map(([n, c]) => [n, c - (before.get(n) ?? 0)] as const).filter(([, c]) => c > 0);
    };
    const total = () => gained().reduce((a, [, c]) => a + c, 0);
    const tried = new Set<string>();
    const done = { bushes: 0, melons: 0, leaves: 0, failed: 0 };
    let looked = false;
    while (total() < args.count && Date.now() < ctx.deadline - 3000) {
      signal.throwIfAborted();
      const s = adapter.state();
      if (s.emptySlots === 0) break;
      senses.refresh();
      const feetY = Math.floor(s.pos.y);
      const hits = senses.knownBlocks(TARGETS, 32)
        .filter((h) => !tried.has(key(h.pos)) && (!LEAVES.has(h.name) || done.leaves < MAX_LEAVES) && (!BERRY.has(h.name) || !!adapter.useBlockAt))
        .filter((h) => ripe(ctx, h, feetY))
        .sort((a, b) => priority(a.name) - priority(b.name) || a.dist - b.dist);
      const target = hits[0];
      if (!target) {
        if (!looked) {
          looked = true;
          ctx.progress(total() / args.count, '四下看看有没有浆果丛、西瓜、橡树');
          const r = await lookAround.run(ctx, { seconds: 4, for: 'sweet_berry_bush|melon|oak_leaves|dark_oak_leaves|cave_vines' });
          if (r.status === 'succeeded') continue;
        }
        break;
      }
      tried.add(key(target.pos));
      try {
        if (BERRY.has(target.name)) {
          ctx.progress(total() / args.count, `去摘 ${target.name === 'sweet_berry_bush' ? '甜浆果' : '发光浆果'}（${Math.round(target.dist)} 格）`);
          const r = await adapter.useBlockAt!(target.pos, '', signal);
          if (!r.ok) { done.failed++; continue; }
          done.bushes++;
          await adapter.collectNearbyDrops(signal, 4, 1500);
        } else {
          ctx.progress(total() / args.count, `去打 ${target.name}（${Math.round(target.dist)} 格）`);
          await adapter.moveTo({ kind: 'reach_block', pos: target.pos }, { signal, timeoutMs: Math.max(3000, Math.min(20000, ctx.deadline - Date.now() - 2000)) });
          const r = await adapter.dig(target.pos, signal);
          if (!r.ok) { done.failed++; continue; }
          if (target.name === 'melon') { done.melons++; await adapter.collectNearbyDrops(signal, 5, 2500); }
          else {
            done.leaves++;
            // 叶子一片片打，攒几片再去捡（苹果掉下来会滚一点）
            if (done.leaves % 4 === 0) await adapter.collectNearbyDrops(signal, 6, 1500);
          }
        }
      } catch (e) {
        if (isAbort(e)) throw e;
        if (++done.failed >= 5) break;
      }
    }
    if (done.leaves % 4) await adapter.collectNearbyDrops(signal, 6, 1500).catch((e) => { if (isAbort(e)) throw e; return 0; });
    const got = gained();
    const what = [done.bushes ? `摘了 ${done.bushes} 处浆果` : '', done.melons ? `打了 ${done.melons} 个西瓜` : '', done.leaves ? `打了 ${done.leaves} 片树叶` : ''].filter(Boolean).join('、');
    const food = got.map(([n, c]) => `${n}×${c}`).join('、');
    if (got.length) return ok(`采到 ${food}${what ? `（${what}）` : ''}`, { gained: Object.fromEntries(got), ...done });
    if (done.leaves || done.bushes || done.melons) {
      return fail('NOT_FOUND', `${what}，但什么吃的都没得到${done.leaves ? '（树叶掉苹果的概率很低，约 1/200）' : ''}；换个地方找浆果丛/西瓜，或去找动物 hunt`, { ...done });
    }
    return fail('NOT_FOUND', `${looked ? '转头找过了，' : ''}视野里没有能采的野果（熟浆果丛、发光浆果、西瓜、够得着的橡树/深色橡树叶）；可以 explore 找森林/动物，或有钓竿时钓鱼`, { ...done });
  },
};
