---
id: "fire-and-burning"
title: "火焰、着火与灭火"
kind: "mechanic"
edition: "java"
versions: ["1.20.1"]
aliases: ["火焰", "着火", "燃烧", "燃烧时间", "火焰伤害", "烧伤", "灭火", "永恒火", "灵魂火", "fire", "burning", "fire spread", "fire tick", "doFireTick", "soul fire"]
sources: [{"url":"https://minecraft.wiki/w/Fire","title":"Minecraft Wiki: Fire"},{"url":"https://minecraft.wiki/w/Damage","title":"Minecraft Wiki: Damage"},{"url":"https://minecraft.wiki/w/Cauldron","title":"Minecraft Wiki: Cauldron"},{"url":"https://minecraft.wiki/w/Water","title":"Minecraft Wiki: Water"},{"url":"https://minecraft.wiki/w/The_Nether","title":"Minecraft Wiki: The Nether"},{"url":"https://minecraft.wiki/w/Fire_Resistance","title":"Minecraft Wiki: Fire Resistance"}]
versionNote: "限定 Java 1.20.1 的火焰方块、着火、灭火与伤害分类；1.20.1 使用 doFireTick 游戏规则，不采用之后版本才加入的“玩家附近才蔓延”限制或替代游戏规则。未取得来源修订号。"
reviewedAt: "2026-11-12"
---

## fire-block | 火焰方块、可燃方块与蔓延

火焰是非固体方块，分普通火焰与灵魂火。火焰有 0–15 的 age：每个方块 tick 有 1/3 概率使 age 增加；age 大于 3 时，若周围没有可燃方块，或下方方块没有可支撑的实心顶面，火焰会在下一个方块 tick 熄灭；age 为 15 且下方没有可燃方块时，每个方块 tick 有 1/4 概率熄灭。火焰方块平均约每 30–40 游戏刻获得一次计划 tick；doFireTick 为 false 时不会蔓延、破坏方块或熄灭，但仍能伤害实体。

下界岩不是可燃方块；其上的火焰不消耗下界岩并持续燃烧，属于永恒火，类似岩浆块、灵魂沙、灵魂土和末地基岩上的火焰。Java 版下界的菌柄与菌木不属于可燃方块，因此火焰在下界主要停留在有永恒火支撑的位置；火焰仍可点燃相邻的可燃方块。火焰向水平 3×3、最多上方 4 格和下方 1 格的范围蔓延，概率受难度、火焰 age、目标可燃性和降雨影响；目标或其水平四邻上方有雨时不会蔓延。

来源：[火焰](https://minecraft.wiki/w/Fire)。

## burning | 着火时间与伤害节奏

实体接触火焰或熔岩会获得着火状态（Fire 值）。Java 版生物接触火焰方块时 Fire 值通常为 160 游戏刻（8 秒），离开火源后继续燃烧并按时间结算伤害；玩家进入着火状态时 Fire 值从 -20 刻开始，因此首次伤害最多延迟 20 刻（1 秒），Fire 值转正后设为 160 刻，并在持续接触火焰时增加。熔岩同样会使实体着火，其着火时间与熔岩伤害分别结算。

站在火焰方块内时，火焰每个游戏刻尝试造成 1 点伤害，但受击后的伤害免疫把实际节奏限制为每 0.5 秒一次；离开火焰后继续着火约为每秒 1 点伤害。灵魂火每 0.5 秒造成 2 点伤害。着火不是状态效果，牛奶不能清除；着火伤害不受盔甲点数影响，但 Protection、Fire Protection 附魔与抗性提升效果可以降低，抗火效果则完全免疫火焰与熔岩伤害。着火会在离开火焰后持续，直到 Fire 值耗尽；水、炼药锅等灭火手段可以提前结束。

来源：[火焰](https://minecraft.wiki/w/Fire)、[伤害](https://minecraft.wiki/w/Damage)、[抗火](https://minecraft.wiki/w/Fire_Resistance)。

## extinguishing | 灭火方式

水接触或流入火焰格会熄灭火焰；喷溅或滞留水瓶命中方块时熄灭该方块及水平四邻的火焰；熔岩流入火焰也会熄灭。炼药锅中的水或细雪能熄灭落入其中的着火实体，每熄灭一个实体消耗一级内容物，炼药锅最多保存三级。在火焰自身所在格放置方块会替换该火焰；破坏火焰下方的支撑方块会使失去支撑的火焰消失，而 age 大于 3 且无相邻可燃方块、下方无实心顶面的火焰也会在下一个方块 tick 熄灭。仅在火焰的相邻格放置方块不会替换火焰本身。

降雨会熄灭普通火焰：每个方块 tick 有 20% 加火焰 age 的 3 个百分点（最高 65%）的概率；永恒火不被降雨熄灭。下界没有降雨，且放置普通水会蒸发，不能在下界形成水源；炼药锅可以保存水，但只熄灭进入锅中的实体，不熄灭方块火焰。抗火效果只作用于实体，不改变方块火焰。

来源：[火焰](https://minecraft.wiki/w/Fire)、[炼药锅](https://minecraft.wiki/w/Cauldron)、[水](https://minecraft.wiki/w/Water)、[下界](https://minecraft.wiki/w/The_Nether)、[下界的液体规则](knowledge:water-and-fluids#nether-restriction)。

## damage-types | 火焰、熔岩、爆炸与摔落

火焰（着火）、熔岩、爆炸与摔落属于不同伤害来源。着火伤害不受盔甲点数影响；熔岩、火球和爆炸伤害受盔甲点数影响。Protection 附魔和抗性提升对多类伤害有效；Fire Protection 对火类伤害有效，Blast Protection 对爆炸有效，Feather Falling 只影响摔落。抗火效果免疫火焰、着火与熔岩伤害，但不免疫爆炸、摔落、窒息、虚空或龙息。

熔岩接触同时造成熔岩伤害并使实体着火，因此离开熔岩后仍可能继续燃烧；爆炸可以生成火焰或点燃方块，但爆炸伤害本身不是着火伤害；摔落伤害按落地时的下落距离结算，不属于火类伤害。火焰伤害也不是状态效果，不能用牛奶清除。相关机制见[熔岩与水](knowledge:water-and-fluids#fluid-reactions)、[摔落伤害](knowledge:fall-damage)、[抗火药水](knowledge:brewing-and-potions#fire-resistance)与[爆炸火球](knowledge:ghasts#attack)。

来源：[伤害](https://minecraft.wiki/w/Damage)、[火焰](https://minecraft.wiki/w/Fire)、[抗火](https://minecraft.wiki/w/Fire_Resistance)。
