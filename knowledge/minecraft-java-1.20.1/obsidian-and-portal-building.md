---
id: "obsidian-and-portal-building"
title: "黑曜石形成、采收与下界门结构"
kind: "mechanic"
edition: "java"
versions: ["1.20.1"]
aliases: ["黑曜石", "浇筑", "浇门", "水岩浆", "水和岩浆", "下界门建造", "点火", "十块黑曜石", "obsidian", "portal casting", "lava source", "flint and steel"]
sources: [{"url":"https://minecraft.wiki/w/Breaking","title":"Minecraft Wiki: Breaking"},{"url":"https://minecraft.wiki/w/Fluid","title":"Minecraft Wiki: Fluid"},{"url":"https://minecraft.wiki/w/Nether_Portal","title":"Minecraft Wiki: Nether Portal"},{"url":"https://minecraft.wiki/w/Crying_obsidian","title":"Minecraft Wiki: Crying Obsidian"},{"url":"https://minecraft.wiki/w/Tutorial%3ANether_portals","title":"Minecraft Wiki: Tutorial:Nether portals"},{"url":"https://minecraft.wiki/w/Tutorial%3AObsidian_farming","title":"Minecraft Wiki: Tutorial:Obsidian farming"}]
versionNote: "适用于原版 Java 1.20.1 的普通下界门和液体反应，不采用基岩版特性、自定义门形状或后续新增机制。未取得来源修订号。"
reviewedAt: "2026-10-28"
---

## harvesting-or-casting | 黑曜石下界门、钻石镐采收与水熔岩反应

黑曜石方块的物品掉落要求钻石镐或下界合金镐；其他工具破坏黑曜石不会得到该物品。黑曜石下方可能仍有熔岩，挖开后熔岩会暴露，掉落物也可能被烧毁。水接触熔岩源的顶部或侧面时，熔岩源所在位置生成黑曜石；流动熔岩侧面接触水通常生成圆石，熔岩从上方流入水则可生成石头。桶放置的熔岩源也参与这些反应，形成黑曜石的过程不需要钻石镐。液体源、接触方向和流动状态决定反应产物。下界门框既可由放置的黑曜石方块组成，也可包含在对应位置通过液体反应形成的黑曜石。

来源：[采收要求](https://minecraft.wiki/w/Breaking)、[液体混合](https://minecraft.wiki/w/Fluid)、[黑曜石取得](https://minecraft.wiki/w/Tutorial%3AObsidian_farming)。

## frame-and-ignition | 十块门框与激活条件

最小下界门是同一竖直平面内、外沿四格宽五格高的普通黑曜石矩形，内部留两格宽三格高空间。四个角不参与必要边框，所以最小门框包含十块黑曜石；其余必要框边必须连续。更大矩形也可有效，外沿最大二十三乘二十三；水平框架不满足下界门的结构条件。合格框内出现火焰时，框内会生成紫色传送区域。打火石由燧石和铁锭合成，打火石与火焰弹均可产生点火效果。哭泣的黑曜石不能替代必要框边的普通黑曜石，废弃传送门可能含有哭泣的黑曜石或不完整框架。框架激活与实体穿越传送区域是不同事件。

来源：[门框与激活](https://minecraft.wiki/w/Nether_Portal)、[浇筑与点火](https://minecraft.wiki/w/Tutorial%3ANether_portals)、[哭泣的黑曜石](https://minecraft.wiki/w/Crying_obsidian)。

## failure-diagnosis | 门框失效、流水与液体反应条件

框架材料、平面、宽高、边框连续性和框内空间共同决定下界门能否激活。打火石消耗耐久不代表已经形成有效门框，框内的水也可能使火焰熄灭。液体反应产生圆石、石头还是黑曜石，取决于源方块和接触方向；这些产物不因反复放置同样的液体而自动变成黑曜石。水源被移除后，残留流水需要时间退去；周围方块被移除也可能改变流向。下界中的普通水会蒸发，因此主世界的水与熔岩反应条件不能直接套用于下界。已激活下界门的出口位置还受[维度与传送门连接规则](knowledge:portals-and-dimensions)影响。

来源：[下界门](https://minecraft.wiki/w/Nether_Portal)、[液体反应](https://minecraft.wiki/w/Fluid)、[下界浇筑限制](https://minecraft.wiki/w/Tutorial%3AObsidian_farming)。
