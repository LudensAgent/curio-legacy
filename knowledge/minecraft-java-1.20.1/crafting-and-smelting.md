---
id: "crafting-and-smelting"
title: "合成、冶炼与燃料"
kind: "mechanic"
edition: "java"
versions: ["1.20.1"]
aliases: ["合成", "工作台", "配方", "冶炼", "烧炼", "熔炉", "高炉", "烟熏炉", "燃料", "木炭", "crafting", "smelting", "crafting_table", "furnace", "blast_furnace", "smoker", "charcoal"]
sources: [{"url":"https://minecraft.wiki/w/2%C3%972_grid","title":"Minecraft Wiki: 2×2 grid"},{"url":"https://minecraft.wiki/w/Recipe_%28Java_Edition%29","title":"Minecraft Wiki: Recipe (Java Edition)"},{"url":"https://minecraft.wiki/w/Smelting","title":"Minecraft Wiki: Smelting"},{"url":"https://minecraft.wiki/w/Smokers","title":"Minecraft Wiki: Smoker"},{"url":"https://minecraft.wiki/w/Tutorial%3ASmelting","title":"Minecraft Wiki: Tutorial:Smelting"}]
versionNote: "限 Java 1.20.1 的手动合成和既有熔炉机制；不包含后续合成器、配方文件格式或新增木材。材料替代性与产量按 1.20.1 的具体配方判断。未取得来源修订号。"
reviewedAt: "2026-10-28"
---

## crafting-grid | 合成网格与配方条件

随身物品栏提供 2×2 合成网格，工作台提供 3×3 网格；较大的配方无法放进随身网格。有序配方需要匹配形状，无序配方不依赖摆放顺序。一次配方可能产出多个物品，合成次数不一定等于成品数量。配方书是否显示一种配方，与物理上能否按正确材料合成并不完全相同；服务器可改变配方或限制未解锁配方。材料是否允许混用由具体配方决定，木材、石材或颜色并非在所有配方中都可互换。[随身网格](https://minecraft.wiki/w/2%C3%972_grid)、[Java 配方](https://minecraft.wiki/w/Recipe_%28Java_Edition%29)。

## furnaces | 熔炉、高炉与烟熏炉

冶炼用输入物、燃料和输出槽完成物品转换，不属于工作台合成。普通熔炉可处理多类材料和食物，例如粗铁到铁锭、圆石到石头、原木到木炭，以及部分生食到熟食。高炉处理其支持的矿物与金属装备配方，烟熏炉处理可烹饪食物；它们速度较快，但都不能代替普通熔炉处理任意输入。某个东西能燃烧，也不等于它适合作为冶炼输入；同样，名字像食物也不保证烟熏炉支持它。[冶炼](https://minecraft.wiki/w/Smelting)、[烟熏炉](https://minecraft.wiki/w/Smokers)。

## fuel-and-output | 燃料、处理中与取出结果

燃料有各自的燃烧时间；煤、木炭和可燃木制品并非等量等效，物品是否可作燃料由游戏规则决定。一份燃料开始燃烧后，不会因暂时移走输入而退回，尚未燃烧的剩余燃料则仍是物品。冶炼启动不等于成品已经完成，成品留在输出槽也不等于已经拿进背包；输出槽放不下产物会阻止继续处理。睡眠跳到早晨不会替熔炉补算整夜进度。[冶炼过程](https://minecraft.wiki/w/Smelting)、[燃料与手动冶炼](https://minecraft.wiki/w/Tutorial%3ASmelting)。
