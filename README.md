# MineFish

基于 [Mindcraft](https://github.com/mindcraft-bots/mindcraft) 二次开发的 Minecraft AI 队友系统，支持中文交流、多机器人协作、分层记忆、实时环境感知与控制台。

项目仍在持续开发。本仓库保存当前后端、实际使用的网页控制台，以及独立的 Electron 桌面界面演示源码。

## 当前能力

- Minecraft Java Edition 1.21.6 接入，基于 Mineflayer 的内置游戏动作、移动、采集和合成。
- DeepSeek 和豆包原生 provider，以及上游已有的多种模型适配；每个机器人 API 并发为 1，不同机器人可并行运行。
- 独立机器人配置、主动会话、自主目标与空闲唤醒；对等待状态和机器人间命令回声作专门处理。
- 每个机器人独立的最近 10 轮工作窗口与追加式上下文日志。
- 短期记忆维护、用户管理的长期记忆、由 AI 管理的核心摘要，以及记忆与位置查看。
- 实时动作、物理移动、周围环境、拾取事件和乘坐状态观察。
- 内置联网搜索工具：独立的 DeepSeek 搜索/网页获取后端，不要求聊天模型本身使用 DeepSeek；需要单独配置 DeepSeek 密钥及服务可用性。
- 中文网页控制台：机器人配置、记忆与位置、真实上下文窗口、系统日志和 API 请求/返回查看。
- 当前依赖版本、锁文件和 `patch-package` 补丁随源码保存。

**当前的上乘、下乘和座位观察不等于载具导航。骑马、驾驶船、骑猪和矿车导航尚未完成；普通移动仍以玩家步行寻路为主。**

## 目录

```text
mindcraft/                后端、实际网页控制台、模型适配和机器人功能
  src/agent/              动作、行为循环、记忆、运行状态和游戏能力
  src/models/             模型 provider 与提示词组织
  src/mindcraft/          多机器人管理、Socket 服务和网页控制台
  src/utils/              API 队列、日志脱敏、搜索和公共工具
  profiles/               机器人与基础角色模板
  patches/                安装时应用的依赖补丁
MineFish前端/              独立 Electron 桌面界面演示，目前使用模拟数据
deployment/               进程托管、离线回归脚本与导航研究记录
Start-Mindcraft.ps1       Windows 启动入口
Stop-Mindcraft.ps1        Windows 停止入口
Restart-Mindcraft.ps1     Windows 重启入口
Logs-Mindcraft.ps1        Windows 日志查看入口
```

`MineFish前端/` 当前不连接后端、Minecraft 或模型 API。实际可管理机器人的是 `mindcraft/src/mindcraft/public/` 下的网页控制台。桌面界面接入后端属于后续工作。

## 后端安装

当前验证环境为 Windows x64、Node.js 22.23.3、Minecraft Java 1.21.6。使用 Node.js 22.x；其他平台需自行验证原生依赖。

```powershell
cd mindcraft
npm ci --include=dev --foreground-scripts
Copy-Item keys.example.json keys.json
Copy-Item login.example.json login.private.json
```

安装需要执行 `postinstall` 中的 `patch-package`，不要使用 `--ignore-scripts`，也不要省略补丁工具所在的开发依赖。

编辑本地文件：

1. `mindcraft/keys.json`：填写 `DEEPSEEK_API_KEY`、`ARK_API_KEY` 或实际使用的其他 provider 密钥。也可使用 provider 支持的同名环境变量。
2. `mindcraft/settings.js`：填写服务器版本、真实地址、端口和认证方式。仓库地址是示例 `127.0.0.1:25565`。
3. `mindcraft/profiles/`：选择机器人游戏名、provider、模型名和参数；当前保存了三个机器人 profile，可在 `settings.js` 中只启用需要的机器人。
4. `mindcraft/login.private.json`：现有 `/login` 登录插件适配需要的本地密码与玩家名，不要提交此文件。

`src/agent/server_login.js` 目前保留了当前部署使用的登录插件适配器，并在启动时读取上述文件。它不是通用的所有服务器认证实现；无登录插件或使用不同登录协议时，需要调整该适配。Minecraft 的 `offline` / `microsoft` 认证与进服后的登录插件是两个独立环节。

DeepSeek 与豆包示例保留当前测试过的模型标识；账号可调用的模型和接口权限以各服务实际开放情况为准。默认关闭视觉、语音和模型生成代码。

如果 `canvas`、`gl` 等原生依赖安装失败，请按照 `mindcraft/FAQ.md` 排查。`deployment/native-assets.cjs` 保存了本次 Windows 环境使用的官方预编译资源获取脚本，适用版本有限；应先确认依赖版本匹配，再按需使用。

## 启动与停止

直接运行后端：

```powershell
cd mindcraft
node main.js
```

当前配置的网页控制台地址为 `http://localhost:18080/`。

Windows 下也可在仓库根目录使用以下脚本，它们优先使用 `runtime/node-v22.23.3-win-x64/` 下的本地运行时，否则使用系统安装的 Node.js 22：

```powershell
powershell -ExecutionPolicy Bypass -File .\Start-Mindcraft.ps1
powershell -ExecutionPolicy Bypass -File .\Stop-Mindcraft.ps1
powershell -ExecutionPolicy Bypass -File .\Restart-Mindcraft.ps1
powershell -ExecutionPolicy Bypass -File .\Logs-Mindcraft.ps1
```

托管脚本通过 `deployment/supervisor.cjs` 启动正常的 `mindcraft/main.js` 入口。日志写入本地 `logs/`；机器人状态、记忆和日志写入 `mindcraft/bots/<名称>/`。这些运行数据不在仓库中。

当前控制台面向本机部署，远程访问控制仍需完善；不要将 API 调用明细和机器人管理接口当作已经具备公开托管能力的服务。

## 桌面前端演示

```powershell
cd MineFish前端
npm ci
npm start
# 生成 Windows 便携程序
npm run package
```

此演示使用模拟数据，窗口交互不会启动机器人。生成的 EXE、`release/`、本地 QA 结果和 `node_modules/` 不提交到 Git。原有 `npm run verify` 用于检查本地产生的 QA 结果和便携 EXE，需要先生成这些产物。

## 离线验证与研究

例如在仓库根目录执行：

```powershell
node deployment/test-model-request-queue.mjs
node deployment/test-work-context.mjs
node deployment/test-empty-bed-dismount.mjs
node deployment/test-entity-target-seats.mjs
node deployment/trace-land-navigation.cjs
```

测试脚本使用本地夹具，不能替代真实服务器上的功能验收。导航研究详见 `deployment/land-navigation-audit-20261023.txt`；配套 JSON 保存真实搜索输出，但地形是离线构造的。

`mindcraft/tasks/` 保留上游评测相关源码，普通伴玩启动不使用这些流程。

## 后续方向

- 完善兼容多种模型的平台能力，统一模型、工具与配置管理。
- 持续扩展游戏能力和可观测性，完善不同移动模式的导航与控制。
- 将安装、依赖管理和启动流程逐步整合进桌面应用。
- 重做并接通桌面前端，逐步替代当前网页管理入口。

上述方向为规划，不代表已经实现。

## 来源与许可证

本项目基于 Mindcraft 的 `develop` 分支，起始 commit：[`f6a9556cf756e6bd88a75cc2fa0d5aed7599b101`](https://github.com/mindcraft-bots/mindcraft/commit/f6a9556cf756e6bd88a75cc2fa0d5aed7599b101)。保留上游源码结构及 `mindcraft/LICENSE` 中的原始版权和 MIT 许可。

MineFish 仓库沿用现有 [MIT 许可证](LICENSE)。第三方依赖、图标及素材遵循各自许可证，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)；本项目与 Mojang/Microsoft 无官方关联。
