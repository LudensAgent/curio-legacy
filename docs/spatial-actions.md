# 空间查询动作（spatial_query）

`spatial_query` 是已注册的只读动作，用来读取共享空间记忆里**已经记录**的事实。它不观察、不转头、不移动、不写入、不刷新证据时间，也不把历史记录改写成当前世界状态。

查询返回的是「最近一次记录」或「历史几何」。它不代表当前世界、当前可通行性、当前可执行点列或在线观察：
- `cells` 的 `availability` / `effectiveFreshness` 由原证据与本次评估时间派生；原 `evidence` 的时间、会话、来源、修订保持原样。
- `fragment` / `fragments` 的 `polyline`、`entrances`、`links` 是历史几何；`geometrySource` 只描述来源分类，不保证当前可通行。
- `traversals`、`nodes`、`route` 是历史证据。`route` 的 `FOUND` 只表示已记录的连接证据，不是当前可达。
- 片段索引（`fragments`）与按 `fragmentId` 的 traversal 分页会扫描当前库的完整索引后再过滤、排序、取页；`limit` 只限制本页返回条数，不是每页扫描量或 O(page)。输出超过 64 KiB 时返回结构化的 `result_too_large`，不截断证据。

## 可用形状

- `{"kind":"cells","dim":"overworld","positions":[{"x":0,"y":64,"z":0}]}`：1–32 个安全整数坐标；返回原坐标、section、驻留状态与历史 CellEvidence。
- `{"kind":"fragment","dim":"overworld","fragmentId":"id","field":"polyline|entrances|links","offset":0,"limit":16}`：单片段某字段分页；`limit` 1–32，超出拒绝而不是 clamp。
- `{"kind":"traversals","dim":"overworld","ids":["t1"]}`：1–8 个明确 traversal ID，按原顺序逐个查询。
- `{"kind":"traversals","dim":"overworld","fragmentId":"id","after":"cursor","limit":4}`：按片段分页，`limit` 1–8。
- `{"kind":"nodes","dim":"overworld","ids":["n1"]}`：1–8 个明确 node ID，保留 agent/program 来源。
- `{"kind":"route","dim":"overworld","fromNodeId":"n1","toNodeId":"n2","mode":"walk","maxNodes":32,"maxEdges":128,"maxHistoryReads":64,"maxDiagnostics":8}`：历史路线；缺省预算 32/128/64/8，显式上限 64/512/256/16，零值按原值传递。
- `{"kind":"fragments","dim":"overworld","after":"cursor","limit":4}`：按维度分页的片段索引，只返回元数据与点数/首末点。

`dim` 必须显式给出具体维度，不能是 `unknown`。所有 ID 长度、数量、分页和预算都有上限；超出时直接拒绝。

## 执行语义

- 作为独立的 Arbiter 任务（如 `spatial_query` 直接调度）时，它仍遵循普通任务的抢占、取消与 `stopAll` 调度，不创建并发的只读通道。
- 通过 `use_skill` / 代码里的 `api.act("spatial_query", …)` 调用时，使用现有技能校验与执行链路，并沿用同一 `ctx.spatial`、取消信号、`taskId` 与父期限。
- 查询成功只表示读取完成，不表示身体或世界发生了改变。纯查询的代码、步骤与组合技能保留查询返回数据，但记为 `noop`，不进入物理成功/失败或候选晋升证据。
- 本次集成不新增导航动作；导航相关能力仍等待后续阶段，本文不声称它们已经可用或已合并到主线。
