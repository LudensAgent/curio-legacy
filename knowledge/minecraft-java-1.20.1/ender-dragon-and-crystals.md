---
id: "ender-dragon-and-crystals"
title: "末影人、末地水晶与末影龙战斗机制"
kind: "mechanic"
edition: "java"
versions: ["1.20.1"]
aliases: ["解放末地", "末影龙", "打龙", "龙息", "龙栖息", "水晶回血", "铁笼水晶", "末影人", "ender_dragon", "end_crystal", "enderman", "dragon_breath", "carved_pumpkin"]
sources: [{"url":"https://minecraft.wiki/w/Enderman","title":"Minecraft Wiki: Enderman"},{"url":"https://minecraft.wiki/w/Water","title":"Minecraft Wiki: Water"},{"url":"https://minecraft.wiki/w/Armor","title":"Minecraft Wiki: Armor"},{"url":"https://minecraft.wiki/w/Ender_crystal","title":"Minecraft Wiki: End Crystal"},{"url":"https://minecraft.wiki/w/Ender_dragon","title":"Minecraft Wiki: Ender Dragon"},{"url":"https://minecraft.wiki/w/Dragon%27s_breath","title":"Minecraft Wiki: Dragon's Breath"},{"url":"https://minecraft.wiki/w/Tutorial%3ADefeating_a_stronghold","title":"Minecraft Wiki: Tutorial: Defeating the ender dragon"},{"url":"https://minecraft.wiki/w/Bed","title":"Minecraft Wiki: Bed"}]
versionNote: "仅述原版 Java 1.20.1。该版头部与其他龙部件的伤害处理有区别；不采用 Java 1.21.4 的头部命中改动、基岩版龙阶段或后续战斗规则。"
reviewedAt: "2026-10-28"
---

## arrival-and-endermen | 注视、南瓜、水与虚空

末影人通常在被攻击或被玩家直视后才对该玩家敌对；出现在玩家视野中并不必然触发敌意。戴在头部栏的雕刻南瓜能阻止注视触怒，但不会取消主动攻击的后果，也不提供普通头盔的护甲保护，原版第一人称画面还会出现南瓜遮罩。水可在末地放置，接触水会伤害末影人并使其尝试传送。水不赋予对龙息、击退或虚空的免疫。虚空伤害与生物攻击独立，玩家被击退后掉入虚空仍可能死亡。

来源：[末影人的触怒与遇水行为](https://minecraft.wiki/w/Enderman)、[水与生物](https://minecraft.wiki/w/Water)、[头部装备](https://minecraft.wiki/w/Armor)。

## crystal-healing | 水晶治疗、笼子与爆炸

主岛黑曜石柱顶的末地水晶能治疗附近的末影龙，连接它们的光束表示治疗关系；实体或方块遮住光束不会中断治疗。自然战场有十颗水晶，其中两颗外有铁栏杆笼子。水晶是实体，受到多数攻击会立即爆炸；正在接受其治疗的龙也会因此受伤。爆炸可能伤害和击退附近玩家，水能限制部分地形破坏，但不能消除爆炸的伤害和击退。铁栏杆是方块，与笼内的水晶实体分开，可能遮挡视线和箭矢。各颗水晶独立存在，单颗水晶被破坏不会自动清除其他柱顶的水晶。

来源：[末地水晶的治疗、自然生成与爆炸](https://minecraft.wiki/w/Ender_crystal)、[笼装水晶的交互条件](https://minecraft.wiki/w/Tutorial%3ADefeating_a_stronghold)。

## dragon-phases | 末影龙栖息时射箭免疫、部件伤害与龙息

末影龙会在飞行、攻击、接近中央结构、栖息和起飞等阶段间变化。栖息时它免疫箭和投掷的三叉戟；近战命中仍受距离和部件位置限制。Java 1.20.1 中，头部命中承受完整伤害，其他部件会把原伤害除以四，再加上原伤害与一之间的较小值；普通武器命中身体的伤害通常低于命中头部。龙的翼和身体碰撞可将玩家击飞。紫色龙息区域持续造成伤害，不属于普通火焰；空玻璃瓶能收集其中的龙息，所得物品用于酿造。

来源：[末影龙的阶段及部件伤害](https://minecraft.wiki/w/Ender_dragon)、[龙息收集](https://minecraft.wiki/w/Dragon%27s_breath)。

## combat-options | 箭矢、近战、爆炸与水晶治疗的交互

箭矢能对水晶或飞行中的末影龙造成命中伤害；箭具有飞行时间，命中受高度、遮挡和目标移动影响。近战攻击需要目标处于触及范围，龙的碰撞、击退和龙息仍可能同时发生。在末地尝试用床睡眠会立即引发爆炸；爆炸能伤害龙，也能伤害和击退附近玩家并产生火焰。存活的水晶通过治疗补充龙的生命值，不使龙免疫其他伤害；伤害总量超过同期治疗量时，龙的生命值仍会下降，直到死亡。

来源：[攻击与治疗机制](https://minecraft.wiki/w/Tutorial%3ADefeating_a_stronghold)、[床在末地的爆炸](https://minecraft.wiki/w/Bed)。相关条目：[战斗与生存](knowledge:combat-and-survival)。
