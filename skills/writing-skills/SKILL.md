---
name: writing-skills
description: 怎么把管用的做法写成技能：触发条件、动作步骤或 JavaScript 代码、恢复类/自动类/调用类的写法和例子
---

# 写技能

技能是你从经历里提出的做法。写在决定的 `skill` 字段里，校验后保存为**候选**。由你选择时机，用 `use_skill {"name":"…","trial":true,"args":{…}}` 试用；旧稳定版保留，普通候选不自动接手；应急自动类候选在符合现有应急调度条件时可能自动试用，仍按同一验收规则积累证据。当前版本至少三次实际验收成功，且成功次数不少于失败的两倍，才按原定模式启用。跳过、无动作自报成功、离线检查均不能代替游戏证据。用 `{"kind":"skill","name":"…","trial":true}` 阅读候选完整契约。

- **只有 body 的纯文字技能是未验证笔记，不是策略证据**：它不会被自动接手；要按它做，先用 `skill` 读，再由你决定。
- 写涉及世界机制、结构生成、地形/群系等**策略类技能**前，先查 `knowledge`；正文写清出处（文档/章节）、适用条件和限制（哪些情况不成立）。没有 `verify` 的策略不能自动触发；一次有限情形的成败不能写成普遍规则。

```
"skill": {"name":"英文小写-连字符","description":"一句话：什么时候、做什么",
          "when":{触发条件}, "steps":[{"skill":"动作","args":{},"if"?:{条件},"optional"?:true}],
          "verify":"只读验收函数体", "priority":1-90, "cooldown_s":20, "overrides"?:["本能名"], "body"?:"目标、输入、允许副作用、停止和验收方式"}
```

## 三种技能
- **恢复类**（when 里有 `after_failure`）：手上某个动作失败时，身体先照这套做，再把失败的那一步重做一遍；还不行才叫你。每段活里同一份技能只试一次。
- **自动类**（when 只有状态条件）：条件一成立身体就去做，像练出来的反射。条件要具体（血量、怪、身边的方块、背包），只写 night/dark 这种太宽的会被拒绝。
- **调用类**（不写 when）：一套常用连招，只在 routine 里 `use_skill {"name":"…"}` 调用。

## 代码技能（code）
固定的几步优先用 `steps`；有界参数程序可以用 `experiment_method` 提出并试验。需要算法时，把 `steps` 换成 `"code":"函数体"`，when / priority / overrides 照旧，保留 JavaScript 自由组合能力。代码在沙箱里运行，每次实际结果、出错行和调用轨迹都会留下；编译检查不是掌握证据。

```
"skill":{"name":"walk-around-water","description":"walk_path 被水挡住时沿岸绕过去",
 "when":{"after_failure":{"skill":"walk_path","code":["PATH_NOT_FOUND","BLOCKED"]}},
 "code":"const me = await api.state(); const reg = await api.region(...); ... return {steps: n};",
 "verify":"const s = await api.state(); const t = args.args.failure?.args?.target; return s.inWater ? '还泡在水里' : true;"}
```

- **steps 和 code 都必须写 verify（判定）**：动作正常返回不等于做成了（“脱船”技能人还在船上也会报“做完了”）。verify 是另一段函数体，做完以后看一眼世界：`args.before` 是开工前的 `api.state()`，`args.result` 是 code 的返回值，`args.args` 是调用参数；只能用 `api.state/blockAt/region/entities/nearestLand`（只看不动）；做成了 `return true`，没做成 `return "原因"`。判定没通过算这次失败，记进成败、交给后台改进。判得要实在：看身体和世界真的变成了该有的样子（出坑核对调用方指定的出口坐标、清背包看那几样少了没有、到地方看是否到达原目标），别只看 code 自己的返回值。**目标要拿调用方给的参数（`args.args`）来核对**，比如要挖到 `args.args.y` 就看 `s.feet.y` 到没到这个数；不要拿 code 自己算出来、塞进返回值的目标来比——代码读错了参数，判定也会跟着一起错，永远发现不了。

