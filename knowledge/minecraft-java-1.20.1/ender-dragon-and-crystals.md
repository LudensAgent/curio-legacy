---
id: "ender-dragon-and-crystals"
title: "末影人、末地水晶与末影龙战斗机制"
kind: "mechanic"
edition: "java"
versions: ["1.20.1"]
aliases: ["解放末地", "末影龙", "打龙", "龙息", "龙栖息", "水晶回血", "铁笼水晶", "末影人", "ender_dragon", "end_crystal", "enderman", "dragon_breath", "carved_pumpkin"]
sources: [{"url":"https://minecraft.wiki/w/Enderman","title":"Minecraft Wiki: Enderman"},{"url":"https://minecraft.wiki/w/Water","title":"Minecraft Wiki: Water"},{"url":"https://minecraft.wiki/w/Armor","title":"Minecraft Wiki: Armor"},{"url":"https://minecraft.wiki/w/Ender_crystal","title":"Minecraft Wiki: End Crystal"},{"url":"https://minecraft.wiki/w/Ender_dragon","title":"Minecraft Wiki: Ender Dragon"},{"url":"https://minecraft.wiki/w/Dragon%27s_breath","title":"Minecraft Wiki: Dragon's Breath"},{"url":"https://minecraft.wiki/w/Tutorial%3ADefeating_a_stronghold","title":"Minecraft Wiki: Tutorial: Defeating the ender dragon"},{"url":"https://minecraft.wiki/w/Bed","title":"Minecraft Wiki: Bed"}]
versionNote: "仅述原版 Java 1.20.1。该版头部与其他龙部件的伤害处理有区别；不采用 Java 1.21.4 的头部命中改动、基岩版龙阶段或后续战斗规则。教程提供可能做法，不规定战术或执行顺序。"
reviewedAt: "2026-10-28"
---

## arrival-and-endermen | 注视、南瓜、水与虚空

末影人通常在被攻击或被玩家直视后才对该玩家敌对；仅仅在视野中看到一只，不等于已经激怒它。戴在头部栏的雕刻南瓜能避免因注视引起敌意，但不会取消主动攻击的后果，也不能提供普通头盔的护甲保护，原版第一人称画面还会受到南瓜遮罩影响。水可在末地放置，接触水会伤害末影人并使其尝试传送，因此水域可以改变它接近玩家的方式；水不是对龙息、龙的击退或虚空的通用免疫。站位还涉及岸边、平台宽度和撤回路径。避免直视、选择头部装备、利用地形或水都是可选手段，哪一种适用要结合实际接敌状态；被击退到虚空后，即使没有继续挨打也可能死亡。

来源：[末影人的触怒与遇水行为](https://minecraft.wiki/w/Enderman)、[水与生物](https://minecraft.wiki/w/Water)、[头部装备](https://minecraft.wiki/w/Armor)。

## crystal-healing | 水晶治疗、笼子与爆炸

主岛黑曜石柱顶的末地水晶能治疗附近的末影龙，连接它们的光束表示治疗关系；实体或方块遮住光束不会中断这种治疗。自然战场有十颗水晶，其中两颗外有铁栏杆笼子。水晶是实体，受到多数攻击会立即爆炸；正在接受其治疗的龙也会因此受伤。爆炸可能伤害和击退附近玩家，水能限制部分地形破坏，却不能消除爆炸的伤害和击退。铁栏杆会影响能否看到、够到或用箭命中水晶，必须区分水晶实体与挡在前面的栏杆。拆除部分笼子、改变射击角度、登高接近都是可能的处理方式，各自增加的挖掘、材料消耗与暴露风险不同；发现一颗水晶消失也不能证明其余柱顶都已清空。

来源：[末地水晶的治疗、自然生成与爆炸](https://minecraft.wiki/w/Ender_crystal)、[处理笼装水晶的参考方法](https://minecraft.wiki/w/Tutorial%3ADefeating_a_stronghold)。

## dragon-phases | 末影龙栖息时射箭免疫、部件伤害与龙息

末影龙会在飞行、攻击、接近中央结构、栖息和起飞等阶段间变化。栖息时它免疫箭和投掷的三叉戟，所以箭弹开不一定是瞄准错误；此时能否近战仍取决于距离和实际部件位置。Java 1.20.1 中，头部命中承受完整伤害，其他部件会把原伤害除以四，再加上原伤害与一之间的较小值；因此普通武器打身体通常比打头伤害低，不能把整个龙模型都当成同一个命中面。龙的翼和身体碰撞可将玩家击飞。紫色龙息区域会持续造成伤害，不是普通火焰；空玻璃瓶可收集其中的龙息用于酿造，收集成功与站位安全仍是两项不同的判断。

来源：[末影龙的阶段及部件伤害](https://minecraft.wiki/w/Ender_dragon)、[龙息收集](https://minecraft.wiki/w/Dragon%27s_breath)。

## combat-options | 可选处理方式及其代价

弓可以在有射界时远程打水晶或飞行中的龙，但箭有飞行时间，命中还受高度、遮挡和目标移动影响。近战可以利用龙靠近时的机会，却更容易遭遇碰撞、击退与龙息。搭高或拆笼能改善对柱顶水晶的接近条件，同时引入摔落、被推下高处和材料投入；这类地形修改并非必须采用的固定流程。床在末地被用于睡眠会立即爆炸，爆炸也能伤龙，因此存在用床输出伤害的玩法；它同样会伤害自己、起火并击退玩家，不能把“床能炸龙”理解为安全或必须使用。即使仍有水晶，理论上也可用超过其治疗速度的伤害击败龙。选择哪种方式、是否先处理全部水晶，取决于装备、可观察结果与自己的风险取舍。

来源：[多种战斗方法与条件](https://minecraft.wiki/w/Tutorial%3ADefeating_a_stronghold)、[床在末地的爆炸](https://minecraft.wiki/w/Bed)。相关基础机制见[战斗与生存](knowledge:combat-and-survival)。
