# Magpie · Devin Bridge

让 **Devin 桌面版**（Devin.exe / Devin CLI 的 ACP agent）使用 **Magpie** 里配置的模型与路由组：
不必登录 Devin 账号，不消耗 Devin 额度，也不要额外的常驻应用。

```
Devin 桌面版
   ├─ 本地 agent（devin-cli ACP）──► 127.0.0.1:8788（明文 HTTP）
   └─ 编辑器/桌面聊天 ────────────► 127.0.0.1:7450（MITM，Devin 自己的 http.proxy）
                                          │
                                          ▼
                                 bridge.js（本机桥接）
                                          │  Connect-RPC / protobuf ⇄ OpenAI /v1/chat/completions（SSE）
                                          ▼
                                 Magpie 网关（127.0.0.1:3425/v1）
                                          │
                                          ▼
                                 你配置的模型 / 路由组
```

两条路径共用同一个 `bridge.js`：

- **8788（ACP）**：Devin 的本地 agent 只认一个环境变量 `WINDSURF_API_SERVER_URL`。桥接实现它期望的
  `exa.api_server_pb.ApiServerService`，把 `GetChatMessage` 翻译成 Magpie 的
  `/v1/chat/completions` 流式请求，再把增量（正文、思考、工具调用、用量、停止原因）重新打包成
  Connect 帧推回 Devin。登录状态、团队设置、模型目录、埋点由桥接本地应答。
- **7450（MITM）**：编辑器自带的聊天直接连 `server.codeium.com`，不经过 8788。桥接在 7450 终止
  TLS，只改写模型目录（`GetUserStatus` / `GetCliModelConfigs` / `GetCommandModelConfigs`），
  `GetChatMessage` 和其它流量原样转发。

## 模型菜单

模型菜单按**供应商前缀**分组，而不是一个模型一个组：

- 本地会话（8788）：`GetCliModelConfigs` 的条目名只保留前缀后的部分，traits 的组名写成前缀
  （`ccx`、`guanxingyun`、`codearts`、`officeace`、`cline`、`group`）。
- 编辑器聊天（7450）：`anybridge-config/model-map.json` 里的槽位把 Devin 的模型 UID 映射到
  Magpie 模型，`displayName` 用 `前缀/模型` 格式，traits 组名同样写成前缀。
- 在菜单里选中某个模型，聊天就按该模型的路由发出；没有单独映射的会话则回落到 Magpie Agents
  页面里选中的模型。

模型目录是**按会话/应用启动缓存**的：改了映射或换了模型，需要完全退出 Devin 再打开（只开新会话
有时不够）。

## 安装（一次性）

1. 安装 Magpie 插件（Agents 页面里的卡片与模型选择）：

   ```
   magpie plugin add github:Tangerine-Living/magpie-agent-devin-bridge
   ```

   从本地目录安装也可以：
   `magpie plugin add "D:\path\to\magpie-devin\plugin"`。

2. 运行一次安装器（插件目录里的 `install.js`）。它会把桥接启动起来、写好 Devin 的
   `devin.acp.agentEnv`、在 `%APPDATA%\devin\config.json` 挂一个 **SessionStart** 钩子，并生成
   MITM 证书：

   ```
   node "D:\path\to\magpie-devin\plugin\install.js" install
   ```

   npm / Magpie 安装的插件位于 `%USERPROFILE%\.config\magpie\plugins\node_modules\magpie-agent-devin-bridge\`。
   只需要执行一次；之后桥接随 Devin 的会话启动，不用再管。

3. 在 Magpie → **Agents** 里找到 **Devin · Magpie Bridge**，选择模型或路由组
   （例如 `group/group`）。Magpie 会把选择写进
   `%USERPROFILE%\.config\magpie-devin-bridge\connection.json`。命令行也可以：
   `magpie "Devin · Magpie Bridge" <模型 id>`。

4. 完全退出 Devin 再打开（或新开一个会话）。

安装一次之后，**桥接的生命周期跟着 Devin 走**：Devin 每次开始会话时 SessionStart 钩子会检查
8788，没在跑就以隐藏窗口启动它；Devin 退出 10 分钟后桥接自行退出。没有登录项、没有服务、没有
额外常驻进程。Magpie 只需照常开着（它本来就要为模型提供网关）。

### 为什么不是纯插件

Magpie 的 agent 插件运行在一个只允许导入同目录文件的沙箱里，不能读写文件、不能启动进程，
所以插件只负责“卡片 + 模型选择”（Magpie 替它写 `connection.json`）。真正跑协议转换的桥接由
Devin 自己的 SessionStart 钩子带起来——这样它跟着 Devin 启停，而不是常驻。

### 证书与代理

安装器会在 `%USERPROFILE%\.config\magpie-devin-bridge\certs\` 生成一套本地 CA + 叶子证书，并把
CA 装进当前用户的根证书库；Devin 的 `http.proxy` 指到 `127.0.0.1:7450`、`http.proxyStrictSSL`
关掉，`devin-cli` 用 `SSL_CERT_FILE` 信任这套 CA。`uninstall` 会还原这些设置。

## 日常使用

- 换模型：直接在下拉菜单里选；或在 Magpie → Agents 里换默认模型/路由组（新会话生效）。
- 看状态：

  ```bash
  node "<plugin dir>/install.js" status
  ```

- 临时停用：`install.js uninstall`（还原 Devin 设置、移除钩子）。想彻底移除再
  `magpie plugin rm magpie-agent-devin-bridge`。

## 配置

`%USERPROFILE%\.config\magpie-devin-bridge\config.json`：

```json
{
  "listen": "127.0.0.1:8788",
  "mitmPort": 7450,
  "magpie": "http://127.0.0.1:3425/v1",
  "key": "",
  "model": "guanxingyun/deepseek-v4-1-flash",
  "models": {
    "*": "guanxingyun/deepseek-v4-1-flash",
    "swe-1-6-fast": "guanxingyun/deepseek-v4-1-flash",
    "claude-sonnet-5.5": "guanxingyun/claude-opus-5"
  },
  "exposedModels": ["guanxingyun/deepseek-v4-1-flash", "guanxingyun/claude-opus-5"]
}
```

- `model`：默认模型（Magpie `/v1/models` 里的 id）或路由组（如 `group/group`）。
  Magpie 在 Agents 页面选择的模型会覆盖它（写进 `connection.json`）。
- `models`：Devin 模型 id → Magpie 模型 id 的映射，`*` 是兜底。
- `key`：留空即可；本机回环访问 Magpie 不要求密钥。
- `exposedModels`：本地会话菜单里展示的 Magpie 模型；缺省取自 `models` 的值。

编辑器聊天菜单的映射在 `anybridge-config/`：

- `model-map.json`：`slots[]` 把真实 Devin 模型 UID 映射到 Magpie 模型，
  `displayName: "前缀/模型"`；`slotVisibilityMode: "mapped"` 表示只显示已映射项。
- `providers.json`：Magpie 供应商（`http://127.0.0.1:3425/v1`）。

