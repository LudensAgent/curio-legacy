---
id: "nether-exploration"
title: "下界探索、环境规则与回程"
kind: "mechanic"
edition: "java"
versions: ["1.20.1"]
aliases: ["下界探索", "下界生存", "下界群系", "下界地形", "回程", "回主世界", "诡异森林", "绯红森林", "灵魂沙峡谷", "玄武岩三角洲", "nether", "nether wastes", "warped forest", "crimson forest", "soul sand valley", "basalt deltas"]
sources: [{"url":"https://www.minecraft.net/en-us/article/around-block--nether-wastes","title":"Minecraft.net: Around the Block: Nether Wastes"},{"url":"https://minecraft.wiki/w/The_Nether","title":"Minecraft Wiki: The Nether"},{"url":"https://minecraft.wiki/w/Basalt_delta","title":"Minecraft Wiki: Basalt Deltas"},{"url":"https://minecraft.wiki/w/Soul_soil","title":"Minecraft Wiki: Soul Soil"},{"url":"https://minecraft.wiki/w/Nether_Portal","title":"Minecraft Wiki: Nether Portal"}]
versionNote: "只收录 Java 1.20.1 已有的下界群系与维度规则；排除后续干恶魂等内容和 1.20.3 才加入的传送门延迟游戏规则。坐标换算不是现场通路或传送门配对证明；未取得来源修订号。"
reviewedAt: "2026-10-28"
---

## terrain-and-biomes | 群系是环境线索，不是通路保证

Java 1.20.1 的下界有下界荒地、绯红森林、诡异森林、灵魂沙峡谷与玄武岩三角洲。它们改变地表材料、生物分布和环境特征，不提供固定可走路线：荒地常有裸露下界岩和熔岩海；森林的巨大菌类可能遮挡视线；玄武岩三角洲地势破碎，黑石、玄武岩、岩浆块与小熔岩池交错。灵魂沙峡谷的灵魂沙与灵魂土也不同，灵魂土没有灵魂沙的减速效果。隔着熔岩看见陆地，不代表两点之间存在桥或可落脚的岸；看见某群系也不代表已经找到[下界要塞](knowledge:blazes-and-fortresses)。[官方群系介绍](https://www.minecraft.net/en-us/article/around-block--nether-wastes)、[玄武岩三角洲](https://minecraft.wiki/w/Basalt_delta)、[灵魂土](https://minecraft.wiki/w/Soul_soil)。

## dimension-rules | 下界水桶放水蒸发、床爆炸与重生条件

下界不能像主世界那样把水桶中的水放成水源；水会蒸发，炼药锅里的水是例外，不能当作地面的水路或落水缓冲。对着床尝试睡眠会爆炸，床不能设置下界重生点；有足够电荷并实际设为重生点的重生锚则可以在这里使用。下界岩内可能藏有熔岩，挖开之后环境会改变；熔岩在下界流动更快，原来干燥的落脚处不保证一直干燥。火焰、熔岩、摔落和生物攻击是不同风险，一种防护不自动覆盖其他伤害。是否继续、绕行、施工或返回，由当时掌握的材料、状态和目标决定；规则本身没有要求唯一走法。[下界规则](https://minecraft.wiki/w/The_Nether)、[床与重生](knowledge:beds-and-sleep)。

## navigation-and-return | 坐标比例与实际返回地点

主世界与下界的水平坐标按八比一换算：从主世界进入下界时 X、Z 除以八，反向时乘八；Y 不按该比例缩放。换算结果是寻找出口的目标位置，不是承诺出现一扇新门或回到原来那扇门。游戏会搜索目标附近已有的有效门，找不到才尝试生成新门；高度、相邻传送门和可放置地形都可能改变实际配对。某扇门的存在、是否仍激活、它实际通向哪里，以及从当前位置能否走回门口，需要分别确认。火球等影响也可能让门内传送区域熄灭；框架还在不等于能传送，重新点燃和重新建门是不同物资需求。[配对与生成](https://minecraft.wiki/w/Nether_Portal)、[传送门概览](knowledge:portals-and-dimensions)。
