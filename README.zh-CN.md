# Curio

<p>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/minecraft-1.20.1-62B47A.svg" alt="Minecraft 版本">
  <img src="https://img.shields.io/badge/node-22_LTS-339933.svg" alt="Node.js 版本">
  <img src="https://img.shields.io/badge/typescript-5.6-3178C6.svg" alt="TypeScript">
  <img src="https://img.shields.io/badge/mineflayer-4.20+-DBBE5B.svg" alt="Mineflayer">
</p>

[English](README.md) | 简体中文

面向 **Minecraft Java 1.20.1** 的自主探索与学习 Agent，基于 Mineflayer、OpenAI 兼容 LLM、非透视射线视觉、持久化 3D 空间记忆与本地 Web 控制台构建。

Curio 的核心目标是让 Agent 通过观察、探索、查阅知识、试验、反思与自主编写技能，在原版 1.20.1 世界中逐步学会生存、建造、探索与进阶玩法，而不是执行开发者写死的通关脚本。程序负责提供可靠、可组合的身体能力与真实反馈；目标、策略与学得的技能均由 Agent 自己形成。

## 核心特性

- **原版结构化接入**：通过 Mineflayer 以普通玩家身份连接原版（或 Paper / Fabric）1.20.1 服务端，直接感知方块、实体、背包、光照、时间与生物群系，不截图、不识图。
- **非透视 AI 视觉**：基于已加载区块模拟射线视野（视锥、遮挡、光照、水/树叶穿透与听觉半径，`src/perception/vision.ts`），禁用透视接口（`NO_XRAY`）；看过的资源与地标沉淀进长期记忆。
- **真人式心智闭环**：以多步骤「一段活（Activity）」组织行为（`src/mind/`），边做边想，在轻量「瞥一眼（glance）」与全局「认真想（deliberate）」之间切换，维护情绪、议程、日记与阶段回想。
- **自主学习行为与代码技能**：内置本地 Java 1.20.1 客观知识库（`knowledge/`）与技能书（`skills/`），Agent 可编写行为触发器与沙箱化 JavaScript 代码技能（`src/codeskills/`），经真实试用验收后启用并在失败时自动迭代改进。
- **持久化 3D 空间与情境记忆**：通过本地 SQLite 3D 空间库（`curio-minecraft-3d-memory`）保存观测体素、地标、传送门与精确容器账本，并可选接入 [Hindsight](docs/memory-hindsight.md) 实现长期经历整理与按线索召回。
- **兼容任意 OpenAI 协议 LLM**：支持 OpenAI、DeepSeek、Ollama、LM Studio 等任意 `/chat/completions` 接口，支持流式输出、前缀缓存友好提示词与独立代码模型；内置 `mock` 模式，无 API Key 即可跑通全链路。
- **本地控制台与旁观观察**：仅绑定本机的 Web 控制台（`127.0.0.1:3001`）提供心智、技能、AI 视野与深度图、记忆、事件流、实时 LLM 调用流与 `.env` 编辑，支持 RCON 自动 `/spectate` 及可选 [Curio Observer](https://github.com/LudensAgent/Curio-Observer) 第一人称 HUD 模组。

## 工作原理

![Curio 系统架构图：Minecraft 1.20.1 服务端、LLM 与可选 Hindsight 后端、Curio Agent 主进程与本地观测控制台](docs/images/architecture.zh-CN.svg)

## 环境依赖

- **Node.js 22 LTS**（最低 `>= 20.12`；如需 `--use-env-proxy` 需 Node.js `>= 22.21` 或 `>= 24.5`）
- **Java 17+**（用于运行 Minecraft 1.20.1 服务端）
- **Minecraft Java 版 1.20.1 客户端**（可选，用于旁观观察）
- **Docker**（可选，仅在使用 Hindsight 外部长期情境记忆时需要）

## 快速开始

### 1. 启动本地 Minecraft 1.20.1 服务器

1. 准备原版 `server.jar`（或 Paper / Fabric 1.20.1 服务端）。**不要安装要求客户端同步的内容模组**（如 Create 等），否则 Mineflayer Bot 会被拒绝连接。
2. 首次启动生成配置文件后，将 `eula.txt` 改为 `eula=true`。
3. 修改 `server.properties` 关键配置：

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

### 2. 安装并运行 Curio

```bash
npm install
cp example/.env .env        # Windows PowerShell: copy example\.env .env
npm test                    # 运行离线单元测试（无需启动 Minecraft）
npm start                   # 或使用守护进程自动重启：npm run supervise
```

打开本地控制台：<http://127.0.0.1:3001>。

如需使用分层配置（公共 `.env` + 环境覆盖 `.env.local` / `.env.test`）：

```bash
cp example/.env.local .env.local
npm run start:local         # 默认启用守护进程，合并 .env + .env.local
```

在 `.env`（或 `.env.local`）中至少检查以下配置：

```ini
MC_HOST=127.0.0.1
MC_PORT=25565
BOT_USERNAME=Curio
OBSERVER_PLAYER=你的游戏名       # 留空则关闭自动旁观
RCON_PASSWORD=与 server.properties 一致
```

默认 `LLM_PROVIDER=mock`，无需 API Key 即可先确认游戏连接、AI 视野、自动旁观与控制台链路畅通。

## 接入 LLM

在 `.env` 中将 `LLM_PROVIDER` 改为 `mock` 以外的名称（如 `openai`、`deepseek`、`ollama`，仅作显示名），并填写对应服务配置：

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

启动前可先单独验证模型连通性与 JSON 输出：

```bash
npm run check:llm
```

- 如果所用模型不支持 `response_format: { type: "json_object" }`，将 `LLM_JSON_MODE=false`。
- 可通过 `CODER_LLM_MODEL` / `CODER_LLM_BASE_URL` / `CODER_LLM_API_KEY` 为后台技能生成与代码改进单独指定更强模型（未设置时复用 `LLM_*`）。
- 如需通过 HTTP(S) 代理访问模型接口，在 `.env` 配置 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY=localhost,127.0.0.1,::1`，并使用 `npm run start:proxy` 或 `npm run supervise:proxy` 启动。

## 控制台与观察

### 本地 Web 控制台

默认监听 `127.0.0.1:3001`（仅本机可访问）：

- **实时状态与控制**：生命、饥饿、坐标、背包、主目标与当前活动、思考独白；支持暂停/继续、重新思考、发送建议、开关自动旁观、紧急救援（RCON 传送至附近地表）、一键天亮、给予物品、清除周围实体。
- **核心标签页**：
  - **观察者**：[Curio Observer](https://github.com/LudensAgent/Curio-Observer) 模组 HUD 布局、自动视角与暗处增亮设置、实时 LLM Token 与花费统计。
  - **学习曲线**：综合评分趋势、每条命里程碑用时与收获账本。
  - **心智**：念头流、议程、情绪、窍门、日记、实验记录与消耗品预算。
  - **技能**：已学行为/代码技能列表、成败统计、手动整理、启停与清理。
  - **视野**：实时射线视野图与深度图、看见和听见的实体列表。
  - **记忆**：当前维度记忆概览、地标管理、容器账本与空间记忆状态。
  - **事件 / LLM 调用 / 运行指标 / 配置**：按级别筛选事件流、实时流式查看 LLM 提示词/思考/返回，以及在线编辑 `.env`（密钥永不回传浏览器）。

### 游戏内自动旁观与聊天指令

1. 使用 Minecraft 1.20.1 客户端进入服务器，并配置 `OBSERVER_PLAYER` 与 `RCON_PASSWORD`。
2. Agent 会自动通过 RCON 执行 `gamemode spectator` 与 `/spectate` 附着视角，并在死亡、重生或跨维度后自动重新附着。可用 `npm run check:rcon` 单独检查 RCON。
3. 管理员玩家（`OBSERVER_PLAYER` 与 `ADMIN_PLAYERS`）可在游戏聊天中使用指令：
   - `!pause` / `!resume` / `!replan` / `!status`
   - `!goal <内容>`：向 Agent 提交目标建议
   - `!prefer <内容>`：记录用户偏好
   - `!feedback <作品ID> <内容>`：对建筑作品提交外观反馈

### Curio Observer 模组（可选）

配合 [Curio Observer](https://github.com/LudensAgent/Curio-Observer) Fabric 1.20.1 客户端模组，可在旁观视角以原版样式查看 Bot 的生命、快捷栏、实时背包/工作台合成界面与思考字幕。`OBSERVER_FEED=true`（默认）时在控制台同端口暴露只读 `/api/observer/stream` SSE 数据流，不需要时设为 `OBSERVER_FEED=false`。协议说明见 [docs/observer-mod-design.md](docs/observer-mod-design.md)。

## 记忆、角色档案与守护进程

### 无人值守守护进程

`npm run supervise`（以及 `npm run start:local`）会监控心跳与堆内存使用，在异常崩溃、事件循环卡死或内存接近上限（先存档再退出）时自动重启，并在 `DATA_DIR/logs/` 写入崩溃报告与错误日志。按 `Ctrl+C` 可安全存档并退出。

### Hindsight 长期情境记忆（可选）

默认 `MEMORY_PROVIDER=local`，所有运行数据保存在 `DATA_DIR/` 中。如需启用 Hindsight 进行长期经历整理与按线索召回，详见 [docs/memory-hindsight.md](docs/memory-hindsight.md)：

```bash
npm run memory:serve
npm run check:memory
```

### 常用维护命令

执行维护命令前请先退出 Agent；涉及重置世界时请先停止 Minecraft 服务器：

| 命令 | 作用 |
|---|---|
| `npm run memory:clear` | 清空 `DATA_DIR` 记忆、日志与自学技能，并删除对应的 Hindsight bank |
| `npm run memory:reset` | 清空记忆并重置 `SERVER_DIR` 世界存档（支持 `-- --dry-run` 预览） |
| `npm run agents:list` | 列出已归档的角色档案 |
| `npm run save` / `npm run load` | 快速存档 / 读档（冻结或恢复记忆、世界与配置） |
| `npm run agents:new -- <名字>` | 归档当前角色并初始化全新角色与新世界（`--random-seed` 可跳过挑种子） |
| `npm run agents:switch -- <ID或名字>` | 归档当前角色并切换回指定历史角色 |
| `npm run world:seed -- --tiers` | 查看出生点群系难度分级表 |

## 项目结构

```text
src/
├─ adapter/      GameAdapter 抽象接口与 Mineflayer 实现
├─ arbiter/      动作仲裁器（计划版本、取消、抢占与动作守卫）
├─ brain/        反射触发、卡死检测、驱动与补给计算
├─ building/     建筑师子代理、图纸编译、施工与作品归档
├─ codeskills/   工作线程 VM 沙箱、技能锻造、改进与整理
├─ config/       分层 .env 加载与 test 环境隔离校验
├─ knowledge/    本地 Java 1.20.1 百科与技能书加载器
├─ maintenance/  角色存读档、记忆清空与世界重置工具
├─ memory/       世界记忆、容器账本与 Hindsight 情境记忆客户端
├─ methods/      参数化方法试验、配方书与经验提炼
├─ mind/         心智主循环（自我模型、注意力、活动、思考与提示词）
├─ observer/     RCON 自动旁观、指标统计、花费统计与 Web 控制台服务
├─ perception/   非透视射线视觉、听觉与结构化感知摘要
├─ planner/      OpenAI 兼容 LLM 适配、流式追踪、计价与预算
├─ projects/     目标条件评估与材料预留
├─ seeds/        按出生点群系难度筛选世界种子
├─ skills/       可组合的基础交互、寻路移动、采集建造、战斗与传送门技能
├─ spatial/      3D 空间记忆会话、检查点调度与容量保留策略
└─ travel/       传送门与跨维度路径记录
knowledge/       Minecraft Java 1.20.1 客观游戏百科文档
skills/          内置技能书说明（architect、creatures、writing-skills）
public/          本地 Web 控制台前端（dashboard.html）
scripts/         守护进程、连通性检查、记忆与角色管理脚本
tests/           离线测试套件（无需 Minecraft 服务器）
docs/            架构与协议参考文档
```

## 参考文档

- [AGENTS.md](AGENTS.md) — Agent 能力边界、执行约束与提示词设计规范
- [docs/agent-capabilities.md](docs/agent-capabilities.md) — Agent 能力范围与接口概览
- [docs/behavior-skills.md](docs/behavior-skills.md) — 行为技能与沙箱代码技能机制
- [docs/interaction-primitives.md](docs/interaction-primitives.md) — 身体基础接口与执行授权
- [docs/knowledge-base.md](docs/knowledge-base.md) — Java 1.20.1 知识库协议与客观表述边界
- [docs/memory-hindsight.md](docs/memory-hindsight.md) — Hindsight 情境记忆接入与清理指南
- [docs/spatial-actions.md](docs/spatial-actions.md) — 空间查询与路径动作说明
- [docs/observer-mod-design.md](docs/observer-mod-design.md) — Curio Observer 客户端模组协议与设计
- [docs/test-environment.md](docs/test-environment.md) — 独立 `test` 集成验收环境配置指南

## 常见问题

- **`ECONNREFUSED 127.0.0.1:25565`**：Minecraft 服务器未启动，或 `MC_HOST` / `MC_PORT` 配置不一致。
- **Bot 连上即被踢出**：确认服务端 `online-mode=false`，且未安装要求客户端同步的内容模组。
- **版本不匹配**：确认 `MC_VERSION` 与服务端版本（`1.20.1`）一致。
- **RCON 认证失败**：确认 `.env` 中 `RCON_PASSWORD` 与 `server.properties` 一致，并在修改后重启服务端。
- **Bot 无法在出生点附近挖掘**：将 `server.properties` 中的 `spawn-protection` 设为 `0`。

## 许可证

本项目基于 [MIT 协议](LICENSE)开源。
