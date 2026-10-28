---
id: "ore-distribution-and-search"
title: "铁、煤、钻石与金矿的生成分布"
kind: "mechanic"
edition: "java"
versions: ["1.20.1"]
aliases: ["矿层", "矿物分布", "找铁", "找煤", "找钻石", "找金矿", "iron ore", "coal ore", "diamond ore", "gold ore"]
sources: [{"url":"https://feedback.minecraft.net/hc/en-us/articles/4415128577293-Minecraft-Java-Edition-1-18","title":"Mojang: Minecraft Java Edition 1.18"},{"url":"https://minecraft.wiki/w/Iron_ore","title":"Minecraft Wiki: Iron Ore"},{"url":"https://minecraft.wiki/w/Coal_ore","title":"Minecraft Wiki: Coal Ore"},{"url":"https://minecraft.wiki/w/Diamond_ore","title":"Minecraft Wiki: Diamond Ore"},{"url":"https://minecraft.wiki/w/Gold_Ore","title":"Minecraft Wiki: Gold Ore"}]
versionNote: "采用 1.18 后、Java 1.20.1 的原版矿层规则；不套用 1.20.2 新增的深层钻石生成批次或后续新增结构矿物来源。生成高度只说明概率条件，不保证当前区块存在矿石。旧区块与自定义世界生成另论。"
reviewedAt: "2026-10-28"
---

## iron-and-coal | 铁矿和煤矿在哪里生成

铁矿有多个生成批次：地下批次在 Y=16 附近较集中，另有小矿团分布于 Y=-64 至 72；山地高处也有一批，在 Y=232 附近达到其高度分布峰值。矿石只能替换符合条件的岩石，高处的空气不会因处在该高度而生成矿石。煤矿主要生成于 Y=0 以上，其中一批偏向 Y=96，另一批在更高处；煤和深层钻石的高度分布不同。高度分布描述生成概率，不保证某个区块或坐标存在矿石。[铁矿石](https://minecraft.wiki/w/Iron_ore)、[煤矿石](https://minecraft.wiki/w/Coal_ore)。

## diamond-and-gold | 钻石矿石与金矿石的生成范围

Java 1.20.1 钻石生成于 Y=16 以下，整体越低越多；部分生成尝试会跳过暴露于空气的位置。基岩占据的空间、岩石种类与地形也会影响实际可见的矿石分布。1.20.2 增加了深层钻石的生成批次，该变化不属于 1.20.1。普通金矿的主要高度分布偏向 Y=-16，恶地另有高处金矿。[钻石矿石及历史](https://minecraft.wiki/w/Diamond_ore)、[1.18 矿层说明](https://feedback.minecraft.net/hc/en-us/articles/4415128577293-Minecraft-Java-Edition-1-18)。

## search-and-harvest | 矿石采收等级与冶炼产物

矿石掉落受[工具采收等级](knowledge:mining-and-drops#tools)限制：铁矿用石镐或更高等级的镐采收，钻石矿和主世界金矿需要铁镐或更高等级的镐。金镐的挖掘速度较快，但其采收等级不足以采收这些矿石。通常情况下，铁矿和金矿分别掉落粗铁、粗金；二者经[冶炼](knowledge:crafting-and-smelting#furnaces)分别产生铁锭和金锭。矿石被破坏、产生掉落物与掉落物进入玩家背包是不同的游戏事件。[铁矿石](https://minecraft.wiki/w/Iron_ore)、[金矿石](https://minecraft.wiki/w/Gold_Ore)。
