# 空间动作（walk_to、walk_known_route、spatial_query）

本文记录三个已注册动作：`walk_to`、`walk_known_route` 与只读的 `spatial_query`。它们都使用宿主提供的同一个 `SharedSpatialSession`；代码技能、学习步骤、组合技能与独立 Arbiter 任务沿用各自的现有校验、调度、取消与期限链路。旧的手动记忆、旧 manual/journal producer 不由这次注册启用。

## walk_to

按本次实测脚位做一次显式有界步行搜索，并把候选交给现有步行执行后端。

```json
{"to":[x,y,z],"arrival":{"kind":"exact"},"deadlineMs":1720000000000}
{"to":[x,y,z],"arrival":{"kind":"near","radius":1.5},"deadlineMs":1720000000000}
```

- `to` 是本次动作的绝对世界坐标，保留小数与负数，不取整、不投影；坐标必须是 ±30000000 内的有限数字。
- `arrival` 必须显式给出：`exact` 或 `near`（半径为正的有限数字，零/负数/非有限值直接拒绝）。
- `deadlineMs` 是可选的**绝对 epoch 毫秒**，不是相对时长。有效期限为 `min(args.deadlineMs ?? ctx.deadline, ctx.deadline)`：子请求只能缩短父期限，不能延长；缺失时不凭空造一个已过去的时间预算。
- 能力限制是明确的：只支持干燥、普通整块、同高、沿整数 X/Z 相邻格的路线；`exact` 目标必须落在当前脚位的整数 XZ 格上（沿用既有 grounded 物理容差）。不支持的目标会报告 `UNSUPPORTED` 或证据不足，不等同于“世界无路”，也不会自动改道、跳跃、游泳、挖掘或放置。
- 搜索前只做固定且合法的局部观察：以当前身体脚格为中心、水平半径 4（9×9×4 格：支撑/脚/头/净空），至多 12 次真实转头观察；范围不随目标或搜索前沿扩张，转头观察不使用任何物品。执行阶段仍只观察移动中的 3×3×4 邻域。
- `FOUND` 只表示找到候选，不是到达。只有真实身体在实测位置满足原完成条件后才返回 `ARRIVED`。`near` 会按原 `to` 与原半径复核完整 XYZ 距离。
- 零边候选（起点已满足原完成条件）只用有界真实物理帧按既有 grounded 稳定窗口确认；成功时 `data.zeroEdge:true`、`data.noop:true`、`nav.trace:[]`，不产生移动、fragment 或 traversal。`noop` 仍表示原完成条件成立，但不计入身体效果。

## walk_known_route

按 `fragmentId` 读取共享空间历史中的一条已存路线，在当前世界中重新验证后执行。

```json
{"fragmentId":"历史片段ID","deadlineMs":1720000000000}
```

- `fragmentId` 必须是非空字符串；`deadlineMs` 语义与 `walk_to` 相同（绝对 epoch，只能缩短父期限）。
- 历史几何只是**选定的路线来源**，不证明当前可通行、不证明由本 Agent 走过。每段都按当前合法观测重新判定 `OPEN`；实际位置由物理样本与既有 grounded 稳定窗口确认。
- 出发时身体必须与路线首点匹配（沿用既有容差）。太远、支撑不符或偏差超限时按真实执行失败处理；不自动连接首点、不传送、不改写起点。`STARTED` 只表示执行已启动，不是到达。
- 与 `walk_to` 相同的移动限制：同高、沿 X/Z 单轴相邻一格、2~32 点、普通干燥整块；不含搜索、挖掘、放置、跳跃、游泳或旧 `moveTo` 兜底。准备阶段对选定点做有限转头观察（至多 12 次真实 look），移动中只观察身体周边 3×3×4 格。

## 结果与历史

两个导航动作都保留原请求与结果信封；调用方应区分这些字段：

- `originalRequest`：原动作参数（含原绝对目标/arrival/fragmentId/绝对期限）。
- `target`：原动作的绝对目标；`walk_known_route` 的终点来自选定历史几何末点（失败记录另带 target 时原样保留）。
- `search` / `candidate` / `stage`：`walk_to` 的搜索证据与终态；候选不是到达。
- `nav`：执行后端的真实 `NavResult`；`ARRIVED` 需要 `confirmed:true` 与实测位置。`trace` 为空或 `STARTED` 都不能单独证明到达。
- `knownStart`：`walk_known_route` 的公开启动结果；`REJECTED` 原样保留原因。
- `position`：只投影实际 `nav.lastPosition`，不重读当前状态补造。
- `history` / `historyFailure`：本次真实执行的内存写入结果与精确失败阶段。

已确认步行历史的写法保持明确分工：

