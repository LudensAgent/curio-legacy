---
id: "strongholds-and-end-entry"
title: "要塞结构、末影之眼定位与末地门"
kind: "mechanic"
edition: "java"
versions: ["1.20.1"]
aliases: ["要塞", "末影之眼", "三角定位", "找门房", "末地门", "激活末地门", "stronghold", "eye_of_ender", "end_portal", "end_portal_frame", "silverfish"]
sources: [{"url":"https://minecraft.wiki/w/Eye_of_ender","title":"Minecraft Wiki: Eye of Ender"},{"url":"https://minecraft.wiki/w/Tutorial%3ADefeating_a_stronghold","title":"Minecraft Wiki: Tutorial: Defeating the ender dragon — Locating a stronghold"},{"url":"https://minecraft.wiki/w/Stronghold","title":"Minecraft Wiki: Stronghold"},{"url":"https://minecraft.wiki/w/Silverfish","title":"Minecraft Wiki: Silverfish"},{"url":"https://minecraft.wiki/w/End_portal_frame","title":"Minecraft Wiki: End Portal Frame"},{"url":"https://minecraft.wiki/w/End_portal","title":"Minecraft Wiki: End portal"},{"url":"https://minecraft.wiki/w/The_End","title":"Minecraft Wiki: The End"}]
versionNote: "适用于原版 Java 1.20.1；不采用基岩版村庄与要塞的位置关系、后续试炼设施或虫蚀药水机制。"
reviewedAt: "2026-10-28"
---

## eye-direction | 末影之眼方向与三角定位

在主世界抛出末影之眼，它会朝最近要塞的方向飞行，随后可能掉落或破碎。它指向要塞起始楼梯所在区域，并不直接指向末地门房。不同位置的投掷位置与飞行方向形成定位射线；指向同一要塞的射线交点与该要塞区域相关。角度误差会放大，接近平行的射线难以给出可靠交点；两次投掷也可能对应不同的最近要塞。接近定位目标时，眼可能朝地下移动。飞行方向不包含门房高度、地下入口或可通行路线的信息。

来源：[末影之眼](https://minecraft.wiki/w/Eye_of_ender)、[定位与三角测量参考](https://minecraft.wiki/w/Tutorial%3ADefeating_a_stronghold)。

## stronghold-interior | 要塞里的传送门房、地下通路与蠹虫

要塞由楼梯、走廊、房间等结构组成，天然洞穴或相邻结构可能切开通道。石砖、门、图书馆和传送门房是要塞中的不同组成部分，图书馆所在的走廊不一定直接连接门房。Java 版门房内有十二格门框，下面有岩浆，台阶附近有蠹虫刷怪笼。蠹虫也可能藏在虫蚀方块中，方块被挖开后会释放它们。蠹虫被玩家伤害而未死亡时，还可能使附近虫蚀方块中的同类出现。

来源：[要塞](https://minecraft.wiki/w/Stronghold)、[蠹虫](https://minecraft.wiki/w/Silverfish)。

## portal-frames | 十二门框、方向与不可回收的眼

通常的末地门环在每边排列三个门框，共十二个，围出三乘三的内部区域，四角没有门框。有效门框朝向环内；天然生成的门房已经设置这些朝向。生存模式无法正常取得、合成或挖走门框。门框生成时可能已经带眼，空框可用末影之眼填入；嵌进去的眼无法取回。所有有效门框都带眼后，内部会生成末地传送门方块。门框朝向是方块自身状态，不随玩家插眼时的站位改变；已带眼的门框不能再装入一颗眼。

来源：[末地传送门框架](https://minecraft.wiki/w/End_portal_frame)、[末地门](https://minecraft.wiki/w/End_portal)。

## entry-conditions | 激活、触碰门面与到达平台

末地门激活后，玩家触碰有效门面就会立即传送，没有下界门的等待过程。站在门环内部时，最后一个空框被填满可能使玩家直接接触新生成的门面。末地的到达地点是黑曜石出生平台；平台可能嵌在岛内、与地面相接，也可能位于主岛外侧，隔着虚空。初次[末影龙](knowledge:ender-dragon-and-crystals)战斗结束前，主岛中央基岩结构内的[退出门面](knowledge:end-exit-and-recovery#exit-portal)尚未激活；黑曜石出生平台自身没有返回传送功能。

来源：[末地门](https://minecraft.wiki/w/End_portal)、[末地的到达平台与退出规则](https://minecraft.wiki/w/The_End)。
