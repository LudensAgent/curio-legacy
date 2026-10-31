---
id: "enchanting-and-repair"
title: "附魔、修理与附魔移除"
kind: "mechanic"
edition: "java"
versions: ["1.20.1"]
aliases: ["附魔", "修理", "合并", "修理工具", "附魔台", "铁砧", "砂轮", "enchanting", "enchanting_table", "anvil", "grindstone", "enchanted_book"]
sources: [{"url":"https://minecraft.wiki/w/Enchantability","title":"Minecraft Wiki: Enchanting table mechanics"},{"url":"https://minecraft.wiki/w/Lapis_Lazuli","title":"Minecraft Wiki: Lapis Lazuli"},{"url":"https://minecraft.wiki/w/Anvil_mechanics","title":"Minecraft Wiki: Anvil mechanics"},{"url":"https://minecraft.wiki/w/Grindstone","title":"Minecraft Wiki: Grindstone"},{"url":"https://minecraft.wiki/w/Repair","title":"Minecraft Wiki: Item repair"}]
versionNote: "仅收录 Java 1.20.1 已有的附魔台、铁砧和砂轮机制；不纳入后来新增物品的附魔兼容关系。"
reviewedAt: "2026-10-28"
---

## enchanting-table | 附魔台、青金石与书架

附魔台可为适用的未附魔装备、工具和书提供附魔选项，需要经验等级和青金石。三个选项分别消耗一、二、三颗青金石；界面要求达到的等级与实际扣除的等级不同。有效书架会提高可提供的附魔等级，最多计算十五个，书架的位置和它与附魔台之间的间隔会影响是否生效。增加书架改变可用选项，并不保证获得某一种附魔。附魔台与铁砧用途不同：已有附魔的装备，不能靠再次放进附魔台直接追加附魔。

来源：[附魔台机制](https://minecraft.wiki/w/Enchantability)、[青金石](https://minecraft.wiki/w/Lapis_Lazuli)。

## anvil | 铁砧的组合、修理与费用

铁砧左侧放保留的目标，右侧放用于修理或合并的物品。部分装备可用对应材料恢复耐久，也可组合两件同类装备；附魔书能把适用的附魔转移给目标。附魔存在兼容限制，例如精准采集与时运不能在同一工具上正常共存。既往铁砧加工会积累后续费用，交换左右物品可能改变费用或结果；单独改名不增加这种加工惩罚。生存模式中，总费用达到四十级的操作通常会被“过于昂贵”拒绝。拥有足够经验等级不保证任何组合都可用，输入物品和界面产物共同决定结果。

来源：[铁砧机制](https://minecraft.wiki/w/Anvil_mechanics)。

## crafting-combine | 工作台免费合并修理

工作台（crafting_table）的合成格放入两件同类可修理物品（如两把同材质镐），产物是两者耐久相加再加满耐久的 5%（不超过满耐久）。不消耗经验，但产物不带附魔——即使两件物品原本有附魔也会被移除。此方式与砂轮、铁砧的合并并列。

来源：[物品修理](https://minecraft.wiki/w/Repair)。

## grindstone | 砂轮移除附魔及其代价

砂轮可移除物品上的普通附魔，并返还部分经验；诅咒附魔和自定义名称不会因此消失。两件同类的可修理物品也可在砂轮中合并耐久，但这种修理会同时移除普通附魔，并非铁砧式的附魔合并。砂轮处理还能清除既往加工惩罚，因此物品耐久、附魔状态和后续铁砧费用是不同的属性。经验返还取决于被移除的附魔，不等于退回此前投入的全部经验。输出槽会显示处理后的物品预览。

来源：[砂轮](https://minecraft.wiki/w/Grindstone)、[铁砧机制](https://minecraft.wiki/w/Anvil_mechanics)。
