# Devin · Magpie Bridge

让 **Devin 桌面版**的本地会话直接使用 Magpie 中配置的模型与路由组。模型菜单按供应商前缀分组，选中即用；不需要登录 Devin，也不消耗 Devin 额度。

**Windows (x64)** 上已实机验证可用；**macOS (Apple Silicon / Intel)** 已提供实现，但尚未实机验证（实验性）。
Cloud 会话不受影响，仍走 Cognition 云端。

---

## 特性

- **本地会话接管**：Devin 的本地 agent（`devin-cli`）通过 `127.0.0.1:8788` 使用 Magpie 的模型，登录、工具、规则、skills 全部保留。
- **模型菜单同步**：Magpie 里的模型会出现在 Local 会话的模型列表里，按 `ccx / guanxingyun / cline …` 前缀分组，选中哪个就用哪个。
- **无感代理接管**：接入时自动写入 Devin 的代理与证书设置，断开连接或卸载时完整还原。
- **本机回环**：流量只经过 `127.0.0.1`，证书在本机生成，不经过任何外部中转。

---

### 安装方式

在 Magpie → **Plugins** 添加仓库地址安装：

```text
github:Tangerine-Living/magpie-agent-devin-bridge
```

---

## 安装与快速上手

### 前置条件

- 已安装 **Devin**、**Magpie** 与 **Node.js 18+**（安装器与会话钩子使用）。
- Magpie 中已配置至少一个可用模型或路由组。

### 步骤

1. **运行一次安装器**（生成证书、写入 Devin 配置、挂上 SessionStart 钩子）：

   Windows (PowerShell)：
   ```powershell
   node "$env:USERPROFILE\.config\magpie\plugins\node_modules\magpie-agent-devin-bridge\install.js" install
   ```

   macOS (Terminal) —— **实验性，尚未实机验证**：
   ```bash
   node "$HOME/.config/magpie/plugins/node_modules/magpie-agent-devin-bridge/install.js" install
   ```

   - **Windows**：首次运行会安装本机 CA（证书确认窗口点「是」）。
   - **macOS**：首次运行会把本机 CA 加入登录钥匙串，系统会弹窗要求授权；若没有弹窗，按终端提示执行一次
     `security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db "<CA 路径>"`。
     该平台尚未实机验证；遇到问题请附 `install.js status` 与 `~/.config/magpie-devin-bridge/bridge.log` 反馈。

2. **在 Magpie 中选择模型**：
   打开 Magpie → **Agents** → **Devin · Magpie Bridge**，打开「接入」并选择模型或路由组。

3. **重启 Devin**（或完全退出后重开），新开一个 **Devin Local Session**。
   点开模型选择器，就能看到按前缀分组的 Magpie 模型。模型目录按会话缓存，旧会话不会自动刷新。

---

## 常用命令

| 操作 | 命令 |
| :--- | :--- |
| 查看状态 | `node "<插件目录>\install.js" status` |
| 重启桥接 | `node "<插件目录>\install.js" restart` |
| 停用并还原 Devin 设置 | `node "<插件目录>\install.js" uninstall` |

- **断开连接**：在 Magpie 的 Agents 页面关闭开关，或执行
  `magpie "Devin · Magpie Bridge" default`；Devin 的代理与证书设置会自动还原。
- **重新接入**：`magpie "Devin · Magpie Bridge" <模型 id>`，或在 Agents 页面选模型。

---

## 架构与工作流程

```text
Devin 桌面版
 ├─ 本地 agent (devin-cli, ACP) ──► 127.0.0.1:8788（明文 HTTP）
 │                                      │
 └─ 编辑器界面 ──► 127.0.0.1:7450（本地代理 / MITM，只改写模型目录）
                                        ▼
                                  bridge.js ──[OpenAI 协议]──► Magpie 网关 (127.0.0.1:3425)
                                                                   │
                                                                   ▼
                                                          Magpie 中的模型 / 路由组
```

- **8788**：本地 agent 只认 `WINDSURF_API_SERVER_URL`，桥接在这里实现它的 Connect-RPC 接口，并把对话转成 Magpie 的 OpenAI 请求。
- **7450**：界面自己的聊天/模型目录直连 `server.codeium.com`，只能通过 `http.proxy` 拦下来；桥接在这里只改写模型目录，其它流量原样转发。Cloud 会话只是路过这一跳，不被改写。
- **配置目录**：Windows `%USERPROFILE%\.config\magpie-devin-bridge\`，macOS `~/.config/magpie-devin-bridge/`
  （`config.json`、`connection.json`、`certs/`、`bridge.log`）。
- **桥接生命周期**：Devin 每次开始会话时由 SessionStart 钩子按需拉起；Devin 退出后自动结束，没有常驻服务。

---

## 排查

| 现象 | 处理 |
| :--- | :--- |
| 菜单里还是原生模型 | 模型目录按会话缓存：完全退出 Devin 再打开，或新开 Local 会话。 |
| Devin 连不上 / 一直重试 | 看 `bridge.log`；执行 `install.js status`，确认 8788 没被占用。 |
| 打开「接入」后没反应 | 确认安装器已运行（钩子存在）、Devin 已重启。 |
| 断开后配置没还原 | 关闭开关后等约 5 秒；仍不还原时执行 `install.js uninstall`。 |
| macOS（实验性）：菜单空白 / 证书报错 | 本机 CA 没被信任：重新运行安装器，或执行 README 里的 `security add-trusted-cert`。 |
| macOS（实验性）：钩子没启动桥接 | 确认安装时用的是 Node 18+；钩子记录的是安装时的 node 绝对路径；Devin.app 路径不同时用 `DEVIN_CLI` 指定。 |

---

## 开源协议

本项目遵循 [MIT License](LICENSE)。`anybridge/` 下的模型目录改写模块来自 [AnyBridge](https://github.com/soulvon/AnyBridge)（MIT License）。