# test 环境（独立集成验收宿主环境）

`test` 与 `local`、`live` 并列，是第三个宿主运行环境，用于 Minecraft 真实感知、空间记忆和流体/移动闭环的集成验收。它使用独立的连接配置、世界副本和运行状态，不碰 `local`/`live` 的数据。

- **live**：正式运行，持续积累数据。
- **local**：日常开发和复现，保留复制的 live 数据。
- **test**：可重复的集成验收，从空运行状态开始，不迁移旧记忆。

`test` 是宿主运行环境，**不是**单元测试进程。真实游戏服务器和持久化目录始终由配置显式决定，`NODE_ENV=test` 不会切换到某个持久化目录。

## 独立目录约定（本任务）

本任务的所有测试服务端与持久化数据统一放在 `/path/to/curio\test-setver`：

| 项 | 值 |
|---|---|
| Minecraft 服务端根目录（`SERVER_DIR`） | `/path/to/curio\test-setver`（含 `world/`、`server.properties`） |
| 服务端版本 | Fabric `fabric-server-mc.1.20.1-loader.0.18.5-launcher.1.1.2.jar`（Minecraft Java 1.20.1） |
| 世界 | 超平坦（`level-type=flat`）、生存模式（`gamemode=survival`） |
| Curio 数据目录（`DATA_DIR`） | `/path/to/curio\test-setver\curio-data` |
| 角色档案（`AGENTS_DIR`） | `/path/to/curio\test-setver\curio-data\agents` |
| LLM 调用归档 | `/path/to/curio\test-setver\curio-data\archives\llm-calls` |
| 世界身份（`MEMORY_WORLD_ID`） | `curio-test-setver-01` |
| 游戏连接（`MC_HOST:MC_PORT`） | `127.0.0.1:25566` |
| RCON（`RCON_HOST:RCON_PORT`） | `127.0.0.1:25576` |
| 控制台（`DASHBOARD_PORT`） | `3002` |

端口、可写目录与世界身份均与 local/live 不同或不相包含；`test:config` 会展示最终解析结果，`src/config/isolation.ts` 在连接游戏、打开数据库之前校验这些不变量，冲突或缺 `MEMORY_WORLD_ID` 时立即失败，不会回退到 local/live。

本分支世界记忆仍是 `dataDir/world-memory.json` 的 JSON 文件（未接入 SQLite 空间库），故隔离校验只比较数据/世界/角色/归档目录与端口，不涉及空间库路径。

## 命令

```powershell
# 只读展示最终解析出的环境名、连接地址、世界目录、数据目录、世界身份
npm run test:config

# 启动 Curio（走 scripts/supervise.mjs 的实际启动入口）
npm run test:start
```

`test:start` 启动的是 Curio 进程，**不代表 Minecraft 服务端已经启动**。启动顺序：先单独启动 test 的 Minecraft 服务端（`/path/to/curio\test-setver` 下的 Fabric jar，端口须与 `.env.test` 的 `MC_PORT` 一致），再 `npm run test:start`。Curio 只连接、不代为启动服务器；本轮也不自动启动 LLM 自主活动或发起游戏动作。

## 当前缺口（尚未完成）

`/path/to/curio\test-setver\server.properties` 目前仍是默认 `server-port=25565`，与 local 配置的 `127.0.0.1:25565` 相同；而 `test:config` 按隔离要求解析为 `25566`。实际服务端仍在 25565 上运行，改端口需要停止并重启该测试服务端（`enable-rcon=false`，无法用 RCON 优雅停机）。本分支未擅自停止该进程，因此尚未在实服复现桶操作、被水流推动的移动与瞬时落地水时序。

本分支未提供 `test:init`（世界副本初始化）：测试服务端与测试世界须由操作者显式放置到 `/path/to/curio\test-setver`，不复制 local/live 的世界、记忆、数据库或日志，也不用它们的快照初始化。
