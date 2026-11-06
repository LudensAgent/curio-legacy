/**
 * 养动物、和村民打交道是怎么回事：这些是游戏机制的事实（哪种动物吃什么才跟、跟多远、多久生一只；
 * 村民怎么定职业、怎么补货、价格怎么变），不是行为规则。模型对这些的记忆常常含糊或是老版本，
 * 只在它的打算里提到相关事时摆出来当说明书；要不要养、养什么、跟谁换由它自己定。
 * 数字取自 Minecraft Wiki 的 Java 版 1.14+ 机制。
 */

export const HUSBANDRY_INTENT = /养|繁殖|配种|畜栏|牲口|牧场|圈起|关起|引(诱|过来|回)|赶(回|进|过)|带(回|过)来|喂|小牛|小羊|小猪|小鸡|幼崽|breed|tame|lure|lead|pen|livestock/;
export const TRADING_INTENT = /村民|村庄|交易|换(绿宝石|东西)|绿宝石|职业|工作站|补货|zombie_villager|僵尸村民|治疗村民|villager|trade|emerald/;

interface Fact { words: RegExp; text: string }

const ANIMALS: Fact[] = [
  { words: /牛|cow|牛奶|皮革|牛肉/, text: '牛：吃小麦（wheat），掉牛肉、皮革；空桶右键挤奶' },
  { words: /羊|sheep|羊毛/, text: '羊：吃小麦（wheat），剪刀右键得 1–3 羊毛，羊吃草后羊毛会长回；两只不同颜色的羊生的小羊颜色会混（染料能混的就混）' },
  { words: /猪|pig/, text: '猪：吃胡萝卜、土豆、甜菜根（carrot/potato/beetroot）' },
  { words: /鸡|chicken|鸡蛋|羽毛/, text: '鸡：吃各种种子（wheat_seeds/melon_seeds/pumpkin_seeds/beetroot_seeds）；鸡每经过 6000–12000 个实体刻下一个蛋，相当于游戏钟表约 6–12 小时；扔蛋有 1/8 几率孵出小鸡' },
  { words: /兔|rabbit/, text: '兔子：吃胡萝卜、金胡萝卜、蒲公英' },
  { words: /马|horse|驴|donkey/, text: '马/驴：空手反复右键骑上去直到驯服；驯服后吃金苹果/金胡萝卜才繁殖；小马不能骑' },
  { words: /狼|wolf|狗/, text: '狼：喂骨头驯服（多喂几根），驯服后吃各种肉繁殖' },
  { words: /猫|cat/, text: '猫：喂生鳕鱼/生鲑鱼驯服，慢慢靠近，别突然动' },
  { words: /蜜蜂|bee|蜂蜜/, text: '蜜蜂：吃各种花；蜂巢满 5 级可用剪刀取蜂窝（honeycomb）、瓶子取蜂蜜，下面放营火才不会惹它' },
];

const COMMON = [
  '引诱：手里拿着它爱吃的东西，它在 10 格内就会跟着走；正常速度下人走路约 4.3 格/现实秒、牛羊猪约 2.5，一直走会把它甩开——几格一停等它跟上（要它跟随，需要自己按它的速度停等），掉出 10 格就不跟了',
  '繁殖：两只成年各喂一次它爱吃的（interact {"entity":"cow","with":"wheat"}），都冒心就生一只小崽；之后经过 6000 个实体刻才能再生，相当于游戏钟表约 6 小时；小崽经过 24000 个实体刻长大，相当于游戏钟表 1 天，每喂一次缩短剩余成长时间的 10%；小崽会跟着大的',
  '关住：围栏（fence，6 木板+2 木棍做 3 个）1.5 格高跳不出去，留一扇栅栏门（fence_gate）；普通一格高的墙挡不住；栏里至少 2 只才能繁殖；拴绳（lead）用线和粘液球做，能把它拴着走或拴在栏柱上',
  '食物来源：小麦从草里掉的种子种在耕地（锄头右键泥土，旁边 4 格内有水长得快）上，长 3 个游戏日左右；一块 9×9 的地够喂一小群',
];

const VILLAGERS = [
  '职业：没职业的村民会认领身边 1 个没人用的工作站方块（讲台 lectern→图书管理员卖附魔书，高炉 blast_furnace→盔甲匠，砂轮 grindstone→武器匠，制图台 cartography_table→制图师，堆肥桶 composter→农民，砍柴台 fletching_table→制箭师，锻造台 smithing_table→工具匠，锅 cauldron→皮匠，织布机 loom→牧羊人，石切机 stonecutter→石匠，酿造台 brewing_stand→牧师，桶 barrel→渔夫，烟熏炉 smoker→屠夫）；没交易过的村民，把它的工作站拆了它就丢掉职业，重新放一个就换一套新交易——可以这样刷想要的书',
  '交易：右键村民打开交易窗（use_gui / trade）；货币是绿宝石；每种交易有次数限制，卖完会锁住，村民白天回到工作站“上班”时补货，一天最多 2 次；同一样东西买多了会涨价，久不买回落；交易多了村民升级（新手→学徒→老手→专家→大师），解锁更多货',
  '便宜货：治好僵尸村民（先喷溅虚弱药水，再喂金苹果，转化需约 3600–6000 个实体刻，相当于游戏钟表约 3 小时 36 分至 6 小时）的村民终身大折扣；打村民或让它身边的村民受伤会涨价',
  '繁殖村民：村里要有多余的床（每个村民一张，再多出来的给小孩），两个村民各手里有够的食物（3 个面包，或 12 个胡萝卜/土豆/甜菜根，扔给它就捡）就会生；小村民经过 24000 个实体刻长大，相当于游戏钟表 1 天；村民 10 个以上、床够时会刷铁傀儡',
  '安全：僵尸晚上会攻击村民，把村民圈在有门有光的屋里、床在屋里；村民走丢就把它带回去——它不跟人，要用船、矿车或拴绳（1.20 村民不能拴）运，或者在它身边放床和工作站让它认新家',
  '卖给村民：农民收小麦/胡萝卜/土豆/甜菜根/南瓜/西瓜换绿宝石，渔夫收线和煤，屠夫收生肉和煤，皮匠收皮革，牧羊人收羊毛，制箭师收木棍（24 根 1 绿宝石，最简单的绿宝石来源）',
];

/** 养动物的说明书：打算里点名了哪种动物就只给那几种的吃食，没点名就全给；通用机制每次都给 */
export function husbandryFacts(intent = ''): string | null {
  if (!HUSBANDRY_INTENT.test(intent)) return null;
  const named = ANIMALS.filter((a) => a.words.test(intent));
  const list = named.length ? named : ANIMALS.slice(0, 5);
  return `养动物是这样的（游戏机制，不是要求）：${list.map((a) => a.text).join('；')}。${COMMON.join('。')}`;
}

/** 和村民打交道的说明书 */
export function villagerFacts(intent = ''): string | null {
  if (!TRADING_INTENT.test(intent)) return null;
  const pick = /繁殖|生|床|bed|铁傀儡/.test(intent) ? [VILLAGERS[3], VILLAGERS[4]]
    : /职业|工作站|书|附魔/.test(intent) ? [VILLAGERS[0], VILLAGERS[1]]
    : /僵尸|治|便宜|折扣/.test(intent) ? [VILLAGERS[2], VILLAGERS[1]]
    : /卖|换绿宝石|绿宝石/.test(intent) ? [VILLAGERS[5], VILLAGERS[1]]
    : [VILLAGERS[1], VILLAGERS[0], VILLAGERS[5]];
  return `村民是这样的（游戏机制，不是要求）：${pick.join('。')}`;
}
