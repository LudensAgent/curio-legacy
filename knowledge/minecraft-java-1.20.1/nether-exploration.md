---
id: "nether-exploration"
title: "下界群系、环境规则与传送门连接"
kind: "mechanic"
edition: "java"
versions: ["1.20.1"]
aliases: ["下界探索", "下界生存", "下界群系", "下界地形", "回程", "回主世界", "诡异森林", "绯红森林", "灵魂沙峡谷", "玄武岩三角洲", "nether", "nether wastes", "warped forest", "crimson forest", "soul sand valley", "basalt deltas"]
sources: [{"url":"https://www.minecraft.net/en-us/article/around-block--nether-wastes","title":"Minecraft.net: Around the Block: Nether Wastes"},{"url":"https://minecraft.wiki/w/The_Nether","title":"Minecraft Wiki: The Nether"},{"url":"https://minecraft.wiki/w/Basalt_delta","title":"Minecraft Wiki: Basalt Deltas"},{"url":"https://minecraft.wiki/w/Soul_soil","title":"Minecraft Wiki: Soul Soil"},{"url":"https://minecraft.wiki/w/Nether_Portal","title":"Minecraft Wiki: Nether Portal"}]
versionNote: "只收录 Java 1.20.1 已有的下界群系与维度规则；排除后续干恶魂等内容和 1.20.3 才加入的传送门延迟游戏规则。未取得来源修订号。"
reviewedAt: "2026-10-28"
---

## terrain-and-biomes | 下界群系与地形特征

Java 1.20.1 的下界有下界荒地、绯红森林、诡异森林、灵魂沙峡谷与玄武岩三角洲，各自具有不同的地表材料、生物分布和环境特征。荒地常有裸露下界岩和熔岩海；森林的巨大菌类可能遮挡视线；玄武岩三角洲地势破碎，黑石、玄武岩、岩浆块与小熔岩池交错。灵魂沙峡谷同时存在灵魂沙与灵魂土，灵魂土没有灵魂沙的减速效果。地形可能被熔岩或落差隔开，群系与[下界要塞](knowledge:blazes-and-fortresses)属于不同的生成概念。[官方群系介绍](https://www.minecraft.net/en-us/article/around-block--nether-wastes)、[玄武岩三角洲](https://minecraft.wiki/w/Basalt_delta)、[灵魂土](https://minecraft.wiki/w/Soul_soil)。

## dimension-rules | 下界水桶放水蒸发、床爆炸与重生条件

在下界用普通水桶放水时，水会蒸发，无法形成地面水源；炼药锅里的水属于例外。在下界尝试用床睡眠会引发爆炸，床不能设置下界重生点。有足够充能且已被设为个人重生点的重生锚可供下界重生。下界岩内部可能存在熔岩，方块被挖开后熔岩会流入空出的空间；熔岩在下界的流动速度比主世界快。火焰、熔岩、摔落和生物攻击具有不同的伤害机制。[下界规则](https://minecraft.wiki/w/The_Nether)、[床与重生](knowledge:beds-and-sleep)。

## navigation-and-return | 坐标比例与传送门配对

主世界与下界的水平坐标按八比一换算：从主世界进入下界时 X、Z 除以八，反向时乘八；Y 不按该比例缩放。换算结果是出口搜索的目标位置。游戏会搜索目标附近已有的有效门，找不到才尝试生成新门；高度、相邻传送门和可放置地形都可能改变实际配对，因此往返不一定连接同一对门。火球等影响可能让门内传送区域熄灭，保留下界门框架；只有框架、没有有效门面时无法通过该门传送。[配对与生成](https://minecraft.wiki/w/Nether_Portal)、[传送门概览](knowledge:portals-and-dimensions)。
