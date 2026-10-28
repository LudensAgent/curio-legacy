---
id: "end-exit-and-recovery"
title: "末影龙死亡、退出传送门与死亡掉落物"
kind: "mechanic"
edition: "java"
versions: ["1.20.1"]
aliases: ["解放末地", "击败末影龙", "末地返回", "退出传送门", "返回主世界", "终末之诗", "末地折跃门", "末地死亡", "捡回装备", "掉落物消失", "exit_portal", "end_gateway", "credits", "item_despawn"]
sources: [{"url":"https://minecraft.wiki/w/Tutorial%3ACombat","title":"Minecraft Wiki: Tutorial: Combat"},{"url":"https://minecraft.wiki/w/Ender_dragon","title":"Minecraft Wiki: Ender Dragon"},{"url":"https://minecraft.wiki/w/Exit_portal","title":"Minecraft Wiki: End Podium / Exit portal"},{"url":"https://minecraft.wiki/w/End_portal_%28block%29","title":"Minecraft Wiki: End Portal (block)"},{"url":"https://minecraft.wiki/w/Credit_sequence","title":"Minecraft Wiki: Credit sequence"},{"url":"https://minecraft.wiki/w/End_gateway","title":"Minecraft Wiki: End Gateway"},{"url":"https://minecraft.wiki/w/The_End","title":"Minecraft Wiki: The End"},{"url":"https://minecraft.wiki/w/Item_%28entity%29","title":"Minecraft Wiki: Item (entity)"},{"url":"https://www.minecraft.net/en-us/article/spawning-and-dying","title":"Minecraft: Spawning and dying in Minecraft"}]
versionNote: "适用于原版 Java 1.20.1；个人重生点、keepInventory 和区块实体运算会影响传送目标与死亡物品状态。不采用后续版本的物品或传送规则。"
reviewedAt: "2026-10-28"
---

## victory-evidence | 末影龙死亡与解放末地进度

末影龙正常死亡时会出现升空分解动画和经验球，战斗结束后中央退出门面激活。Java 版“解放末地”进度与击杀归属相关，多人参与同一场战斗不保证每位玩家都会获得该进度。龙飞离可见范围或 Boss 血条暂时消失与龙死亡属于不同状态；水晶被破坏也不会直接结束战斗。首次击败末影龙后会生成龙蛋，之后复战不会每次再生成一枚。

来源：[战斗结束的死亡表现](https://minecraft.wiki/w/Tutorial%3ACombat)、[末影龙进度与战斗规则](https://minecraft.wiki/w/Ender_dragon)、[退出门生成](https://minecraft.wiki/w/Exit_portal)。

## exit-portal | 末影龙死亡后的退出门：返回主世界或个人重生点

主岛中央的基岩结构是末地的主要退出门，龙被击败后其中出现有效门面，玩家触碰门面即可离开；基岩框架本身没有同样的传送效果。首次使用通常显示终末之诗与制作人员名单，结束或跳过后回到有效个人重生点，常见情况是主世界的床。若个人重生点是下界的有效重生锚，也可能返回下界；未设置或重生位置失效时，则回到世界出生点附近。退出目标不由原要塞门房的位置决定。离开末地不会自动重置末地。

来源：[退出门](https://minecraft.wiki/w/Exit_portal)、[末地门方块的返回目标](https://minecraft.wiki/w/End_portal_%28block%29)、[制作人员名单](https://minecraft.wiki/w/Credit_sequence)。

## end-gateways | 折跃门与主退出门的区别

龙被击败后，主岛边缘可生成小型基岩包围的末地折跃门，用于往返主岛与外岛。它在末地内传送，与主世界之间的维度传送无关。中间门块的开口只有一格高，站立玩家的碰撞体积无法直接通过；末影珍珠命中门块，或玩家以游泳、爬行姿态接触门块，可触发其传送。未命中门块的珍珠不会触发折跃门传送，可能落向旁边地面或虚空。外岛也有折跃门，部分天然生成的折跃门通向主岛出生平台。

来源：[末地折跃门](https://minecraft.wiki/w/End_gateway)、[外岛与进入折跃门的方法](https://minecraft.wiki/w/The_End)。

## death-and-items | 死亡掉落、五分钟与回收边界

默认不保留物品的生存世界中，死亡会使背包物资掉在死亡附近；keepInventory 等规则会改变这一结果。普通掉落物累计经过六千游戏刻后消失，正常速度约五分钟，但只在所在区块进行实体运算时计时；区块卸载或停止实体运算会暂停该计时。其他玩家与区块加载安排可能使死亡位置继续运算，因此离开末地不一定暂停掉落物计时。火、岩浆、爆炸或坠入虚空还能使物品提前损毁。尚在地面存在的物品实体与背包库存属于不同状态，拾取会将物品转入背包。

来源：[掉落物计时与环境损毁](https://minecraft.wiki/w/Item_%28entity%29)、[Mojang 的死亡与重生说明](https://www.minecraft.net/en-us/article/spawning-and-dying)。重生点机制见[传送门与维度](knowledge:portals-and-dimensions)。
