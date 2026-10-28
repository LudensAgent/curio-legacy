---
id: "redstone-basics"
title: "红石信号、方向与逻辑元件"
kind: "mechanic"
edition: "java"
versions: ["1.20.1"]
aliases: ["红石", "红石粉", "红石火把", "中继器", "比较器", "信号强度", "延迟", "redstone", "redstone_wire", "redstone_torch", "repeater", "comparator"]
sources: [{"url":"https://minecraft.wiki/w/Soft-powered","title":"Minecraft Wiki: Redstone mechanics"},{"url":"https://minecraft.wiki/w/Redstone_component","title":"Minecraft Wiki: Redstone components"},{"url":"https://minecraft.wiki/w/Redstone_Repeater","title":"Minecraft Wiki: Redstone Repeater"},{"url":"https://minecraft.wiki/w/Redstone_Comparator","title":"Minecraft Wiki: Redstone Comparator"}]
versionNote: "仅说明 Java 1.20.1 已有元件的基本机制；不把基岩版电路、实验性红石更新或后续新增元件视为同一规则。"
reviewedAt: "2026-10-28"
---

## signal | 信号强度与红石粉传输

红石信号强度为零到十五，零表示未供能。拉杆等电源可产生信号，红石粉负责传输；信号每经过一格红石粉向下一格粉传递时会衰减一级，所以一条粉线不能无限延伸。红石粉、实体方块和用电元件之间的供能关系还受相邻位置、连接方向和方块能否传导影响，外观看起来靠近并不等于已经连通。信号通过粉线衰减到较低强度时，仍可能足以激活直接连接的元件。持续供能与短暂脉冲也是不同输入，能亮起一次并不能证明整套电路具有持续输出或所需时序。

来源：[红石机制](https://minecraft.wiki/w/Soft-powered)。

## timing | 中继器与红石火把

中继器从背面接收信号、从正面输出满强度信号，因此具有方向性；右键可循环调整四档延迟，分别为二、四、六、八个游戏刻。一个红石刻等于两个游戏刻，正常每现实秒二十游戏刻时对应零点一至零点四现实秒。红石火把默认亮起，但它附着的方块被供能时会熄灭，因此能用于反相信号。火把不能给自己附着的方块直接供能，切换状态也存在延迟；过快反复切换可导致暂时烧毁熄灭。这些元件可组成多种时序与逻辑，具体排列和输入共同决定运行结果。

来源：[中继器](https://minecraft.wiki/w/Redstone_Repeater)、[红石元件中的火把说明](https://minecraft.wiki/w/Redstone_component)。

## comparator | 比较器与容器读数

比较器从背面和两侧接收输入，从正面输出。比较模式中，若任一侧输入大于背面输入，输出为零；否则保留背面强度。右键可切换为减法模式，其输出是背面强度减去较大的侧面强度，结果最低为零。比较器还可读取部分方块的状态，例如箱子等容器的填充程度；容器读数与槽位占用及物品可堆叠数量有关，不是简单数物品种类。它与中继器的区别在于可以保留和处理强度，而不是一收到信号就统一恢复到十五。前后朝向、模式和被读取方块都影响输出。

来源：[比较器](https://minecraft.wiki/w/Redstone_Comparator)。
