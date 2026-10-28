---
id: "ore-distribution-and-search"
title: "寻找铁、煤、钻石与金矿"
kind: "mechanic"
edition: "java"
versions: ["1.20.1"]
aliases: ["矿层", "矿物分布", "找铁", "找煤", "找钻石", "找金矿", "iron ore", "coal ore", "diamond ore", "gold ore"]
sources: [{"url":"https://feedback.minecraft.net/hc/en-us/articles/4415128577293-Minecraft-Java-Edition-1-18","title":"Mojang: Minecraft Java Edition 1.18"},{"url":"https://minecraft.wiki/w/Iron_ore","title":"Minecraft Wiki: Iron Ore"},{"url":"https://minecraft.wiki/w/Coal_ore","title":"Minecraft Wiki: Coal Ore"},{"url":"https://minecraft.wiki/w/Diamond_ore","title":"Minecraft Wiki: Diamond Ore"},{"url":"https://minecraft.wiki/w/Gold_Ore","title":"Minecraft Wiki: Gold Ore"}]
versionNote: "采用 1.18 后、Java 1.20.1 的原版矿层规则；不套用 1.20.2 新增的深层钻石生成批次或后续新增结构矿物来源。生成高度只说明概率条件，不保证当前区块存在矿石。旧区块与自定义世界生成另论。"
reviewedAt: "2026-10-28"
---

## iron-and-coal | 找铁矿、找煤矿的高度与地形

铁有多个生成批次：地下批次在 Y=16 附近较集中，另有小矿团分布于 Y=-64 至 72；山地高处也有一批，在 Y=232 附近达到其高度分布峰值。高处没有岩石时不会凭空生成矿，露头和实际地形同样重要。煤主要生成于 Y=0 以上，其中一批偏向 Y=96，另一批在更高处；找深层钻石不保证同时能补到煤。煤不足时也可查[木炭与燃料](knowledge:crafting-and-smelting#fuel-and-output)。高度分布不是必须挖到某层的指令。[铁矿石](https://minecraft.wiki/w/Iron_ore)、[煤矿石](https://minecraft.wiki/w/Coal_ore)。

## diamond-and-gold | 钻石矿石、金矿石与投入选择

Java 1.20.1 钻石生成于 Y=16 以下，整体越低越多，但基岩、深板岩挖掘成本、熔岩与通路会影响实际效率；不要套用旧版“钻石都在 Y=12”或 1.20.2 增加钻石后的密度预期。部分生成尝试会跳过暴露于空气的矿，不能据此断言洞穴一定不如巷道。普通金矿的主要高度分布偏向 Y=-16，恶地另有高处金矿。用钻石采黑曜石与不采钻石而浇筑门是不同的资源方案，见[造门选择](knowledge:obsidian-and-portal-building#harvesting-or-casting)。[钻石矿石及历史](https://minecraft.wiki/w/Diamond_ore)、[1.18 矿层说明](https://feedback.minecraft.net/hc/en-us/articles/4415128577293-Minecraft-Java-Edition-1-18)。

## search-and-harvest | 发现矿物、采收到材料与维持通路

看见矿石后，还要满足[工具采收等级](knowledge:mining-and-drops#tools)：铁矿用石镐或更高，钻石矿和主世界金矿用铁镐或更高，不能因金镐挖得快就误用。粗铁、粗金需要[冶炼](knowledge:crafting-and-smelting#furnaces)才能作为普通铁锭、金锭使用。洞穴可查看露头，人工通道可暴露新岩面；哪种方式合适取决于已知通路、资源、危险和时间。已见矿脉、可达矿脉、方块掉落与材料入包分别确认；高度概率不提供透视，也不替 Agent 选择挖掘路线。[铁矿石](https://minecraft.wiki/w/Iron_ore)、[金矿石](https://minecraft.wiki/w/Gold_Ore)。
