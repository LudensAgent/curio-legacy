---
id: "portals-and-dimensions"
title: "传送门、维度与重生规则"
kind: "mechanic"
edition: "java"
versions: ["1.20.1"]
aliases: ["下界", "地狱", "末地", "传送门", "地狱门", "重生锚", "nether_portal", "end_portal", "obsidian", "crying_obsidian", "eye_of_ender", "respawn_anchor"]
sources: [{"url":"https://minecraft.wiki/w/Nether_Portal","title":"Minecraft Wiki: Nether Portal"},{"url":"https://minecraft.wiki/w/Crying_obsidian","title":"Minecraft Wiki: Crying Obsidian"},{"url":"https://minecraft.wiki/w/End_portal","title":"Minecraft Wiki: End portal"},{"url":"https://minecraft.wiki/w/Eye_of_ender","title":"Minecraft Wiki: Eye of Ender"},{"url":"https://minecraft.wiki/w/Bed","title":"Minecraft Wiki: Bed"},{"url":"https://minecraft.wiki/w/Respawn_anchor","title":"Minecraft Wiki: Respawn Anchor"},{"url":"https://www.minecraft.net/en-us/article/spawning-and-dying","title":"Minecraft: Spawning and dying in Minecraft"}]
versionNote: "适用于原版 Java 1.20.1；不采用后续版本新增的传送等待时间游戏规则，也不推定自定义维度行为。"
reviewedAt: "2026-10-28"
---

## nether-portals | 下界门的结构与连接

下界门连接主世界和下界，由竖直的黑曜石矩形框构成，外框至少宽四格、高五格，最大二十三乘二十三格；四个角可省略。哭泣的黑曜石不能替代框架中的普通黑曜石，框内出现火焰可激活有效框架。主世界与下界之间的水平坐标比例为八比一，只有横向两个坐标缩放，高度不缩放。传送时游戏会查找附近已有门，找不到才生成出口；高度和已有门的位置会影响连接。因此比例换算只能说明对应区域，不能单凭计算断定实际出口，也不能保证来回连接同一扇门。

来源：[下界门](https://minecraft.wiki/w/Nether_Portal)、[哭泣的黑曜石](https://minecraft.wiki/w/Crying_obsidian)。

## end-portals | 末地门与末影之眼

生存模式中的末地门需要利用要塞内既有的传送门框架；门框不能像普通建筑材料一样自然取得并搭建。完整门环有十二个门框，生成时可能已有部分嵌入末影之眼。每个空框都装入眼后，环内形成传送门；已经嵌入的眼不能取回。末影之眼还可抛出，用于指示要塞方向，但一次飞行给的是线索，并不直接展示入口、门房或可通行路线。末地门与下界门使用不同规则，黑曜石框和点火不能替代要塞中的末地门结构。

来源：[末地门](https://minecraft.wiki/w/End_portal)、[末影之眼](https://minecraft.wiki/w/Eye_of_ender)。

## respawning | 床、重生锚与维度差异

在原版 Java 1.20.1 中，床可用于主世界睡眠和设置重生点；尝试在下界或末地用床睡眠会引发爆炸，而非进入睡眠。重生锚提供下界重生点，用萤石块而非萤石粉充能，最多保存四次充能；设置重生点需要至少一次充能，每次在锚旁重生消耗一次。已充能的锚在主世界或末地被用于设置重生点也会爆炸。重生锚被拆除、耗尽或缺少有效重生空间时，旧重生安排可能失效。

来源：[床](https://minecraft.wiki/w/Bed)、[重生锚](https://minecraft.wiki/w/Respawn_anchor)、[Mojang 的重生说明](https://www.minecraft.net/en-us/article/spawning-and-dying)。
