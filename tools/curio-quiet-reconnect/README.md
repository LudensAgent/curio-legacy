# Curio Quiet Reconnect（服务器端 Fabric 模组）

Agent 换新代码要重启，机器人会下线再上线，服务器就会广播“Deepseek 离开了游戏 / 加入了游戏”，直播画面里看起来像断线。
这个模组只拦下这两条广播，而且只拦 `config/curio-quiet-reconnect.txt` 里列出的玩家（一行一个，默认 `Deepseek`）。
其他消息（死亡、聊天、别的玩家进出）和服务器控制台日志都不受影响。

- 只用 Fabric API 的 `ServerMessageEvents.ALLOW_GAME_MESSAGE`，没有 mixin；Minecraft 1.20.1 + Fabric Loader 0.14+ + Fabric API。
- 安装：把 `curio-quiet-reconnect-1.0.0.jar` 放进 `world/mods/`，**下次重启 Minecraft 服务器时**生效（服务器正在跑时放进去不影响它）。
- 重新编译（不需要 Gradle）：
  ```
  javac --release 17 -cp "server-intermediary.jar:fabric-loader.jar:fabric-message-api-v1.jar:fabric-api-base.jar:brigadier.jar" -d out QuietReconnect.java
  cp fabric.mod.json out/ && (cd out && jar cf ../curio-quiet-reconnect-1.0.0.jar .)
  ```
  `server-intermediary.jar` 在 `world/.fabric/remappedJars/` 里，其余在 `world/libraries/` 和 fabric-api 的 `META-INF/jars/` 里。
