---
name: writing-skills
description: 怎么把管用的做法写成技能：触发条件、步骤、恢复类/自动类/调用类的写法和例子
---

# 写技能

技能是你自己从经历里总结出的做法。写在决定的 `skill` 字段里，校验通过就存进技能书，**这一刻起身体就会用**，不用等重启、也不用等下次回想。

```
"skill": {"name":"英文小写-连字符","description":"一句话：什么时候、做什么",
          "when":{触发条件}, "steps":[{"skill":"动作","args":{},"if"?:{条件},"optional"?:true}],
          "priority":1-90, "cooldown_s":20, "overrides"?:["本能名"], "body"?:"几行说明"}
```

## 三种技能
- **恢复类**（when 里有 `after_failure`）：手上某个动作失败时，身体先照这套做，再把失败的那一步重做一遍；还不行才叫你。每段活里同一份技能只试一次。
- **自动类**（when 只有状态条件）：条件一成立身体就去做，像练出来的反射。条件要具体（血量、怪、身边的方块、背包），只写 night/dark 这种太宽的会被拒绝。
- **调用类**（不写 when）：一套常用连招，只在 routine 里 `use_skill {"name":"…"}` 调用。

## 条件写法（并列的键都要成立）
- 自己：`hp_below` `food_below` `oxygen_below`（数字），`in_water` `in_lava` `on_ground` `night` `dark`（true/false）
- 怪：`hostile` `{"name"?:"skeleton"或["zombie","husk"],"within":16,"fusing"?:true}`；`no_hostile_within` 数字
- 背包：`has` `"cobblestone"` 或 `{"item":"*_planks","count":4}`（* 通配）；`lacks` `"torch"`
- 正在做：`doing` / `not_doing` 动作名或数组
- 身边的方块：`cell` `{"at":[前,上,右],"is":"air|open|solid|liquid|方块名"}`，可写数组；open = 能穿过（空气、草、雪层）
- 失败：`after_failure` `{"skill"?:["goto","explore"],"code"?:["PATH_NOT_FOUND","STUCK"]}`
- 组合：`any` `[条件…]`、`all` `[条件…]`、`not` `{条件}`

步骤里的 `if` 在那一步开工前当场判断，不成立就跳过；坐标 [前,上,右] 按当时站的位置和朝向算。`optional:true` 的步骤没成也不算整套失败。

## 本能
身体天生的反应：lava（掉岩浆往外跑）、drowning（快淹死上浮）是保命底线，不能换；creeper、losing-fight、low-hp-flee、fight-back、night-shelter、eat、torch 可以用 `overrides` 换成你的做法——你的技能 when 成立时，那条本能就不出手。

## 成败和修改
每次用完都会记成败（思考里 my_skills 能看到）。自己写的技能用了几次大多失败会被停用，并提醒你：同名再写一次就是修订、重新启用；`{"name":"…","disable":true}` 停用。

## 例子
被脚边一格高的土坎卡住（恢复类）：
```json
{"name":"hop-over-ledge","description":"走路被一格高的坎挡住时迈上去",
 "when":{"after_failure":{"skill":["goto","explore"],"code":["PATH_NOT_FOUND","STUCK"]},"cell":{"at":[1,0,0],"is":"solid"}},
 "steps":[{"skill":"step","args":{"to":[1,1,0]},"if":{"cell":[{"at":[1,1,0],"is":"open"},{"at":[1,2,0],"is":"open"}]}}],"priority":40}
```
夜里血少又被骷髅射（自动类，代替逃跑本能）：
```json
{"name":"pillar-from-skeletons","description":"血少又被骷髅盯上时原地垫高三格躲箭",
 "when":{"hp_below":8,"hostile":{"name":"skeleton","within":16},"has":{"item":"cobblestone","count":3},"on_ground":true},
 "steps":[{"skill":"place_at","args":{"at":[0,0,0],"item":"cobblestone"}},{"skill":"place_at","args":{"at":[0,0,0],"item":"cobblestone"}},{"skill":"place_at","args":{"at":[0,0,0],"item":"cobblestone"}}],
 "priority":70,"overrides":["low-hp-flee"]}
```