- 参数 `api` 和 `args` 已经给好；恢复时 `args.failure = {skill,args,code,summary,target?,position,entityId?}` 是刚失败的那一步（`target` 是动作确认的绝对目标，`position` 是失败时身体的位置）；`use_skill {"name":…,"args":{…}}` 调用时 args 就是那个对象（比如 `args.y`）。调用类技能要在 skill 里写 `"args":{"y":"要挖到的高度"}` 声明参数名和意思：心智调用时会看到，写错名字会被当场提醒。
- `api.state()`（含触觉事实 `feetBlock`/`headBlock`/`bodyPortal`：身体占据格与身体 AABB 压着的门方块，不受视野限制）、`api.blockAt(x,y,z)`、`api.region(x1,y1,z1,x2,y2,z2)`（返回 palette/kinds/data，第 i 格 i = (y-min.y)*sx*sz + (z-min.z)*sx + (x-min.x)，kind = open|solid|liquid|unknown）、`api.entities(r)`、`api.nearestLand()`（最近见过的能站的干地，和身体上岸判断同一个标准；自己判断“哪里是干地”时用它，别另写一套）、`api.stepTo(x,y,z)`、`api.digAt(x,y,z)`、`api.placeAt(x,y,z,item)`、`api.moveTo(x,y,z)`（先 plan_route 再 walk_path，精确到达；不支持 range/sprint/avoid）、`api.act("动作",{参数})`、`api.look(yaw,pitch)`、`api.lookAt(x,y,z)`、`api.sleep(ms)`、`api.log(…)`、`api.progress(p)`；全部要 await。
- 身体的细动作：`api.move({forward,back,left,right,jump,sprint,sneak}, ms≤1000, {face: 实体id或[x,y,z]})`（按住这些键一小会儿、一直盯着目标；前面是岩浆或高崖会自己停下）、`api.attack(id)`（返回距上次挥了多久）、`api.equip(物品, 位置)`、`api.shield(true/false)`、`api.draw("bow")` + `api.release([x,y,z])`、`api.shoot(id)`。`api.state()` 里有 offHand、armor、usingItem、hurtAgoMs、deathDrop；`api.entities(r)` 里有 velocity、height、hp。
- 方块查询只返回当前视觉确认的格子；未看见、遮挡、黑暗或未加载均为 `name:null,kind:"unknown"`，连实心/空气/液体也不能猜。48 格是查询上限，不代表这个范围全都看得见。region 的第 i 格是 `palette[data[i]]` 和 `kinds[data[i]]`，unknown 不代表空气，更不代表没有矿。听到的实体只给粗略方向和距离，没有真实 ID/坐标；精确攻击/射击只接受当前看见的实体。`when` 里的 `hostile` 也会匹配听见的怪——如果你的代码按位置/ID 行动，写 `hostile {... ,"seen":true}` 只触发看得见的，或在代码里对 heard 先转头/举盾再扫。
- 要挖/迈身边的格子，直接用 `digAt`/`stepTo`（它们自己会转头、处理遮挡、如实回报），别先 `blockAt` 预检再因为 `unknown` 就 throw——紧邻格没转头时 `blockAt` 常返回 `unknown`，这只代表还没看清，不代表没法处理。
- region 最多 40000 格；不能 require/import/eval、网络/文件访问或接触 adapter/宿主世界对象；每次唤醒最多 1.5 秒同步计算，总共最多 12000 次 api 调用；做不成就 `throw new Error("原因")`。
- 扫描结果要能解释分支：`region`/`blockAt` 返回 unknown 只代表这次没看清，不代表目标不存在；用扫描结果决定“找到/没找到”前，先 `lookAt`/`api.move` 转向确认，或在没找到时换角度再扫。失败时后台改进器只能看到出错行、最后 30 条 api 轨迹和 `api.log`；关键时刻（扫描到没有、身体占据格是什么、为什么改走另一支）用 `api.log` 记一句，改进器才有依据判断是哪一步的假设错了。
- 恢复用 `args.failure.target` 的绝对坐标；失败动作的 `at/to` 是相对坐标，不能当世界坐标。保留原目标和允许手段，缺材料/接口就报告缺口，不擅自换实体、开采范围或新增探索。原 routeId、挖掘/放置范围、实体 ID 和 `wet/lava/own` 限制在步骤和嵌套调用中继续生效；不能隐式增加挖掘、合成或探索，额外放块要交回心智显式用 `use_skill args.allowPlace:true` 选择。修改 `when/args/verify` 也属于完整版本修订。
- **会自己变好**：代码技能老失败时，会在后台单独请一次模型拿着出错记录修订候选（v2、v3…）；普通候选需心智显式试用，应急自动候选可能按调度条件自动试用；都要积累真实验收证据才启用。相同完整候选契约不增加版本、不重置证据；后台保留待试用或证据不足的候选，当前版程序错误可及时修订，你也可以显式修订。自动回退仅恢复曾启用版本的触发条件、参数、代码与验收完整快照，并分配新版本号；未启用历史版本需用 from_version 选择后再试；选择的若正是当前已收起候选，只恢复该版本的试用权限，保留契约和证据，不直接启用。改进有间隔、不会频繁发生。你也可以写 `{"name":"…","improve":"哪里不好"}` 主动要求改进（同样排队、限频）。

