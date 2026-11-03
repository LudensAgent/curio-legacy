---
id: "water-and-fluids"
title: "水源、流水、桶与摔落伤害"
kind: "mechanic"
edition: "java"
versions: ["1.20.1"]
aliases: ["水", "水源", "流水", "水桶", "桶", "摔落伤害", "坠落", "落地水", "water", "water bucket", "fall damage", "source block", "flowing water", "lava"]
sources: [{"url":"https://minecraft.wiki/w/Water","title":"Minecraft Wiki: Water"},{"url":"https://minecraft.wiki/w/Water_Bucket","title":"Minecraft Wiki: Water Bucket"},{"url":"https://minecraft.wiki/w/Bucket","title":"Minecraft Wiki: Bucket"},{"url":"https://minecraft.wiki/w/Damage","title":"Minecraft Wiki: Damage"},{"url":"https://minecraft.wiki/w/Fluid","title":"Minecraft Wiki: Fluid"}]
versionNote: "适用于原版 Java 1.20.1 的水与熔岩机制；不采用基岩版的摔落免伤差异或后续新增流体机制。未取得来源修订号。"
reviewedAt: "2026-11-04"
---

## source-and-flow | 水源与流水

水以两种方块状态存在：水源方块（level=0）与流水方块（level 1–7，数值表示水面高度）。只有水源方块能被空桶采集；对流水使用空桶不会得到水桶。满水桶使用时会在可放置的空格里生成一个新的水源方块，而不是流水。多个水源按特定摆放可自行形成新的水源，但单桶倒出的只是一个水源。流水会沿相邻空间蔓延，直到填满或被地形阻挡；移除水源后，残留的流水需要一段时间才会退去。

来源：[水](https://minecraft.wiki/w/Water)、[流体](https://minecraft.wiki/w/Fluid)。

## bucket-use | 桶的采集与放置

空桶对水源方块使用会把那一格水源变成空气，空桶变为水桶；对熔岩源使用同理，变为熔岩桶。满水桶使用时，水会被放置在准星所指方块的相邻空格里；目标格若已被不可替换方块占据则不会放置。放置的水源和自然水源一样参与后续流动与反应。桶放置的熔岩源同样参与液体反应。

来源：[水桶](https://minecraft.wiki/w/Water_Bucket)、[桶](https://minecraft.wiki/w/Bucket)。

## water-and-fall-damage | 水与摔落伤害

从高处坠落落入水（水源或流水）会重置摔落距离，从而免除摔落伤害；在 Java 版这与水深无关，前提是落地前实际进入了水。落入熔岩同样免除摔落伤害，但会直接受到熔岩与燃烧伤害。这一免伤只发生在坠落接触流体时，未接触流体的坠落仍按正常摔落距离计算。盾牌格挡不能免除摔落伤害，缓降等状态效果可以降低或消除摔落伤害。

来源：[伤害](https://minecraft.wiki/w/Damage)、[水](https://minecraft.wiki/w/Water)。

## fluid-reactions | 水与熔岩的反应

水接触熔岩源时，在熔岩源所在格生成黑曜石；水接触流动熔岩通常生成圆石，熔岩从上方流入水则可生成石头。反应产物取决于源方块、流动状态与接触方向，详见[黑曜石形成](knowledge:obsidian-and-portal-building)。

来源：[流体](https://minecraft.wiki/w/Fluid)。

## nether-restriction | 下界的水

下界中的普通水会蒸发：使用水桶无法在下界生成水源，主世界的水与熔岩反应条件不能直接套用于下界。详见[下界探索](knowledge:nether-exploration)。

来源：[水](https://minecraft.wiki/w/Water)、[下界浇筑限制](https://minecraft.wiki/w/Tutorial%3AObsidian_farming)。
