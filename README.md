# Curio · Minecraft Autonomous Curiosity Agent

面向 **Minecraft Java 1.20.1** 的自主探索与学习 Agent（Mineflayer + OpenAI 兼容 LLM + 非透视射线视觉 + 3D 空间记忆 + 本地控制台）。

目标是让 Agent 通过观察、探索、查阅知识、试验、反思与技能总结，在原版 1.20.1 世界里逐步学会生存、建造、探索与进阶玩法，而不是运行开发者写死的通关脚本。

```
              ┌──────────────── 本机环境 ────────────────┐
  Minecraft   │                                          │
  服务端 1.20.1 ◄──协议── Bot (Curio) ◄── 本项目 (Node)   │
     ▲  ▲     │                         │  ├ 心智与 LLM 规划（异步）
     │  └─RCON┼── 自动 /spectate ───────┘  ├ 动作仲裁器 / 反射层
     │        │                            ├ 3D 空间记忆 & 情境记忆
  你的客户端 ──┘ 旁观 Bot                  └ 本地控制台 :3001
```

---

## 核心特性

| 模块 | 说明 |
|---|---|
| **结构化接入** | 基于 Mineflayer 以独立玩家身份连接原版 1.20.1 服务器，通过结构化游戏状态感知（方块、实体、背包、光照、时间、群系），不截图、不识图 |
| **非透视 AI 视觉** | 用区块数据做射线视野模拟（视锥、遮挡、光照、水/叶穿透、听觉半径），严禁调用透视接口；看过的资源与结构沉淀为长期空间记忆 |
| **真人式心智层** | `src/mind/` 按「一段活（Activity）」连续执行、边做边想、情绪驱动、议程与日记、睡前回想、假设与试验验证 |
| **自主学习技能** | 结合内置操作手册与 Minecraft Java 1.20.1 知识库，Agent 可总结行为技能与沙箱 JS 代码技能，经实际试用验收后启用并在失败时自动改进 |
| **兼容任意 LLM** | 支持所有 OpenAI 兼容 `/chat/completions` 接口（OpenAI / DeepSeek / Ollama / LM Studio 等）；内置 `mock` 模式，无 API Key 即可跑通完整链路 |
| **可观测与旁观** | 内置本地 Web 控制台（实时状态、心智、技能、AI 视野、记忆、事件流、LLM 调用流、配置编辑），支持 RCON 自动 `/spectate` 旁观及可选的 Curio Observer 客户端 HUD 模组 |

---

## 1. 环境准备

- **Node.js 22 LTS**（最低 `>=20.12`；如需 `--use-env-proxy` 需 Node.js `22.21+` 或 `24.5+`）
- **Java 17+**（运行 Minecraft 1.20.1 服务端）
- **Minecraft Java 版 1.20.1 客户端**（可选，用于旁观观察）
- **Docker**（可选，仅在使用 Hindsight 外部长期情境记忆时需要）

---

## 2. 启动 Minecraft 1.20.1 服务器

1. 准备原版 `server.jar` 或 Paper / Fabric 1.20.1 服务端。**不要安装要求客户端同步的内容模组**（如 Create 等），否则 Mineflayer Bot 会被拒绝连接。
2. 首次启动生成文件后，将 `eula.txt` 改为 `eula=true`。
3. 编辑 `server.properties` 关键配置：

```properties
online-mode=false          # Bot 以离线模式登录；仅限本机/局域网使用，切勿暴露公网
enable-rcon=true
rcon.port=25575
rcon.password=请替换为足够长的随机密码
server-port=25565
spawn-protection=0         # 允许 Bot 在出生点附近挖掘方块
difficulty=easy
```

4. 启动服务端：

```bash
java -Xmx2G -jar server.jar nogui
```

> 建议为 Agent 单独创建测试世界，避免使用个人主存档。

---

## 3. 安装与快速启动

```bash
npm install
cp example/.env .env           # Windows PowerShell: copy example\.env .env
npm test                       # 运行离线单元测试（无需启动 Minecraft）
npm start                      # 或使用守护进程：npm run supervise
```

打开本地控制台：<http://127.0.0.1:3001>。

如果需要使用分层配置（公共 `.env` + 环境覆盖 `.env.local` / `.env.test`）：

```bash
cp example/.env.local .env.local
npm run start:local            # 默认启用守护进程，读取 .env + .env.local
```

在 `.env`（或 `.env.local`）中最少检查以下配置：

```ini
MC_HOST=127.0.0.1
MC_PORT=25565
BOT_USERNAME=Curio
OBSERVER_PLAYER=你的游戏名       # 留空则关闭自动旁观
RCON_PASSWORD=与 server.properties 一致
```

