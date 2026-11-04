# test 环境（集成验收的独立宿主环境）

`test` 与 `local`、`live` 并列，是第三个宿主运行环境。它用于 Minecraft 真实感知、空间记忆和 walk 闭环的集成验收，用独立的连接配置、世界副本和运行状态，不碰 `local`/`live` 的数据。

- **live**：正式运行，持续积累数据。
- **local**：日常开发和复现，保留复制的 live 数据（`local-test-01` 等）。
- **test**：可重复的集成验收，从空运行状态和空空间数据库开始，不迁移旧记忆。

`test` 是宿主运行环境，**不是**单元测试进程。它不会因为 `NODE_ENV=test` 就切换到某个持久化目录；真实游戏服务器和持久化目录始终由配置显式决定。

## 必需配置与优先级

`test` 沿用现有三层配置机制，不另建一套平行系统。三层为：

1. 进程环境变量（最高）
2. 模式文件 `.env.test`
3. 公共 `.env`（最低）

配置文件选择方式与 `local`/`live` 一致：`--curio=test` 定位 `$CURIO_ROOT/.env.test`，或 `--env-file=.env.test`、`ENV_FILE=test`。样例见 `example/.env.test`。

`test` 的**必要配置**（缺了会在 config 加载阶段明确报错，不会回退到 local/live）：

- `MEMORY_WORLD_ID`：必须显式指定（不能只写在公共 `.env` 里），且不得与 local/live 相同。它决定世界身份，同一测试世界重启必须保持不变。
- 数据/世界/归档目录不得与 local/live 相同或相互包含；`SERVER_DIR` 必须指向 test 专属目录（不能沿用公共 `.env` 的 `SERVER_DIR`）。
- `MC_PORT` / `RCON_PORT` / `DASHBOARD_PORT` 不得与其它本机环境冲突。

相对路径（`DATA_DIR`、`SERVER_DIR`、`AGENTS_DIR`、`LLM_ARCHIVE_DIR`、`DANMAKU_ARCHIVE_DIR`、`OBSERVER_HUD_CONFIG`、`SPATIAL_DB_PATH`）一律以配置文件所在目录（`.env.<mode>` 所在目录）为锚点解析：仓库内部署就是仓库根，`CURIO_ROOT` 部署就是 `$CURIO_ROOT`。检查与实际读写使用同一个最终绝对路径，与从哪个工作目录调用脚本无关。使用 `CURIO_ROOT` 部署时建议写绝对路径。

这些校验在游戏连接、数据库打开等任何副作用之前完成（`src/config.ts` 加载时）。config 检查入口不连接游戏、不启动服务器、不创建数据库，输出也不含密码、令牌等秘密。

## 命令

```powershell
# 只读检查：展示最终解析出的环境名、连接地址、世界目录、数据目录、空间库路径、日志目录、世界身份
npm run test:config

# 首次初始化：创建独立目录并复制世界种子（源必须已停止；不覆盖已有测试状态）
# 注意：不得用 local/live 的世界或数据目录作种子（如 /path/to/curio/data/world），见下方约束
npm run test:init -- --seed <独立的测试世界源目录>

# 启动 Curio（走 scripts/supervise.mjs 的实际启动入口）
npm run test:start
```

启动顺序：先单独启动 test 的 Minecraft 服务器（test 世界目录下的 `fabric-server-mc.…jar` 或 `server.jar`，端口与 `.env.test` 的 `MC_PORT` 一致），再 `npm run test:start`。Curio 只连接、不代为启动服务器。

test 启动后**默认等待显式验收指令**：连接、观察、控制台照常可用，但不会自动发起自主决策、生存反射或任何游戏动作（不会出现 glance/explore 等自动行为）。操作者通过控制台「恢复」按钮，或让管理员在游戏聊天里发 `!resume`，明确开始后才会进入执行流程；`!pause` 可随时回到等待状态。local/live 的启动行为不受影响。

