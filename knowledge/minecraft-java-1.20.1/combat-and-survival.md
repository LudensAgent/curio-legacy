---
id: "combat-and-survival"
title: "战斗反馈、格挡与饥饿恢复"
kind: "mechanic"
edition: "java"
versions: ["1.20.1"]
aliases: ["战斗", "攻击", "攻击冷却", "盾牌", "弓", "饥饿", "回血", "饱和度", "combat", "attack_cooldown", "shield", "bow", "hunger", "saturation", "消耗度", "饥饿消耗", "exhaustion"]
sources: [{"url":"https://minecraft.wiki/w/Combat","title":"Minecraft Wiki: Combat"},{"url":"https://minecraft.wiki/w/Attack_cooldown","title":"Minecraft Wiki: Melee attack — Attack cooldown"},{"url":"https://minecraft.wiki/w/Shield","title":"Minecraft Wiki: Shield"},{"url":"https://minecraft.wiki/w/Bow","title":"Minecraft Wiki: Bow"},{"url":"https://minecraft.wiki/w/Natural_regeneration","title":"Minecraft Wiki: Food — Natural regeneration"},{"url":"https://minecraft.wiki/w/Tutorial%3AHunger_management","title":"Minecraft Wiki: Tutorial: Hunger management"},{"url":"https://minecraft.wiki/w/Hunger#Exhaustion_level_increase","title":"Minecraft Wiki: Hunger — Exhaustion level increase"}]
versionNote: "适用于 Java 1.20.1 的正式战斗机制；不采用基岩版、Java 战斗测试快照或后来新增武器的规则。"
reviewedAt: "2026-10-28"
---

## melee | 近战攻击与冷却

Java 版近战有攻击冷却，挥击或切换主手物品后，需要一段恢复时间才能再次造成完整伤害；间隔取决于武器攻击速度。更频繁地发送左键不代表伤害同比增加，冷却不足还会影响暴击、横扫和冲刺击退等效果。实体的距离、遮挡、受击后的短暂无敌以及护甲等因素，也可能使挥击与实际生命变化不同。

来源：[Java 战斗差异](https://minecraft.wiki/w/Combat)、[攻击冷却](https://minecraft.wiki/w/Attack_cooldown)。

## defense-and-projectiles | 盾牌与远程攻击

Java 版使用盾牌时会减慢移动，开始举盾后存在短暂延迟，随后可阻挡来自正面的许多近战和投射物攻击。保护受朝向和伤害来源限制，摔落等伤害不会因此消失；斧类攻击还可能使盾牌暂时失效。举盾时不能正常发动近战攻击，因此攻击、朝向和格挡的时序会互相影响。弓通过按住使用键蓄力、松开释放箭，蓄力程度会影响箭的速度、射程和伤害。箭不是瞬间到达的射线，目标移动和弹道会影响命中；一次成功发射与一次实际命中属于不同结果。

来源：[盾牌](https://minecraft.wiki/w/Shield)、[弓](https://minecraft.wiki/w/Bow)。

## hunger-and-health | 饥饿、饱和度与生命恢复

饥饿值和饱和度是不同的量，食物可以同时恢复两者；饱和度先被消耗，之后才体现为饥饿条下降。疾跑、跳跃、攻击和自然回血等活动会增加消耗，正常步行与连续疾跑的代价不同。在开启自然生命恢复的生存世界，饥饿值至少十八时可以自然回血；降到六或以下会失去疾跑能力，降到零则开始受到饥饿伤害。饥饿能否致死取决于难度。

来源：[自然生命恢复](https://minecraft.wiki/w/Natural_regeneration)、[饥饿机制资料](https://minecraft.wiki/w/Tutorial%3AHunger_management)。

## exhaustion | 消耗度数值

Java 版用一个隐藏的消耗度累计各种动作的代价：每累计到 4.0，就扣 1 点饱和度；饱和度为零时改扣 1 点饥饿值。各动作增加的消耗度（Java 1.20.1）：游泳每米 0.01，疾跑每米 0.1，跳跃每次 0.05，疾跑跳跃每次 0.2，破坏一个方块 0.005，攻击一次 0.1，受到一次伤害 0.1；自然回血每恢复 1 点生命增加 6.0。行走、潜行、攀爬梯子和乘坐载具不增加消耗度。饥饿状态效果每级每秒增加 0.1。

自然回血的节奏：饥饿值为 20 且仍有饱和度时，约每 0.5 秒恢复 1 点生命并消耗饱和度；饥饿值在 18 及以上时，约每 4 秒恢复 1 点生命。按上面的数值，恢复 1 点生命相当于消耗 1.5 点饱和度或饥饿值；破坏一个方块的消耗是它的千分之一左右。饥饿值为零时约每 4 秒受到 1 点饥饿伤害：简单难度最低降到 10 点生命，普通难度最低降到 1 点，困难难度可以致死；和平难度不会因饥饿掉血。各种食物恢复的饥饿值与饱和度见物品自身的数值。

来源：[消耗度增加](https://minecraft.wiki/w/Hunger#Exhaustion_level_increase)、[自然生命恢复](https://minecraft.wiki/w/Natural_regeneration)。
