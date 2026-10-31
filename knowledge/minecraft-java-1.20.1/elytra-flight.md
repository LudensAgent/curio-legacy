---
id: "elytra-flight"
title: "鞘翅与飞行"
kind: "mechanic"
edition: "java"
versions: ["1.20.1"]
aliases: ["鞘翅", "滑翔", "飞行", "飞行道具", "elytra", "烟花火箭", "firework rocket", "烟花推进", "滑翔推进"]
sources: [{"url":"https://minecraft.wiki/w/Elytra","title":"Minecraft Wiki: Elytra"},{"url":"https://minecraft.wiki/w/Firework_Rocket","title":"Minecraft Wiki: Firework Rocket"},{"url":"https://minecraft.wiki/w/Damage#Fall_damage","title":"Minecraft Wiki: Damage (fall/kinetic)"}]
versionNote: "原版 Java 1.20.1 的鞘翅与烟花火箭机制；数值为近似巡航值，服务端规则或自定义实现可能不同。"
reviewedAt: "2026-10-31"
---

## equip-and-activate | 穿戴与启动滑翔

鞘翅占用胸甲槽（torso），与胸甲互斥。穿戴鞘翅后，在空中（不在地面、不在水中）按下跳跃键会进入滑翔；滑翔一旦开始会一直持续到落地或脱离，不需要持续按住跳跃键。在水中、在乘骑状态或站在地面时无法进入滑翔。[鞘翅](https://minecraft.wiki/w/Elytra)

## glide-dynamics | 滑翔动力学（俯仰、速度与惯性）

滑翔的俯仰控制速度与高度变化：向下看会加速下降，向上看会减速并在短时间内上升，接近平视时以较低速度缓慢下降。滑翔有惯性，速度方向不会瞬间与朝向一致，转弯存在曲率半径，无法原地掉头、倒退或悬停。水平巡航速度上限约 30 格/秒，远高于疾跑；未穿戴鞘翅的坠落终端速度约 78 格/秒。这些速度意味着滑翔时越过区块加载、难以对前方地形做逐格反应。[鞘翅](https://minecraft.wiki/w/Elytra)

## rocket-boost | 烟花火箭推进

滑翔中使用烟花火箭会获得沿朝向的加速，可以爬升或延长航程，每次使用消耗一个烟花火箭。火箭只提供推进，不改变鞘翅必须持续向前、不能悬停的基本约束。[烟花火箭](https://minecraft.wiki/w/Firework_Rocket)

## collision-and-landing | 碰撞伤害与着陆

滑翔高速撞上实心方块会造成与速度相关的动能伤害，可能致命。着陆不能像垂直下落那样原地静止：需要减速进近（抬头拉平），或落在水、黏液块、干草块等减伤表面上，或贴梯子、藤蔓停止。着陆安全与否取决于进近空间和落点，而不只是脚下是否有方块。[伤害](https://minecraft.wiki/w/Damage#Fall_damage)

## chunk-and-perception | 区块加载与前方可见性

滑翔速度接近 30 格/秒，接近或超过区块加载速度，前方地形可能尚未加载、无法确知。飞行辅助通常只能依据已加载区域规划，未知区域需要保守处理（例如爬升到安全高度）。这一限制是程序能力边界，不是世界规则本身。[鞘翅](https://minecraft.wiki/w/Elytra)
