---
id: "blazes-and-fortresses"
title: "下界要塞、烈焰人和烈焰棒"
kind: "mechanic"
edition: "java"
versions: ["1.20.1"]
aliases: ["下界要塞", "找下界要塞", "下界要塞位置", "下界要塞分布", "下界要塞生成", "结构区域", "nether_complexes", "下界堡垒", "要塞", "猪灵堡垒", "堡垒遗迹", "烈焰人", "烈焰棒", "烈焰粉", "烈焰人刷怪笼", "抗火", "nether fortress", "bastion remnant", "blaze", "blaze_rod", "blaze_powder", "spawner"]
sources: [{"url":"https://minecraft.wiki/w/Nether_fortress","title":"Minecraft Wiki: Nether Fortress"},{"url":"https://minecraft.wiki/w/Generated_structure","title":"Minecraft Wiki: Structure"},{"url":"https://minecraft.wiki/w/Blazes","title":"Minecraft Wiki: Blaze"},{"url":"https://minecraft.wiki/w/Mob_spawner","title":"Minecraft Wiki: Monster Spawner"},{"url":"https://minecraft.wiki/w/Shield","title":"Minecraft Wiki: Shield"},{"url":"https://minecraft.wiki/w/Fire_Resistance","title":"Minecraft Wiki: Fire Resistance"},{"url":"https://minecraft.wiki/w/Blaze_rod","title":"Minecraft Wiki: Blaze Rod"},{"url":"https://www.minecraft.net/en-us/article/meet-blaze","title":"Minecraft.net: Meet the Blaze"},{"url":"https://minecraft.wiki/w/Structure_set","title":"Minecraft Wiki: Structure set"}]
versionNote: "限定 Java 1.20.1 的常规要塞、烈焰人、刷怪笼与掉落规则；不引入试炼刷怪笼或后续新增生物。要塞可出现在所有下界群系，不能混同于堡垒遗迹的群系限制。未取得来源修订号。"
reviewedAt: "2026-11-11"
---

## structures | 下界要塞与堡垒遗迹不同

下界要塞主要由暗红色下界砖组成，常有长桥、走廊、支柱、下界疣区域和烈焰人刷怪笼；可以生成在所有下界群系，部分结构可能埋在下界岩中。堡垒遗迹俗称猪灵堡垒，主要是黑石建筑，关联猪灵、猪灵蛮兵和不同类型的战利品，不是烈焰人的生成结构。宝箱和下界疣并非下界要塞独有的特征。下界要塞的桥面与走廊存在高低差，内部还可能出现凋灵骷髅等生物。[下界要塞](https://minecraft.wiki/w/Nether_fortress)、[结构区别](https://minecraft.wiki/w/Generated_structure)。

## generation | 下界要塞的生成位置、区域间距与埋藏

Java 版把下界划分成 432×432 格（27×27 区块）的区域，每个区域里最多生成下界要塞或堡垒遗迹中的一个，两种结构不会出现在同一区域。结构集 `nether_complexes` 的间距为 27 区块、间隔为 4 区块：每个区域南侧和东侧边缘各有 4 区块不放置生成尝试，可用范围为 368×368 格（23×23 区块），因此相邻两次生成尝试之间的距离不固定，平均间隔为 27 区块。每次尝试生成下界要塞的概率是 2/5，其余为堡垒遗迹；自 1.18.2 起，落在玄武岩三角洲的堡垒遗迹尝试会改为生成下界要塞，所以下界要塞在玄武岩三角洲相对更常见。下界要塞可以出现在所有下界群系。

生成从所选区块内区块坐标 (11, ~, 11) 处的一个四向十字路口开始，向外接出桥、走廊、楼梯、房间和刷怪笼平台等组件：室外部分最多包含五个普通四向十字路口、四个拱形四向十字路口、四个小房间和两个烈焰人刷怪笼平台；室内部分最多包含五个四向十字路口、二十个转角、三段向下的楼梯、两个三向路口和两个通往下界疣花园的楼梯房间。桥由支柱支撑，支柱向下延伸到地面，常伸进熔岩海。下界要塞可以整体或部分埋在下界岩中：内部通道是空的，外部桥段穿过岩体时看起来像隧道；结构被截断处不会清除地形，隧道可能止于一面下界岩墙。末影之眼指向的是主世界的要塞（stronghold），与下界要塞的位置无关，见[末影之眼](knowledge:ender-pearls-and-eyes)。[下界要塞](https://minecraft.wiki/w/Nether_fortress)、[结构集](https://minecraft.wiki/w/Structure_set)。

## spawning | 烈焰人自然生成与刷怪笼条件

烈焰人既能按下界要塞结构的规则自然生成，也能由要塞里的烈焰人刷怪笼生成。Java 1.20.1 中烈焰人生成允许的光照上限是 11。普通刷怪笼要求玩家位于附近的激活范围内，通常为 16 格，还要有符合对应生物条件的空间。距离、光照、空间、附近已有生物数量和难度都会影响生成。和平难度不会正常生成烈焰人；刷怪笼内部的旋转动画不代表生成条件全部满足。刷怪笼被破坏后，该笼不再生成生物，但不改变下界要塞中的自然生成规则。[烈焰人生成](https://minecraft.wiki/w/Blazes)、[刷怪笼条件](https://minecraft.wiki/w/Mob_spawner)。

## combat-and-drops | 烈焰人火球、防护与烈焰棒掉落

烈焰人会发射小火球，也能近身攻击。举起且朝向来袭方向的盾牌能挡住小火球，不能抵消脚下的火或熔岩。烈焰人免疫火焰伤害，但弓箭的直接命中仍可造成伤害。抗火效果抵御火焰和熔岩伤害，不消除近战或摔落伤害。烈焰棒只在玩家或驯服的狼击杀时有机会掉落；一次击杀可能没有掉落，抢夺会影响掉落数量。掉落的烈焰棒以物品实体存在，被拾取后才进入背包。烈焰棒可加工成烈焰粉，后者用于[末影之眼](knowledge:ender-pearls-and-eyes)和酿造。[盾牌](https://minecraft.wiki/w/Shield)、[抗火](https://minecraft.wiki/w/Fire_Resistance)、[棒的掉落](https://minecraft.wiki/w/Blaze_rod)、[官方用途说明](https://www.minecraft.net/en-us/article/meet-blaze)。