安装器写入 Devin 的两处配置：

`%APPDATA%\devin\User\settings.json` —— `devin.acp.agentEnv`（`WINDSURF_API_SERVER_URL`、
`HTTP(S)_PROXY`、`SSL_CERT_FILE`、`NO_PROXY`）以及 `http.proxy` / `http.proxyStrictSSL` /
`http.proxySupport`。

`%APPDATA%\devin\config.json` —— 一条 SessionStart 钩子运行 `ensure-bridge.js`。

原 settings.json 完整备份在 `%USERPROFILE%\.config\magpie-devin-bridge\settings-backup.json`，
`uninstall` 原样写回，并只摘掉我们自己那条 SessionStart（其它钩子原样保留）。

## 日志与排查

- 桥接日志：`%USERPROFILE%\.config\magpie-devin-bridge\bridge.log`
- 是否在跑：`node "<plugin dir>/install.js" status`，或 `curl http://127.0.0.1:8788/`
- MITM 是否生效：日志里出现 `[mitm] tls server.codeium.com` 与
  `GetUserStatus via AnyBridge unlockModels -> N changes`。
- Devin 的 Agent 日志：`%APPDATA%\devin\cli\logs\`

| 现象 | 处理 |
| :--- | :--- |
| Devin 报 “Connection error, send a message to continue retrying” | 桥接没起来。看 `bridge.log`；`install.js install` 再试一次，确认 8788 没被别的程序占用。 |
| Devin 要求登录 / “No Devin API key available” | `devin.acp.agentEnv` 没生效。确认 `settings.json` 里键名是 `devin-cli`，重启 Devin。 |
| 模型菜单里还是 Devin 原生模型 | 旧会话缓存了模型目录；完全退出 Devin 再开。 |
| 菜单每个模型一个组 | `model-map.json` 改了但没重启 Devin；组名来自 traits，缓存不刷新。 |
| 第一句话报错，第二条就正常 | Devin 在注入环境变量前就启动了 agent；重启一次 Devin 即可。 |
| 回答被截断 / 工具调用缺失 | 上游模型不支持 function calling。换一个支持工具调用的模型或路由组。 |
| Magpie 报 “模型不存在” | 模型 id 写错，用 `curl http://127.0.0.1:3425/v1/models` 核对。 |

## 范围与限制

- 接管 **Devin 的 agent 对话**（ACP `GetChatMessage`）和 **编辑器聊天的模型目录**；云 Devin
  （`wss://app.devin.ai`）与计费/账号请求仍走官方链路。
- Devin 的系统提示词、工具集、规则、skills 全部保留；只是把推理换成 Magpie 的模型。
- 思考流映射到 `delta_thinking`；历史对话里的 thinking 不再回传上游。
- 用量以 Devin 侧显示为准；真正的计费与统计在 Magpie。
- 8788 只绑定 `127.0.0.1`；7450 的 MITM 也只用于本机代理。

## 目录

```
plugin/
  agent.js                Magpie 卡片 + 模型选择（沙箱内，无 I/O）
  bridge.js               桥接服务器（8788 ACP + 7450 MITM，零依赖）
  install.js              安装 / 状态 / 卸载 / 重启 / 钩子管理
  ensure-bridge.js        SessionStart 钩子：按需拉起桥接
  devin-settings.js       Devin settings.json 的备份 / 写入 / 还原
  devin-registry.js       Devin 本地 ACP agent 注册
  anybridge/              模型目录改写（unlockModels：重命名 / 解锁 / 分组）
  anybridge-config/       编辑器菜单的槽位与供应商配置
  config.example.json

仓库里的 bridge/ 是同一份源码；`node build.js` 同步进 plugin/ 并内联图标。
```