关闭：在 `npm run test:start` 的终端按 Ctrl+C（Curio 存档后结束守护），再在 Minecraft 服务器控制台执行 `stop`（或经 RCON）。

## 世界种子的复制要求

- 种子来源必须显式指定（`--seed`），且**不得是 local/live 的世界或数据目录**（如 `/path/to/curio/data/world`、`/path/to/curio/data/live` 或它们的子目录）。测试世界必须是独立副本，不能用 local/live 的快照初始化；`test:init` 会在读取、探测或复制前拒绝这类来源。
- 种子源服务器仍在写入时**不做普通目录复制**：`test:init` 会先探测源服务器端口，源服务器运行中会拒绝执行。
- 复制到 test 专属目录（`.env.test` 的 `SERVER_DIR`），跳过 `logs/`、`recordings/`、`.cache/`、`session.lock` 和链接；世界本体（`world/`）作为真实副本复制，不通过符号链接或目录联接共享可写世界。
- 服务器版本、模组、插件与种子世界核对后原样复制，不自动升级世界；`test:init` 只改写**目标** `server.properties` 的服务配置，使副本与 test 配置一致：`server-port` = `MC_PORT`，`enable-rcon` = true（`RCON_PASSWORD` 为空则为 false），`rcon.port` = `RCON_PORT`，`rcon.password` = `RCON_PASSWORD`。种子源文件不被修改，密码不会写入日志或输出。
- 新副本有独立的世界身份（`MEMORY_WORLD_ID`），不因为来自 local/live 副本就混用原环境的空间记录。

## 重启与重置

- **重启**：`npm run test:start`。保留世界、数据库和运行状态，用于验证正常恢复；`MEMORY_WORLD_ID` 不变，同一测试世界及其数据库保持稳定的 worldId。
- **重置**：恢复测试场景的初始世界，并配套重置该场景的记忆和恢复状态。不能只恢复世界却继续读修改后的空间记忆，也不能让普通启动隐式清空数据库。

本轮不新增通用递归删除或一键清理工具；重复实验可以用「新建独立测试实例目录」的方式（另建 `.env.test` 指向新的 `DATA_DIR`/`SERVER_DIR`，配一个新的 `MEMORY_WORLD_ID`）。现有 `memory:reset` / `world:seed` / `agents:*` 面向 local；在 test 下使用前请确认它们只指向 test 目录。

## 本轮不迁移旧数据

首轮 `test` 从空运行状态和空空间数据库开始，不自动复制 local/live 的旧记忆、待恢复任务或学习产物。仓库内只读配置、代码和静态资源正常复用。空间记忆库（`curio-minecraft-3d-memory`）继续接受显式参数（`databasePath`、`worldId`），不识别 `local`/`live`/`test`；`SPATIAL_DB_PATH` 默认落在 `DATA_DIR/spatial/spatial.sqlite`，随数据目录一起隔离。

## 后续真实 walk 验收如何使用这个环境

- 用 `test:config` 确认连接地址、世界目录、数据目录和世界身份都指向 test 专属位置。
- 用 `test:init -- --seed <测试目录内的独立世界源>` 复制一个可重复的测试世界（种子源须位于 `TEST_ROOT_DIR` 内、且与 `SERVER_DIR` 互不包含的兄弟目录，不得用 local/live 世界）。
- 启动 test 服务器后 `npm run test:start`；walk 闭环接线完成后，在同一 test 实例里做真实感知、空间记忆和 walk 的集成验收。
- 空间库由 `config.spatial.databasePath` 提供显式路径，会话按现有契约建立（`sessionId` 由适配器在每次连接/重连时生成，不用环境名充当）。
- 验收后若要重复实验，另建一个 test 实例目录（新 `DATA_DIR`/`SERVER_DIR`/`MEMORY_WORLD_ID`），保持可复现且不污染已有结果。
