---
id: "beds-and-sleep"
title: "床、睡眠与重生点"
kind: "mechanic"
edition: "java"
versions: ["1.20.1"]
aliases: ["床", "睡觉", "睡眠", "过夜", "重生点", "白天", "雷暴", "bed", "sleep", "respawn"]
sources: [{"url":"https://minecraft.wiki/w/Bed","title":"Minecraft Wiki: Bed"},{"url":"https://minecraft.wiki/w/Respawn","title":"Minecraft Wiki: World spawn / Individual spawn"},{"url":"https://minecraft.wiki/w/Tutorial%3ASmelting","title":"Minecraft Wiki: Tutorial:Smelting"},{"url":"https://www.minecraft.net/en-us/article/nightmares-nether","title":"Minecraft.net: Nightmares in the Nether"}]
versionNote: "仅讨论 Java 1.20.1 原版床；不采用当前 Wiki 的后续游戏规则名称、维度环境属性或新增床变体。睡眠时间不使用当前页面的精确刻数。未取得来源修订号。"
reviewedAt: "2026-10-28"
---

## sleep-conditions | 什么情况下能睡

原版主世界的床可在夜间或雷暴时用于睡眠。普通白天无法入睡；床太远、被占用或附近有阻止睡眠的怪物，也会让尝试失败。墙能挡住怪物，不一定能解除游戏对附近怪物的睡眠检查。下界与末地可以放置床，但尝试睡眠会爆炸。[床的条件](https://minecraft.wiki/w/Bed)、[下界的床](https://www.minecraft.net/en-us/article/nightmares-nether)。

## respawn | 设置重生点与保留可用空间

在主世界与床交互可以设置个人重生位置，白天也可以设置，未必需要真正睡过去。重生时仍会检查床是否存在、附近是否有可用的出现位置；搬走床或封死周围空间可能让床的重生失效，回到世界出生点。背包中的床不会自动设置个人重生点。[个人重生](https://minecraft.wiki/w/Respawn)。

## time-and-limits | 跳过夜晚不等于完成所有等待

睡眠成功可跳过夜晚，多人服务器还受需要睡眠的玩家比例等规则影响；有人躺下并不保证立刻天亮。睡眠不是把整段夜晚逐刻模拟：熔炉不会因此补算整夜的冶炼，作物也不会因时间直接跳到早晨就自动成熟。床也不负责提供饥饿恢复或替代通常的生命恢复条件。[床的作用](https://minecraft.wiki/w/Bed)、[冶炼等待](https://minecraft.wiki/w/Tutorial%3ASmelting)。
