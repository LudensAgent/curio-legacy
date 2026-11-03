---
id: "water-and-fluids"
title: "水源、流水、桶与摔落伤害"
kind: "mechanic"
edition: "java"
versions: ["1.20.1"]
aliases: ["水", "水源", "流水", "水桶", "桶", "摔落伤害", "坠落", "落地水", "water", "water bucket", "fall damage", "source block", "flowing water", "lava"]
sources: [{"url":"https://minecraft.wiki/w/Water","title":"Minecraft Wiki: Water"},{"url":"https://minecraft.wiki/w/Water_Bucket","title":"Minecraft Wiki: Water Bucket"},{"url":"https://minecraft.wiki/w/Bucket","title":"Minecraft Wiki: Bucket"},{"url":"https://minecraft.wiki/w/Damage","title":"Minecraft Wiki: Damage"},{"url":"https://minecraft.wiki/w/Fluid","title":"Minecraft Wiki: Fluid"},{"url":"https://minecraft.wiki/w/Lava","title":"Minecraft Wiki: Lava"},{"url":"https://feedback.minecraft.net/hc/en-us/articles/10330191964941-Minecraft-Java-Edition-Snapshot-22w44a","title":"Minecraft Java Edition Snapshot 22w44a: game rules"}]
versionNote: "适用于原版 Java 1.20.1 的水与熔岩机制；水源生成规则沿用 22w44a 引入的 waterSourceConversion 名称与默认值，不采用后续版本的命名或基岩版的摔落差异。未取得 Wiki 来源修订号。"
reviewedAt: "2026-11-04"
---

## source-and-flow | 水源与流水

独立水方块 water 的方块状态 level=0 表示水源；level 1–7 表示不同高度的水平流水，level 8–15 表示下落流水。下落流水也不是水源，空桶无法从流水方块装水。水在平坦的同一高度上最多向源外延伸 7 格，并受地形阻挡，不会无限填满所有相邻空间；移除水源后，残留流水需要一段时间才会退去。

当 waterSourceConversion 为 true（Java 1.20.1 默认值），流水格水平方向至少邻接两个水源，且下方为实心方块或水源时，可以形成新的水源。因此，取走的水源可能重新生成；关闭该规则不阻止已有水向空格流入。

来源：[水](https://minecraft.wiki/w/Water)、[流体](https://minecraft.wiki/w/Fluid)、[22w44a 游戏规则](https://feedback.minecraft.net/hc/en-us/articles/10330191964941-Minecraft-Java-Edition-Snapshot-22w44a)。

## bucket-use | 桶的采集与放置

空桶从独立水源方块取水时移除该源并变为水桶；从熔岩源取熔岩时同理，变为熔岩桶。被取走的源格可以随后被邻近流水填入，或在满足水源生成条件时重新成为水源。因此，成功装满水桶不意味着原格会一直保持空气。

满水桶对普通实心方块使用时，在命中面的相邻可放置格生成水源，水桶变为空桶；目标被不可替换方块占据时不能按这种方式放置。含水方块另有机制：对可含水方块使用水桶可使其含水，空桶取出其中的水后保留原方块。放置的水源与自然水源一样参与后续流动与反应；桶放置的熔岩源同样参与液体反应。

来源：[水桶](https://minecraft.wiki/w/Water_Bucket)、[桶](https://minecraft.wiki/w/Bucket)、[水源生成](knowledge:water-and-fluids#source-and-flow)。

## water-and-fall-damage | 水与摔落伤害

从高处坠落落入水（水源或流水）会重置摔落距离，从而免除摔落伤害；在 Java 版这与水深无关，前提是落地前实际进入了水。落入熔岩则是每个游戏 tick 将累计摔落距离减半，并非像水一样立即清零。它可以降低或免除摔落伤害，但不能保证免伤：接触浅层熔岩后很快撞到下方实心方块时，仍可能摔伤，并可能受到熔岩与燃烧伤害。未接触流体的坠落仍按正常摔落距离计算。盾牌格挡不能免除摔落伤害，缓降等状态效果可以降低或消除摔落伤害。

来源：[伤害](https://minecraft.wiki/w/Damage)、[水](https://minecraft.wiki/w/Water)、[熔岩](https://minecraft.wiki/w/Lava)。

## fluid-reactions | 水与熔岩的反应

水接触熔岩源时，在熔岩源所在格生成黑曜石；水接触流动熔岩通常生成圆石，熔岩从上方流入水则可生成石头。反应产物取决于源方块、流动状态与接触方向，详见[黑曜石形成](knowledge:obsidian-and-portal-building)。

来源：[流体](https://minecraft.wiki/w/Fluid)。

## nether-restriction | 下界的水

下界中的普通水会蒸发：使用水桶无法在下界生成水源，主世界的水与熔岩反应条件不能直接套用于下界。详见[下界探索](knowledge:nether-exploration)。

来源：[水](https://minecraft.wiki/w/Water)、[下界浇筑限制](https://minecraft.wiki/w/Tutorial%3AObsidian_farming)。
