---
id: "fall-damage"
title: "摔落伤害：公式、减免与落地缓冲"
kind: "mechanic"
edition: "java"
versions: ["1.20.1"]
aliases: ["摔落伤害", "坠落伤害", "摔伤", "坠落", "摔落", "fall damage", "fall_damage", "feather falling", "摔落保护", "安全下落距离", "下落距离"]
sources: [{"url":"https://minecraft.wiki/w/Damage","title":"Minecraft Wiki: Damage"},{"url":"https://minecraft.wiki/w/Feather_Falling","title":"Minecraft Wiki: Feather Falling"},{"url":"https://minecraft.wiki/w/Water","title":"Minecraft Wiki: Water"},{"url":"https://minecraft.wiki/w/Lava","title":"Minecraft Wiki: Lava"},{"url":"https://minecraft.wiki/w/Shield","title":"Minecraft Wiki: Shield"},{"url":"https://minecraft.wiki/w/Potion_of_Slow_Falling","title":"Minecraft Wiki: Potion of Slow Falling"}]
versionNote: "按 Java 1.20.1 的默认摔落规则整理；不引入后续版本新增的实体属性名称，也不采用基岩版差异。未取得来源修订号。"
reviewedAt: "2026-11-12"
---

## formula | 伤害公式与默认数值

Java 版摔落伤害在实体落地时结算，依据下落前后的 Y 坐标差，而不是落地瞬间的速度。默认公式为：摔落伤害 = max(0, ceil((下落距离 − 安全下落距离) × 摔落伤害倍率))。默认安全下落距离为 3 格（准确地说略高于 3 格），倍率为 1，因此下落 3 格不受伤，4 格约 1 点伤害，之后每多下落 1 格约多 1 点伤害并向上取整（例如 3.5 格会算 1 点）；23 格约造成 20 点伤害。默认玩家与多数生物使用这组数值，特定生物或效果可能改变实际结果。

来源：[伤害](https://minecraft.wiki/w/Damage)。

## reductions | 附魔、效果与护甲

盔甲点数本身不减少摔落伤害；只有 Protection 附魔和 Feather Falling 会减少摔落伤害，Fire Protection、Blast Protection、Projectile Protection 不减少摔落伤害。Feather Falling 减免更高：每级减少 12%，Feather Falling IV 减少 48%；Feather Falling 与 Protection 叠加，总减免有上限，约为 80%。抗性提升每级减少 20% 伤害，也适用于摔落。跳跃提升每级在增加跳跃高度的同时减少 1 点摔落伤害。盾牌不格挡摔落伤害。

缓降效果在下落期间完全免除摔落伤害；效果结束后继续下落会重新累计落差。末影珍珠传送会重置下落距离，但传送本身对玩家造成 5 点伤害。

来源：[伤害](https://minecraft.wiki/w/Damage)、[摔落保护](https://minecraft.wiki/w/Feather_Falling)、[盾牌](https://minecraft.wiki/w/Shield)、[缓降](https://minecraft.wiki/w/Potion_of_Slow_Falling)。

## buffers | 水、熔岩与其他落地缓冲

落入水（水源或流水）会在落地前重置下落距离，从而免除摔落伤害；Java 版与水深无关，但实体必须实际进入水。乘船会完全免除乘员的摔落伤害。落入熔岩不是立即清零：每个游戏 tick 把累计下落距离减半，浅层熔岩中很快撞到下方实心方块时仍可能摔伤，并另外受到熔岩与着火伤害。

其他缓冲：干草块与蜂蜜块把摔落伤害降到 20%；黏液块免除摔落伤害但会把实体弹起，潜行落地可避免弹起；床把有效下落距离减半，摔落伤害约为原来的一半并保留弹起；蛛网、梯子、藤蔓、细雪、甜浆果丛会重置或减少下落距离；在至少两格高的脚手架堆上潜行落地可免除任意高度的摔落伤害。鞘翅滑翔在正常浅角度落地时不累计摔落伤害；落地角度比约 50° 更陡（包括失速）时会摔伤。

来源：[伤害](https://minecraft.wiki/w/Damage)、[水](https://minecraft.wiki/w/Water)、[熔岩](https://minecraft.wiki/w/Lava)、[水与摔落](knowledge:water-and-fluids#water-and-fall-damage)、[鞘翅滑翔](knowledge:elytra-flight#glide-dynamics)。

## when-applies | 适用时机与边界

摔落伤害在实体从空中落到可站立方块或地面时结算；下落距离按实体从开始下落到落地时的 Y 坐标变化累计，落地时一次性结算。它不属于火、爆炸或熔岩伤害，不能被盾牌格挡；盔甲点数无效，但 Protection 与 Feather Falling 有效。摔落伤害在所有维度都存在；虚空伤害、窒息、溺水、饥饿和龙息是其他伤害来源。

来源：[伤害](https://minecraft.wiki/w/Damage)、[火焰与伤害分类](knowledge:fire-and-burning#damage-types)、[盾牌与防御](knowledge:combat-and-survival#defense-and-projectiles)、[缓降效果](knowledge:brewing-and-potions#slow-falling)。
