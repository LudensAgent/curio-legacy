# 按需回忆与 Hindsight 接入

更新日期：2026-10-23。目标是让 Agent 根据眼前线索想起相关经历，而不是把全部历史塞进每次规划。Hindsight 负责长期经历的整理与召回；当前感知、LLM 自主选择、Executive、Arbiter 和技能仍由本项目负责。

这是一种对人类记忆特征的工程近似：经历被压缩整理，回忆受线索影响，推断可以出错。它不等于复现人类大脑，也不自动带来好奇心、审美或自我意识。

## 当前接入范围

- 本地世界状态继续保存基地、箱子、近期状态等结构化记录。新经历先持久化到本地，再在后台写入 Hindsight；服务失败时保留本地记录并退回本地召回。
- 每次规划只获得预算内的相关回忆。模型还可以输出 `{"kind":"recall","query":"要回想的问题"}`，追问自己想了解的过去；轮数与总提示词长度由规划器限制。
- 回忆携带来源和时间，观察经历与模型推断分开。旧箱子库存、资源位置、失败教训均是历史参考，涉及当前世界的动作仍需要重新观察与验证。
- 长期记忆按世界、角色隔离，召回还限定当前维度。更换兴趣、重新设计住宅、决定是否远征仍由 LLM 权衡，记忆系统不指定通关顺序。

当前没有把所有旧日志自动上传到外部服务，也没有将每个 tick 都写入长期记忆。Hindsight 服务端的抽取、整理可能调用所配置的 LLM；使用远程 LLM 时，被选中的游戏经历会发送到该提供方。embedding 与重排在本 compose 中使用本地多语模型。

## 启动服务

需要 Docker Desktop 的 Linux 容器引擎可用。Hindsight 默认复用项目 `.env` 中现有的 `LLM_BASE_URL`、`LLM_MODEL` 和 `LLM_API_KEY`，无需重复填写模型配置。先确认它们指向可用的模型服务，再添加以下记忆配置；不要将 `.env` 提交到 Git。

```dotenv
MEMORY_PROVIDER=hindsight
MEMORY_WORLD_ID=my-survival-world-01
HINDSIGHT_URL=http://127.0.0.1:8888
HINDSIGHT_API_KEY=
```

非空的 `HINDSIGHT_API_LLM_BASE_URL`、`HINDSIGHT_API_LLM_MODEL`、`HINDSIGHT_API_LLM_API_KEY` 可以分别覆盖对应的 `LLM_*` 值；未设置或为空时自动复用。项目把 `LLM_PROVIDER=deepseek/ollama/...` 当作显示名，实际均走 OpenAI 兼容接口，因此 Hindsight 的 provider 默认固定为 `openai`，不直接复制该标签。这里的 `openai` 表示 OpenAI 兼容 Chat Completions 协议。若使用服务端原生提供方，可显式设置 `HINDSIGHT_API_LLM_PROVIDER` 和配套参数。`LLM_PROVIDER=mock` 不会为 Hindsight 提供一个模拟模型；启用 Hindsight 仍需实际可用的模型配置。

Docker 内访问宿主机上的模型服务时，在 `.env` 设置 `HINDSIGHT_API_LLM_BASE_URL=http://host.docker.internal:11434/v1` 等容器可达地址；Agent 可继续使用原来的 `LLM_BASE_URL=http://127.0.0.1:11434/v1`。容器中的 `127.0.0.1` 指向容器自身。

