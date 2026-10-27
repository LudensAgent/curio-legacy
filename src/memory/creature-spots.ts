import type { Vec3Like } from '../adapter/types.ts';
import type { Landmark } from './store.ts';

/**
 * 不主动攻击的生物在哪一带出没（羊、牛、猪、鸡、狼、村民……）：看见时记下，想要羊毛、找肉、找村庄时想得起来。
 * 动物会走动：只当作“大概在这一带”，带上多久前看见；太久没再确认的不再提。
 */

/** 超过这么久没再看见，就不当回事了（动物会走远） */
export const HERD_MAX_AGE_MS = 3 * 3600_000;
/** 不值得记的：一闪而过、或者本来就到处都是 */
export const HERD_SKIP = new Set(['bat', 'glow_squid', 'tropical_fish', 'pufferfish', 'wandering_trader', 'trader_llama']);

/** 中文里说起它的词：回想按词重叠打分，“找羊”“羊毛”要能想起 sheep */
const CREATURE_ZH: Record<string, string> = {
  sheep: '羊 绵羊 羊毛 羊肉 找羊 剪羊毛 做床', cow: '牛 奶牛 牛肉 皮革 牛奶 找牛', mooshroom: '哞菇 蘑菇牛 蘑菇煲', pig: '猪 猪肉 找猪',
  chicken: '鸡 鸡肉 鸡蛋 羽毛 找鸡', rabbit: '兔子 兔肉 兔子皮', horse: '马 骑马', donkey: '驴', mule: '骡子', llama: '羊驼',
  goat: '山羊 山羊角', wolf: '狼 驯服 狼骨', fox: '狐狸', cat: '猫', ocelot: '豹猫', panda: '熊猫 竹子', polar_bear: '北极熊',
  bee: '蜜蜂 蜂蜜 蜂巢', villager: '村民 村庄 交易 绿宝石', iron_golem: '铁傀儡 村庄', turtle: '海龟 海龟蛋', dolphin: '海豚',
  cod: '鳕鱼 鱼 钓鱼', salmon: '鲑鱼 鱼 钓鱼', squid: '鱿鱼 墨囊', axolotl: '美西螈', frog: '青蛙', strider: '炽足兽', enderman: '末影人 末影珍珠',
  zombified_piglin: '僵尸猪灵 金粒', piglin: '猪灵 以物易物', camel: '骆驼', sniffer: '嗅探兽', allay: '悦灵',
};
export function creatureAlias(label: string): string { return CREATURE_ZH[label] ?? ''; }

const DIRS = ['东', '东南', '南', '西南', '西', '西北', '北', '东北'];
function dir(dx: number, dz: number): string {
  if (Math.hypot(dx, dz) < 1) return '';
  return DIRS[Math.floor(((Math.atan2(dz, dx) * 180 / Math.PI + 360 + 22.5) % 360) / 45)];
}
const ago = (ms: number) => { const m = Math.round(ms / 60000); return m < 1 ? '刚才' : m < 60 ? `${m} 分钟前` : `${Math.round(m / 60)} 小时前`; };

export interface CreatureSpot { label: string; pos: Vec3Like; dist: number; text: string; id: string; ageMs: number }

/** 某个位置附近记得的生物出没点（同一世界、同一维度、不太旧），近的在前；only 限定只要哪些生物 */
export function creatureSpotsNear(landmarks: Landmark[], at: { worldId?: string; dim: string; pos: Vec3Like }, opts: { only?: string[]; radius?: number; excludeWithin?: number; now?: number } = {}): CreatureSpot[] {
  const now = opts.now ?? Date.now(), radius = opts.radius ?? 256, skipNear = opts.excludeWithin ?? 0;
  return landmarks
    .filter((l) => l.kind === 'herd' && l.dim === at.dim && (!at.worldId || !l.worldId || l.worldId === at.worldId)
      && now - l.ts <= HERD_MAX_AGE_MS && (!opts.only || opts.only.includes(l.label)))
    .map((l) => {
      const dx = l.pos.x - at.pos.x, dy = Math.round(l.pos.y - at.pos.y), dz = l.pos.z - at.pos.z;
      const dist = Math.round(Math.hypot(dx, dy, dz));
      const height = dy >= 4 ? `，高 ${dy} 格` : dy <= -4 ? `，低 ${-dy} 格` : '';
      const what = `${l.count ?? 1} 只${l.detail ? `（${l.detail}）` : ''}`;
      return { label: l.label, pos: l.pos, dist, id: l.id, ageMs: now - l.ts,
        text: `(${l.pos.x},${l.pos.y},${l.pos.z}) ${dir(dx, dz)}${Math.round(Math.hypot(dx, dz))}格${height}，${what}，${ago(now - l.ts)}看见` };
    })
    .filter((o) => o.dist <= radius && o.dist >= skipNear)
    .sort((a, b) => a.dist - b.dist);
}

/** 按种类归拢：每种只留最近的 perKind 处 */
export function creatureSpotsByKind(spots: CreatureSpot[], perKind: number, maxKinds = 8): Record<string, string> {
  const out: Record<string, string[]> = {};
  for (const s of spots) {
    if (!out[s.label] && Object.keys(out).length >= maxKinds) continue;
    (out[s.label] ??= []);
    if (out[s.label].length < perKind) out[s.label].push(s.text);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join('；')]));
}