- fragment 的 `polyline` 是**原请求点列的已确认前缀**（nominal confirmed corridor），不是实测轨迹；不取整、不插值、不拼接。
- 每段 TraversalEvidence 的 `from` 来自库实际发出的 `ExecutableMove.from`，`to` 与 `observedAt` 来自对应确认的 `nav.trace` 点；`executionId`/`actionId` 保留实际值。
- 内存写入成功只表示 `accepted_pending_checkpoint`，**不等于**已落盘 `saved`；落盘状态由宿主既有 checkpoint 确认。

## spatial_query

只读查询共享空间记忆的契约端口（契约 §5）。返回 `SpatialQueryResult` 信封：`status`、`contract`、`worldId`、`dim`、`sessionId`、`computedAt`、`readOnly:true`、`executable:false`、`data`、`problem`、`total`、`nextAfter`。

支持 15 种 kind：`cells`、`fragments`、`traversals`、`nodes`、`edges`、`historyRoute`、`anchor`、`components`、`segments`、`portals`、`resourceAnchors`、`containerAnchors`、`containerContents`、`snapshot`、`capabilities`。

```json
{"kind":"cells","dim":"overworld","positions":[{"x":0,"y":64,"z":0}]}
{"kind":"fragments","dim":"overworld","fragmentKind":"walked","geometrySource":"traversal","after":"cursor","limit":100}
{"kind":"traversals","dim":"overworld","fragmentId":"id","after":"cursor","limit":100}
{"kind":"nodes","dim":"overworld","tag":"base","label":"home","source":"agent","after":"cursor","limit":100}
{"kind":"edges","dim":"overworld","from":"n1","to":"n2","type":"HORIZONTAL","basis":"traversed","after":"cursor","limit":100}
{"kind":"historyRoute","dim":"overworld","from":{"x":0,"y":64,"z":0},"to":{"x":10,"y":64,"z":0},"near":5}
{"kind":"anchor","dim":"overworld","here":{"x":0,"y":64,"z":0},"order":"surface","near":6}
{"kind":"components","dim":"overworld"}
{"kind":"segments","fragmentId":"id"}
{"kind":"portals","after":"cursor","limit":100}
{"kind":"resourceAnchors","dim":"overworld","tag":"resource","label":"iron","after":"cursor","limit":100}
{"kind":"containerAnchors","dim":"overworld","after":"cursor","limit":100}
{"kind":"containerContents","dim":"overworld"}
{"kind":"snapshot"}
{"kind":"capabilities"}
```

- 请求字段、枚举、未知字段与上限都由库 validator 校验：列表默认 `limit=100`、最大 `1000`，`cells` 最多 4096 个整数坐标；越界值返回 `status:"invalid_request"`（技能映射 `BAD_ARGS`），不 clamp。
- 已移除的旧 kind 失败关闭：`fragment` 改用 `fragments`（完整几何在返回条目的 `polyline`），`route` 改用 `historyRoute` 或 `nodes`/`edges`，`traversals`/`nodes` 的 `ids` 模式改用过滤条件 + `after`/`limit`；`field`/`offset` 不再接受。
- `containerContents` 固定 `status:"unsupported"` + `problem.kind:"host_ledger"`，无 `data`，不会用 `items:[]` 冒充空箱；本宿主未配置容器分类器，`containerAnchors` 固定 `unsupported`。
- `capabilities` 的库报告原样在信封 `data.capabilities`；信封顶层另加 `hostComposed`（与 `status`/`contract` 同级，`owner:"host_composed"`）列出宿主真实接线。两者键组对齐但形状独立，不互相冒充。
- 历史几何、观测证据与分段都不代表当前可通行或可执行；`historyRoute` 固定 `historicalGeometry:true`、`executable:false`、`currentPassability:"UNKNOWN"`；`snapshot` 只是只读计数/版本/能力。
- 查询本身是只读的：不观察、不移动、不加载 Section、不写入、不刷新证据时间、不 pin/保存。作为独立 Arbiter 任务时，仍遵循普通任务的抢占、取消与 `stopAll` 调度，不创建并发的只读通道。响应超过 64 KiB 时返回结构化 `result_too_large`，不截断证据。
- 通过 `use_skill` / 代码里的 `api.act("spatial_query", …)` 调用时，沿用现有技能校验与执行链路，并共享同一 `ctx.spatial`、取消信号、`taskId` 与父期限。

### 查询记账

- **成功的纯查询**记为 `noop`：保留查询返回数据，但不贡献物理成功/失败证据，也不进入候选晋升证据。
- **查询失败**仍走现有失败记账路径；本文不新增“只读失败”分类，也不改写 BehaviorEngine 的统计规则。

## 说明范围

以上是离线实现与测试可确认的能力边界。本文不声称完成游戏内实机导航验收，不把搜索 `FOUND`、历史读取成功或执行启动 `STARTED` 当作到达，也不启用旧记忆/手动/journal producer。
