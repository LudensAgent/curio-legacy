---
name: writing-skills
description: 怎么把管用的做法写成技能：触发条件、动作步骤或 JavaScript 代码、恢复类/自动类/调用类的写法和例子
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

## 代码技能（code）
动作步骤写不出来的做法（寻路算法、绕着怪走、按地形挑落脚点……）直接写成 JavaScript：把 `steps` 换成 `"code":"函数体"`，when / priority / overrides 照旧。代码在沙箱里跑，存下就能用，每次运行的结果、出错的行、最后几次 api 调用都会记下来。

```
"skill":{"name":"walk-around-water","description":"goto 被水挡住时沿岸绕过去",
 "when":{"after_failure":{"skill":"goto","code":"PATH_NOT_FOUND"}},
 "code":"const me = await api.state(); const reg = await api.region(...); ... return {steps: n};",
 "verify":"const s = await api.state(); const t = args.args.failure?.args?.target; return s.inWater ? '还泡在水里' : true;"}
```

- **必须写 verify（判定）**：代码跑完不抛错不等于做成了（“脱船”技能人还在船上也会报“做完了”）。verify 是另一段函数体，做完以后看一眼世界：`args.before` 是开工前的 `api.state()`，`args.result` 是 code 的返回值，`args.args` 是调用参数；只能用 `api.state/blockAt/region/entities/nearestLand`（只看不动）；做成了 `return true`，没做成 `return "原因"`。判定没通过算这次失败，记进成败、交给后台改进。判得要实在：看身体和世界真的变成了该有的样子（出坑看头顶见不见天、清背包看那几样少了没有、到地方看离目标多远），别只看 code 自己的返回值。**目标要拿调用方给的参数（`args.args`）来核对**，比如要挖到 `args.args.y` 就看 `s.feet.y` 到没到这个数；不要拿 code 自己算出来、塞进返回值的目标来比——代码读错了参数，判定也会跟着一起错，永远发现不了。

- 参数 `api` 和 `args` 已经给好；恢复时 `args.failure = {skill,args,code,summary}` 是刚失败的那一步（比如 `args.failure.args.target`）；`use_skill {"name":…,"args":{…}}` 调用时 args 就是那个对象（比如 `args.y`）。调用类技能要在 skill 里写 `"args":{"y":"要挖到的高度"}` 声明参数名和意思：心智调用时会看到，写错名字会被当场提醒。
- `api.state()`、`api.blockAt(x,y,z)`、`api.region(x1,y1,z1,x2,y2,z2)`（返回 palette/kinds/data，第 i 格 i = (y-min.y)*sx*sz + (z-min.z)*sx + (x-min.x)，kind = open|solid|liquid|unknown）、`api.entities(r)`、`api.nearestLand()`（最近见过的能站的干地，和身体上岸判断同一个标准；自己判断“哪里是干地”时用它，别另写一套）、`api.stepTo(x,y,z)`、`api.digAt(x,y,z)`、`api.placeAt(x,y,z,item)`、`api.moveTo(x,y,z,range,{sprint})`（默认走路，sprint:true 跑：快但很耗饥饿）、`api.act("动作",{参数})`、`api.look(yaw,pitch)`、`api.lookAt(x,y,z)`、`api.sleep(ms)`、`api.log(…)`、`api.progress(p)`；全部要 await。
- 身体的细动作：`api.move({forward,back,left,right,jump,sprint,sneak}, ms≤1000, {face: 实体id或[x,y,z]})`（按住这些键一小会儿、一直盯着目标；前面是岩浆或高崖会自己停下）、`api.attack(id)`（返回距上次挥了多久）、`api.equip(物品, 位置)`、`api.shield(true/false)`、`api.draw("bow")` + `api.release([x,y,z])`、`api.shoot(id)`。`api.state()` 里有 offHand、armor、usingItem、hurtAgoMs、deathDrop；`api.entities(r)` 里有 velocity、height、hp。
- 只看得到身边 48 格；region 最多 40000 格；不能 require/import/eval；每次唤醒最多 1.5 秒同步计算，总共最多 12000 次 api 调用；做不成就 `throw new Error("原因")`。
- **会自己变好**：代码技能老失败时，会在后台单独请一次模型拿着出错记录改代码，换上新版本（v2、v3…）；新版本更差会自动退回旧版。改进有间隔、不会频繁发生。你也可以写 `{"name":"…","improve":"哪里不好"}` 主动要求改进（同样排队、限频）。

## 条件写法（并列的键都要成立）
- 自己：`hp_below` `food_below` `oxygen_below`（数字），`in_water` `in_lava` `on_ground` `night` `dark`（true/false），`in_wall`（true：头那一格是实心方块——被沙砾埋住或卡进墙里，正在窒息掉血）
- 怪：`hostile` `{"name"?:"skeleton"或["zombie","husk"],"within":16,"fusing"?:true}`；`no_hostile_within` 数字
- 背包：`has` `"cobblestone"` 或 `{"item":"*_planks","count":4}`（* 通配）；`lacks` `"torch"`
- 正在做：`doing` / `not_doing` 动作名或数组
- 身边的方块：`cell` `{"at":[前,上,右],"is":"air|open|solid|liquid|方块名"}`，可写数组；open = 能穿过（空气、草、雪层）
- 看得见的掉落物：`drops` `{"within":8,"item"?:["beef","*_log"]}`
- 死后的掉落物：`dropped_items` `true` 或 `{"within":格数,"left_above":秒数}`（同一维度里还有没捡回的东西；掉落物 5 分钟后消失）
- 失败：`after_failure` `{"skill"?:["goto","explore"],"code"?:["PATH_NOT_FOUND","STUCK"]}`
- 组合：`any` `[条件…]`、`all` `[条件…]`、`not` `{条件}`

步骤里的 `if` 在那一步开工前当场判断，不成立就跳过；坐标 [前,上,右] 按当时站的位置和朝向算。`optional:true` 的步骤没成也不算整套失败。

## 身体本来会什么
身体只有两条保命底线：掉进岩浆往外跑、水里快没气上浮。除此之外身体不会自己躲怪、逃跑、还手或脱困——这些反应都要你从经历里总结成技能（自动类或恢复类）。一开始技能书是空的，第一次被僵尸追、第一次卡在坑里，都是写技能的时候。

自动类技能的成败看结果：触发后 12 秒内死了、或又掉了 6 点以上的血就记一次没用（记录里带着触发时的血量、周围的怪、是否在坑里、当时在做什么）。代码技能老是没用会在后台被改进。代码技能里 `args.trigger` 就是触发时的这些情况；判断这次不用做时 `return {skipped:"原因"}`，不计数。

## 打架、躲闪、捡回东西
身体不会任何打法：什么时候拉开距离、什么时候举盾、绕着走还是后退、近战还是用弓、要不要回去捡死后掉的东西、值不值得冒险，都由你从经历里写成技能（多半是代码技能，用 move / attack / shield / draw 一拍一拍地拼）。几条游戏常识：挥得太勤伤害很低（剑约 0.6 秒、斧约 1 秒才恢复满）；冲刺中挥砍能把怪击退；盾只挡正面、举着时走得慢；弓蓄满约 1 秒，远处要往上抬；苦力怕嘶嘶响约 1.5 秒后爆炸。

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