## 条件写法（并列的键都要成立）
- 自己：`hp_below` `food_below` `oxygen_below`（数字），`in_water` `in_lava` `on_ground` `night` `dark`（true/false），`in_wall`（true：头那一格是实心方块——被沙砾埋住或卡进墙里，正在窒息掉血）
- 怪：`hostile` `{"name"?:"skeleton"或["zombie","husk"],"within":16,"fusing"?:true,"seen"?:true}`（`seen:true` 只看看得见的怪；不写则听见的也算）；`no_hostile_within` 数字
- 背包：`has` `"cobblestone"` 或 `{"item":"*_planks","count":4}`（* 通配）；`lacks` `"torch"`
- 正在做：`doing` / `not_doing` 动作名或数组
- 身边的方块：`cell` `{"at":[前,上,右],"is":"air|open|solid|liquid|方块名"}`，可写数组；open = 能穿过（空气、草、雪层）
- 看得见的掉落物：`drops` `{"within":8,"item"?:["beef","*_log"]}`
- 死后的掉落物：`dropped_items` `true` 或 `{"within":格数,"left_above":秒数}`（同一维度里还有没捡回的东西；掉落物 5 分钟后消失）
- 失败：`after_failure` `{"skill"?:["walk_path","mine_cell"],"code"?:["PATH_NOT_FOUND","STUCK"]}`
- 组合：`any` `[条件…]`、`all` `[条件…]`、`not` `{条件}`

步骤里的 `if` 在那一步开工前当场判断，不成立就跳过；坐标 [前,上,右] 按当时站的位置和朝向算。`optional:true` 的步骤没成也不算整套失败。

## 身体本来会什么
当前运行模式不会因为掉进岩浆或水里快没气就强制接管，也不会自行选择躲怪、逃跑或还手；你可以自己决定行动，或从经历中总结自动类、恢复类技能。一开始技能书是空的。

自动类技能按执行结果与 verify 记成败。完成约 12 秒后的事后观测只补充死亡、掉血和触发处境等事实，不自动把后来死亡或掉血归因成技能失败。代码技能老是没用会在后台被改进。代码技能里 `args.trigger` 就是触发时的这些情况；判断这次不用做时 `return {skipped:"原因"}`，不计数。

## 打架、躲闪、捡回东西
身体不会任何打法：什么时候拉开距离、什么时候举盾、绕着走还是后退、近战还是用弓、要不要回去捡死后掉的东西、值不值得冒险，都由你从经历里写成技能（多半是代码技能，用 move / attack / shield / draw 一拍一拍地拼）。几条游戏常识：挥得太勤伤害很低（剑约 0.6 秒、斧约 1 秒才恢复满）；冲刺中挥砍能把怪击退；盾只挡正面、举着时走得慢；弓蓄满约 1 秒，远处要往上抬；苦力怕嘶嘶响约 1.5 秒后爆炸。

## 成败和修改
每次调用记录使用情况；验收成功和实际失败才计入成败，跳过、取消或目标未知不能当成成功（思考里 my_skills 能看到）。自己写的技能用了几次大多失败会被停用，并提醒你：同名再写一次保存修订候选，显式试用通过后才重新启用；`{"name":"…","disable":true}` 停用。

## 例子
被脚边一格高的土坎卡住（恢复类）：
```json
{"name":"hop-over-ledge","description":"走路被一格高的坎挡住时迈上去",
 "when":{"after_failure":{"skill":["walk_path"],"code":["PATH_NOT_FOUND","STUCK"]},"cell":{"at":[1,0,0],"is":"solid"}},
 "steps":[{"skill":"move_step","args":{"at":[1,1,0]},"if":{"cell":[{"at":[1,1,0],"is":"open"},{"at":[1,2,0],"is":"open"}]}}],"verify":"const s = await api.state(); return s.feet.y >= args.before.feet.y + 1 && s.onGround ? true : '没有站上更高的落脚处';","priority":40}
```
血少又被骷髅射（自动类，验收仅确认垫高效果，不证明已脱离威胁）：
```json
{"name":"pillar-from-skeletons","description":"血少又被骷髅盯上时原地垫高三格躲箭",
 "when":{"hp_below":8,"hostile":{"name":"skeleton","within":16},"has":{"item":"cobblestone","count":3},"on_ground":true},
 "steps":[{"skill":"pillar_one","args":{"item":"cobblestone"}},{"skill":"pillar_one","args":{"item":"cobblestone"}},{"skill":"pillar_one","args":{"item":"cobblestone"}}],
 "verify":"const s = await api.state(); return s.feet.y >= args.before.feet.y + 3 && s.onGround ? true : '没有站上三格高的平台';",
 "priority":70,"overrides":["low-hp-flee"]}
```