`HINDSIGHT_API_KEY` 是 Agent 访问记忆服务的凭证，`HINDSIGHT_API_LLM_API_KEY` 是记忆服务访问模型的凭证，两者用途不同。示例 compose 仅向本机开放端口，不启用服务访问认证，前者保持为空；连接已有认证服务时才填写前者。变量定义见 [Hindsight 官方配置](https://hindsight.vectorize.io/developer/configuration)。

```powershell
npm run memory:serve
npm run check:memory
npm start
```

`memory:serve` 等价于 `docker compose -f compose.memory.yaml up -d`，启动 API 与管理界面。镜像和 SDK 均固定为 1.1.0，镜像 tag 已由 [官方 GHCR 包页面](https://github.com/vectorize-io/hindsight/pkgs/container/hindsight) 确认。首次使用会拉取较大的完整镜像，并可能下载额外模型，初始化需要等待。

API 地址为 `http://127.0.0.1:8888`，管理界面为 [本机 Hindsight 管理页](http://127.0.0.1:9999)。`check:memory` 只读检查服务版本与数据库就绪状态，不创建 bank，不上传或搜索游戏经历；成功不代表抽取 LLM 或召回质量已经验证。

停止服务但保留内容：

```powershell
docker compose -f compose.memory.yaml down
```

## 世界隔离与预算

| 配置 | 默认值 | 用途 |
|---|---|---|
| `MEMORY_PROVIDER` | `local` | `hindsight` 启用外部记忆服务 |
| `MEMORY_WORLD_ID` | `MC_HOST:MC_PORT` | 稳定的游戏存档身份；同一地址换存档时必须更换 |
| `BOT_USERNAME` | `Curio` | 与世界身份共同生成专属 bank ID |
| `MEMORY_TIMEOUT_MS` | `1500` | 召回超时，失败后使用本地记忆 |
| `MEMORY_RETAIN_TIMEOUT_MS` | `60000` | 后台写入等待上限 |
| `MEMORY_CONTEXT_MAX_BYTES` | `6000` | 回忆上下文的 UTF-8 字节上限 |
| `LLM_MAX_RECALL_ROUNDS` | `2` | 一次规划中模型主动回忆的最大轮数 |
| `LLM_MAX_PROMPT_TOKENS` | `24000` | 包含回忆与重试的总提示词保守预算 |

bank ID 根据世界 ID 和角色名计算，无需手填共享 bank。改名、换服务器、换存档之前要明确这些身份：同一角色在同一存档恢复游玩应继续使用原值；新存档应换一个新的 `MEMORY_WORLD_ID`。服务端 bank 的隔离不取代本地项目、世界状态的备份和身份管理。

## 中文召回

compose 默认采用官方多语方案中较轻的 embedding 与 reranker，可通过 `HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL` 和 `HINDSIGHT_API_RERANKER_LOCAL_MODEL` 覆盖。Hindsight 的默认英文模型不适合直接作为中文经历的搜索质量保证；更高质量可考虑 BGE-M3 与 BGE reranker v2 M3，并据硬件与样本评估。

本 compose 使用嵌入式 PostgreSQL，默认文本搜索对中文分词能力有限。需要更好的中文关键词搜索时，可后续部署带 PGroonga 或 pg_search 的外置 PostgreSQL；不要直接在当前嵌入式数据库上启用缺失的扩展。具体方案见 [官方多语指南](https://hindsight.vectorize.io/1.0/developer/multilingual)。切换 embedding 模型后必须重新构建既有向量，不能只因维度相同就混用新旧向量，见 [官方 embedding 配置](https://hindsight.vectorize.io/developer/configuration)。

## 完全清空

先用 Ctrl+C 退出 Agent；Hindsight 服务此时需要保持可用，以便删除和核验远端记忆。然后运行：

```powershell
npm run memory:clear
```

命令先删除当前配置的专属 bank（即使本地登记已遗失），以及此 `DATA_DIR` 登记、位于同一服务端点的其他本项目 bank，并确认删除成功，再清空本地 `DATA_DIR` 中的世界记忆、经历、自学技能、历史日志和备份。`DATA_DIR` 根目录保留为空，避免 Windows 在终端或监控工具占用目录本身时返回 `EPERM`。子项删除支持短暂占用重试；持续文件锁或权限错误会报告失败，不会跳过文件后宣称成功。

清理前会探测配置中的 Agent 控制台端口；监听中的 Agent 会阻止清理。仍需先退出所有使用该目录的 Agent，并等待在途记忆写入结束，防止服务端正在处理的请求在删除后重新写回。远端无法删除或核验时报告失败，保留本地数据，以便重试。它不会枚举删除服务上其他应用的 bank。若当前切回了 `MEMORY_PROVIDER=local` 且本地登记已丢失，可显式执行 `npm run memory:clear -- --hindsight`，额外清理当前世界、角色对应的 Hindsight bank。

### 完整重置测试世界

先退出 Agent 并停止 Minecraft 服务器，保持 Hindsight 服务可用。先预览，再执行：

```powershell
npm run memory:reset -- --dry-run
npm run memory:reset
# 等价于 npm run memory:clear -- --full
```

完整模式先校验路径、存档配置及服务器端口，再清理并核验 Hindsight、本地记忆，最后清理项目 `world/` 服务器目录内的运行数据。任何远端清理失败都不会修改世界或种子。`--dry-run` 只读取本地信息，不连接服务、不删除文件、不改配置。

- 保留 `eula.txt`、`server.properties`、管理员/白名单/封禁配置、`config/`、`mods/`、插件配置，以及服务器 jar、启动脚本、Fabric/版本运行依赖等启动组件。
- 删除实际地图目录、玩家进度、日志、录像、用户缓存等其余运行数据；主世界、下界、末地都随地图存档一起清空。
- 清除 `server.properties` 中全部 `level-seed` 配置，保留其余参数。下次服务器启动会创建新地图并随机选择种子；随机抽样不承诺种子绝不重复。

清理不启动新服务器，不自动终止进程；监听中的 Minecraft 服务器会阻止完整重置。若种子还受 mod 或插件自身的配置控制，应同时检查该配置，因为这些配置会按要求保留。

Docker 的数据库位于 named volume，模型缓存也单独持久化，不在 `DATA_DIR` 内，避免在 PostgreSQL 运行时直接删除数据库文件。清空删除的是本项目登记的远端内容；数据库 volume 中可以保留空数据库与其他 bank，模型缓存不包含玩家历史。不要把 `down -v` 当成普通清空命令，它会删除该 compose 数据库内的全部 bank。

曾使用多个服务 URL 时，命令先清理当前 `HINDSIGHT_URL` 对应的登记，保留其余地址的登记与本地历史，并报告需要切换地址后重试；不会把当前 API key 发往旧服务。切换后继续执行，直到所有登记均清理才删除本地数据。如果曾手动删除登记或改过 `DATA_DIR`，命令无法发现遗失的旧记录，需到对应服务的管理页核查和删除。自行配置的数据库备份、快照、服务访问日志，以及模型提供方可能保留的数据，也不在本项目命令的控制范围内。

## 框架注入接口

`src/memory/types.ts` 的 `MemoryRecall` 是规划器依赖的唯一回忆协议。`EpisodicMemory` 接收配置、本地 `WorldMemory`、`EventBus`、当前状态读取函数、数据目录，以及可选的 `HindsightBackend`，不接管动作或目标选择：

```ts
const backend = config.memory.provider === 'hindsight'
  ? new HindsightBackend(config.memory) : undefined;
const episodic = new EpisodicMemory(config.memory, memory, bus,
  () => adapter.state(), config.dataDir, backend);
episodic.start();
// 规划前或模型主动追问时：上下文仅需 percept / lastFailure / userSuggestion。
const recalled = await episodic.recall(planContext, optionalQuery);
// 将 recalled 的历史线索序列化给模型，不将其解释为当前已验证的世界事实。
// 退出前同步调用，取消网络请求并保留待写队列。
episodic.stop();
```

规划器只依赖 `MemoryRecall`，可在测试中注入替身。`recall()` 返回 `{source,query,memories}`，每条记忆含 `id/text/source/observedAt/kind`。自动检索与主动检索共享超时、退避和最终 JSON 字节预算；`snapshot()` 仅返回运行状态、归档数、待写数与脱敏错误。适配器的世界 ID 应统一使用 `config.memory.worldId`；不可把连接地址当成用户自定义存档 ID。旧版无世界身份的空间记录只作为待复核线索，不能迁移为新世界坐标。

## 验证与后续

离线测试可检查召回范围、上下文预算、服务失败回退、删除顺序与核验逻辑；真实服务还需要验证中文经历写入、过期事实、相似地点混淆、重启恢复和使用量。当前没有通过本接入宣称已经验证真人式记忆或游戏表现提升。

后续优先评估“相同线索能否想起相关经历、无关往事是否挤占上下文、错误推断是否被新观察纠正”，再增加定期反思、可解释遗忘、兴趣与审美档案。它们服务于 LLM 想做的事情，而不把经历强制转换成下一条必做任务。

本地故障回退只检索最近 2000 条经历，启动最多读取归档末尾 8 MiB；完整 JSONL 保留在磁盘，更早经历由 Hindsight 负责召回。待写队列为保证离线经历不丢失而不做截断，目前仍使用 JSON 原子保存；长时间离线积累大量事件时，后续需改为 journal 或索引存储，避免同步重写成本增长。
