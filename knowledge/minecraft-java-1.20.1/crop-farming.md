---
id: "crop-farming"
title: "耕地、作物生长与收获"
kind: "mechanic"
edition: "java"
versions: ["1.20.1"]
aliases: ["种植", "农田", "耕地", "灌溉", "成熟", "小麦种子", "胡萝卜", "马铃薯", "甜菜", "骨粉", "farmland", "wheat_seeds", "carrot", "potato", "beetroot_seeds", "bone_meal"]
sources: [{"url":"https://minecraft.wiki/w/Farmland","title":"Minecraft Wiki: Farmland"},{"url":"https://minecraft.wiki/w/Block_light","title":"Minecraft Wiki: Light"},{"url":"https://minecraft.wiki/w/Tutorial%3ACrop_farming","title":"Minecraft Wiki: Tutorial:Crop farming"},{"url":"https://minecraft.wiki/w/Bonemeal","title":"Minecraft Wiki: Bone Meal"},{"url":"https://minecraft.wiki/w/Potatoes","title":"Minecraft Wiki: Potato"}]
versionNote: "只说明 Java 1.20.1 已有的小麦、胡萝卜、马铃薯与甜菜；当前来源含后续植物，本篇未纳入。作物数量与等待时长不作为保证。未取得来源修订号。"
reviewedAt: "2026-10-28"
---

## planting | 耕地种植、作物材料与水源位置

这些作物需要耕地，小麦用小麦种子种植，甜菜用甜菜种子；胡萝卜与马铃薯直接以自身种植。收获的小麦不能当种子种回去，烤马铃薯与毒马铃薯也不能代替普通马铃薯种植。锄头能把合适的泥土类地面变成耕地。对一块耕地，水位于其同层或高一层、水平各方向四格内即可湿润它，淋到雨也能湿润；干燥且没有种作物的耕地可能变回泥土。湿润影响生长条件，不等于作物已经成熟。[耕地](https://minecraft.wiki/w/Farmland)、[作物材料](https://minecraft.wiki/w/Tutorial%3ACrop_farming)。

## growth | 光照、随机生长与骨粉

小麦、胡萝卜、马铃薯和甜菜的自然生长需要作物所在格有足够光照，Java 1.20.1 的生长门槛是光照等级 9；检查的是作物格，不是更高的空气格。湿润耕地与周围种植布局会改变生长速度，随机更新意味着不能承诺等待固定秒数必熟。骨粉可以推进这些作物的生长，但单次未必使未成熟作物直接成熟。骨粉也不是对所有植物通用：Java 版甘蔗不能用骨粉催长，南瓜和西瓜的成熟茎也不会因此立即结出果实。[光照](https://minecraft.wiki/w/Block_light)、[骨粉](https://minecraft.wiki/w/Bonemeal)。

## harvest | 成熟状态、掉落与再次种植

作物可以提前打掉，但未成熟时通常只能回收种植材料，无法得到成熟收获。成熟的小麦产出小麦与种子，胡萝卜和马铃薯得到可再次种植的作物，甜菜得到甜菜与种子；产量受具体掉落规则影响，不能按一次观察保证以后同量。踩踏或改变承托地块也可能破坏耕地和作物。收下成品不会自动补种；用于[动物繁殖](knowledge:animal-husbandry#food-and-following)、烹饪、交易和保留种植材料是不同用途，是否分配给哪一项由当时目标决定。[种植与收获](https://minecraft.wiki/w/Tutorial%3ACrop_farming)、[马铃薯](https://minecraft.wiki/w/Potatoes)。