默认 `LLM_PROVIDER=mock`，建议先用它确认游戏连接、控制台、AI 视野与旁观均正常，再切换真实模型。

---

## 4. 接入真实 LLM

在 `.env` 中将 `LLM_PROVIDER` 改为 `mock` 以外的名称（如 `openai`、`deepseek`、`ollama`，仅作显示名），并配置对应服务参数：

```ini
# OpenAI
LLM_PROVIDER=openai
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
LLM_API_KEY=sk-...

# DeepSeek
LLM_PROVIDER=deepseek
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-chat
LLM_API_KEY=sk-...

# Ollama（本机）
LLM_PROVIDER=ollama
LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL=qwen2.5:14b
LLM_API_KEY=
```

先单独验证模型连通性与 JSON 输出：

```bash
npm run check:llm
```

- 如果所用模型不支持 `response_format=json_object`，将 `LLM_JSON_MODE=false`。
- 后台技能编写与代码改进可通过 `CODER_LLM_MODEL` / `CODER_LLM_BASE_URL` / `CODER_LLM_API_KEY` 单独指定更强模型（未配置时复用主模型）。
- 如需通过 HTTP(S) 代理访问模型接口，在 `.env` 配置 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY=localhost,127.0.0.1,::1`，并使用 `npm run start:proxy` 或 `npm run supervise:proxy` 启动。

---

## 5. 本地控制台与观察

### Web 控制台

启动后访问 <http://127.0.0.1:3001>（仅监听 `127.0.0.1`），提供：

- **实时状态**：生命/饥饿/坐标/背包、主目标与当前活动、思考独白与正在执行的动作。
- **实时控制**：暂停/继续、重新思考、发送建议、开关自动旁观、紧急救援（RCON 传送至附近地表）、一键天亮、给予物品、清除周围实体。
- **标签面板**：
  - **观察者**：Curio Observer 模组 HUD 布局、镜头与暗处增亮设置、LLM Token 与花费统计。
  - **学习曲线**：综合评分、里程碑时间线、收获账本。
  - **心智**：念头流、议程、情绪、窍门、日记与实验、消耗品预算。
  - **技能**：已学行为/代码技能状态、成败统计、手动整理/禁用/删除。
  - **视野**：实时射线视野图与深度图、看见/听见的实体。
  - **记忆**：维度记忆概览、地标管理、箱子与空间状态。
  - **事件 / LLM 调用 / 运行指标 / 配置**：按级别筛选事件、实时流式查看 LLM 请求/思考/响应、在线编辑 `.env`（密钥不回传浏览器）。

### 游戏内控制与 RCON 自动旁观

1. 用 Minecraft 1.20.1 客户端进入服务器，并配置 `OBSERVER_PLAYER` 与 `RCON_PASSWORD`。
2. Agent 会自动执行 `gamemode spectator` 与 `/spectate` 将视角附着到 Bot，死亡/重生/切换维度后自动重新附着。可用 `npm run check:rcon` 单独测试 RCON。
3. 游戏内管理员聊天指令（`OBSERVER_PLAYER` 与 `ADMIN_PLAYERS`）：
   - `!pause` / `!resume` / `!replan` / `!status`
   - `!goal <内容>`：向 Agent 提供目标建议
   - `!prefer <内容>`：记录用户偏好
   - `!feedback <作品ID> <内容>`：对建筑作品提交反馈

### Curio Observer 第一人称 HUD 模组（可选）

如果希望在旁观客户端看到 Bot 的第一人称原版样式血条、快捷栏、背包/工作台合成动画和思考字幕，可搭配 `CurioObserver` Fabric 1.20.1 客户端模组（通过本机 `/api/observer/stream` SSE 接口同步，默认随 `OBSERVER_FEED=true` 开启；不需要时设为 `OBSERVER_FEED=false`）。设计说明见 [docs/observer-mod-design.md](docs/observer-mod-design.md)。

---

## 6. 守护进程、记忆与角色管理

### 守护进程（无人值守）

`npm run supervise`（及 `npm run start:local`）在子进程崩溃、内存接近上限（先存档后退出）或心跳卡死超时时自动重启，并在 `DATA_DIR/logs/` 下保存崩溃报告与错误日志。按 `Ctrl+C` 可安全存档并退出。

### 长期情境记忆（Hindsight，可选）

默认 `MEMORY_PROVIDER=local`，所有记忆均保存在本地 `DATA_DIR/` 中（含 SQLite 3D 空间记忆与 JSON 状态）。如需启用 Hindsight 长期经历整理与按线索召回，见 [docs/memory-hindsight.md](docs/memory-hindsight.md)：

```bash
npm run memory:serve
npm run check:memory
```

### 清空记忆、角色存档与世界挑种子

执行前请先退出 Agent（涉及世界重置时先停掉 Minecraft 服务器）：

| 命令 | 作用 |
|---|---|
| `npm run memory:clear` | 清空 `DATA_DIR` 记忆/日志/自学技能，并清理对应的 Hindsight bank |
| `npm run memory:reset` | 在清空记忆的同时重置 `SERVER_DIR` 世界存档（支持 `-- --dry-run` 预览） |
| `npm run agents:list` | 列出已保存的角色档案 |
| `npm run save` / `npm run load` | 快速存档 / 读档（冻结或恢复记忆、世界与配置） |
| `npm run agents:new -- <名字>` | 归档当前角色并初始化全新角色与新世界（加 `--random-seed` 跳过挑种子） |
| `npm run agents:switch -- <ID或名字>` | 归档当前角色并切换回指定历史角色 |
| `npm run world:seed -- --tiers` | 查看出生点群系难度分级表 |

---

## 7. 项目结构

```text
src/
├─ adapter/      GameAdapter 抽象接口与 Mineflayer 实现
├─ arbiter/      动作仲裁器（版本控制、取消、抢占与动作守卫）
├─ brain/        反射层、卡死检测、驱动与补给计算
├─ building/     建筑师子代理、图纸编译、施工与归档
├─ codeskills/   沙箱化 JS 代码技能执行、生成、改进与整理
├─ config/       环境配置解析与 test 隔离校验
├─ knowledge/    Minecraft Java 1.20.1 本地百科与技能书加载器
├─ maintenance/  角色存档、记忆与世界重置工具
├─ memory/       世界记忆、容器账本、Hindsight 情境记忆封装
├─ methods/      参数化方法试验、配方书与经验提炼
├─ mind/         心智主循环（自我模型、注意力、活动、思考与提示词）
├─ observer/     RCON、自动旁观、指标统计与本地 Web 控制台
├─ perception/   非透视射线视觉、听觉与环境摘要
├─ planner/      OpenAI 兼容 LLM 适配、流式追踪、计价与预算
├─ projects/     目标条件评估与材料预留
├─ seeds/        按出生群系难度筛选世界种子
├─ skills/       基础交互、移动寻路、采集建造、战斗与跨维度技能
├─ spatial/      3D 空间记忆会话、检查点调度与容量保留策略
└─ travel/       传送门与跨维度路径记录
knowledge/       Minecraft Java 1.20.1 客观游戏百科文档
skills/          内置技能书说明（architect、creatures、writing-skills）
public/          本地 Web 控制台前端（dashboard.html）
scripts/         守护进程、连通性检查、记忆与角色管理脚本
tests/           离线测试套件（无需 Minecraft 服务器）
docs/            架构与接口参考文档
website/         项目展示静态页（独立 Vite 工程）
```

---

## 8. 参考文档

- [AGENTS.md](AGENTS.md) — Agent 能力边界、执行约束与提示词设计规范
- [docs/agent-capabilities.md](docs/agent-capabilities.md) — Agent 能力范围与接口概览
- [docs/behavior-skills.md](docs/behavior-skills.md) — 行为技能与代码技能机制
- [docs/interaction-primitives.md](docs/interaction-primitives.md) — 身体基础接口与执行授权
- [docs/knowledge-base.md](docs/knowledge-base.md) — Java 1.20.1 知识库协议与客观边界
- [docs/memory-hindsight.md](docs/memory-hindsight.md) — Hindsight 情境记忆接入与清理指南
- [docs/spatial-actions.md](docs/spatial-actions.md) — 空间查询与路径动作说明
- [docs/observer-mod-design.md](docs/observer-mod-design.md) — Curio Observer 客户端模组协议与设计
- [docs/test-environment.md](docs/test-environment.md) — 独立 `test` 集成验收环境配置指南

---

## 常见问题

- **`ECONNREFUSED 127.0.0.1:25565`**：Minecraft 服务器未启动，或 `MC_HOST` / `MC_PORT` 配置不一致。
- **Bot 连上即被踢出**：确认服务端 `online-mode=false`，且未安装要求客户端同步的内容模组。
- **版本不匹配**：确认 `MC_VERSION` 与服务端版本（`1.20.1`）一致。
- **RCON 认证失败**：确认 `.env` 中 `RCON_PASSWORD` 与 `server.properties` 一致并已重启服务器。
- **Bot 无法在出生点附近挖掘**：将 `server.properties` 中的 `spawn-protection` 设为 `0`。

---

## License

[MIT](LICENSE)
