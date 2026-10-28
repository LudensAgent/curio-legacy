---
id: "end-exit-and-recovery"
title: "解放末地的证据、离开末地与死亡物资回收"
kind: "mechanic"
edition: "java"
versions: ["1.20.1"]
aliases: ["解放末地", "击败末影龙", "末地返回", "退出传送门", "返回主世界", "终末之诗", "末地折跃门", "末地死亡", "捡回装备", "掉落物消失", "exit_portal", "end_gateway", "credits", "item_despawn"]
sources: [{"url":"https://minecraft.wiki/w/Tutorial%3ACombat","title":"Minecraft Wiki: Tutorial: Combat"},{"url":"https://minecraft.wiki/w/Ender_dragon","title":"Minecraft Wiki: Ender Dragon"},{"url":"https://minecraft.wiki/w/Exit_portal","title":"Minecraft Wiki: End Podium / Exit portal"},{"url":"https://minecraft.wiki/w/End_portal_%28block%29","title":"Minecraft Wiki: End Portal (block)"},{"url":"https://minecraft.wiki/w/Credit_sequence","title":"Minecraft Wiki: Credit sequence"},{"url":"https://minecraft.wiki/w/End_gateway","title":"Minecraft Wiki: End Gateway"},{"url":"https://minecraft.wiki/w/The_End","title":"Minecraft Wiki: The End"},{"url":"https://minecraft.wiki/w/Item_%28entity%29","title":"Minecraft Wiki: Item (entity)"},{"url":"https://www.minecraft.net/en-us/article/spawning-and-dying","title":"Minecraft: Spawning and dying in Minecraft"}]
versionNote: "适用于原版 Java 1.20.1；个人重生点、keepInventory 和区块实体运算会影响返程与回收。真实击败、传送完成和取回物资分别确认，不采用后续版本的物品或传送规则。"
reviewedAt: "2026-10-28"
---

## victory-evidence | 龙死亡与解放末地的证据

末影龙正常死亡时会出现独特的升空分解动画和经验球，战斗结束后中央退出门面激活。Java 版“解放末地”进度与击杀归属相关，参与多人战斗不保证每位玩家都会收到同一进度。因此可分别观察龙的死亡过程、战斗结束、退出门面和自己的进度消息，它们各自说明不同事实。龙飞离可见范围、Boss 血条暂时消失、箭已经发射或附近水晶被打掉，都不足以单独证明击败。首次战斗后的龙蛋也有生成条件，之后复战不会每次再生成一枚，不能用“没看见新龙蛋”否认所有复战胜利。当前能看到并确认什么，就能据此判断到哪一步；查到死亡流程的说明不会替代现场证据。

来源：[战斗结束的死亡表现](https://minecraft.wiki/w/Tutorial%3ACombat)、[末影龙进度与战斗规则](https://minecraft.wiki/w/Ender_dragon)、[退出门生成](https://minecraft.wiki/w/Exit_portal)。

## exit-portal | 打完末影龙后的退出门与返回位置：主世界或个人重生点

主岛中央的基岩结构是末地的主要退出门，龙被击败后其中出现有效门面，玩家触碰门面即可离开。首次使用通常显示终末之诗与制作人员名单，结束或跳过后回到有效个人重生点；常见情况是主世界的床。若个人重生点是下界的有效重生锚，也可能返回下界；未设置或重生位置失效时，则回到世界出生点附近。因此退出不保证落在要塞门房，也不保证永远回到主世界同一张床。传送结束后可重新观察维度、位置、生命和背包，确认真正到达。单纯看到字幕或踏上基岩柱顶不等于已经安全返回，基岩结构与里面的传送门面也不是同一目标；离开末地后，原末地不会因此被自动重置。

来源：[退出门](https://minecraft.wiki/w/Exit_portal)、[末地门方块的返回目标](https://minecraft.wiki/w/End_portal_%28block%29)、[制作人员名单](https://minecraft.wiki/w/Credit_sequence)。

## end-gateways | 折跃门与主退出门的区别

龙被击败后，主岛边缘可生成小型基岩包围的末地折跃门，用于往返主岛与外岛；它仍在末地内传送，不负责把玩家送回主世界。中间门块的开口只有一格高，站立玩家不能像走过普通门洞那样直接进入。向门块投末影珍珠是一种进入方式，也存在借助水中游泳或强制爬行姿态穿过开口的方法；珍珠投歪可能落向旁边空地或虚空，不能把任何朝小门方向的投掷都当成已传送。外岛的返程折跃门也需要确认实际出口，部分天然折跃门会返回主岛出生平台。抵达主岛、找到中央退出门、离开末地是不同阶段，外岛地形、末地城或折跃门的发现都不能代替返程路线的观察。

来源：[末地折跃门](https://minecraft.wiki/w/End_gateway)、[外岛与进入折跃门的方法](https://minecraft.wiki/w/The_End)。

## death-and-items | 死亡掉落、五分钟与回收边界

默认不保留物品的生存世界中，死亡会使背包物资掉在死亡附近；keepInventory 等规则可能改变结果，掉进虚空也不保证留下能接近的物品。普通掉落物累计经过六千游戏刻后消失，正常速度约五分钟，但只在所在区块进行实体运算时计时；卸载或停止实体运算会暂停，而不是从死亡起算一段固定的现实倒计时。其他玩家、区块加载安排和重新接近现场都可能影响计时，不能假定自己离开末地后全部物资必然安全。火、岩浆、爆炸或坠入虚空还能使物品更早损毁。记住死亡位置只提供回收线索；看见掉落物、走到附近和背包真正增加是不同证据，是否冒险返回、携带替代装备或放弃部分物资由自己判断。

来源：[掉落物计时与环境损毁](https://minecraft.wiki/w/Item_%28entity%29)、[Mojang 的死亡与重生说明](https://www.minecraft.net/en-us/article/spawning-and-dying)。重生点机制见[传送门与维度](knowledge:portals-and-dimensions)。
