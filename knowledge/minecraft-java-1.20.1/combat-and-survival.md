---
id: "combat-and-survival"
title: "战斗反馈、格挡与饥饿恢复"
kind: "mechanic"
edition: "java"
versions: ["1.20.1"]
aliases: ["战斗", "攻击", "攻击冷却", "盾牌", "弓", "饥饿", "回血", "饱和度", "combat", "attack_cooldown", "shield", "bow", "hunger", "saturation"]
sources: [{"url":"https://minecraft.wiki/w/Combat","title":"Minecraft Wiki: Combat"},{"url":"https://minecraft.wiki/w/Attack_cooldown","title":"Minecraft Wiki: Melee attack — Attack cooldown"},{"url":"https://minecraft.wiki/w/Shield","title":"Minecraft Wiki: Shield"},{"url":"https://minecraft.wiki/w/Bow","title":"Minecraft Wiki: Bow"},{"url":"https://minecraft.wiki/w/Natural_regeneration","title":"Minecraft Wiki: Food — Natural regeneration"},{"url":"https://minecraft.wiki/w/Tutorial%3AHunger_management","title":"Minecraft Wiki: Tutorial: Hunger management"}]
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
