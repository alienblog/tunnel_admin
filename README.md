# TunnelAdmin

<p align="center">
  <img src="assets/logo.png" width="128" alt="TunnelAdmin Logo"/>
</p>

[English](readme_en.md) | 简体中文

基于 Web 的 SSH 连接管理器 + MCP Server。浏览器里管理主机、开终端、传文件、建隧道；AI Agent 通过 MCP 协议（Streamable HTTP）直接操作你的服务器——**agent 首次连接每台主机都需要你在网页上确认**（human-in-the-loop 审批），批准后可选择「始终信任」免审批直连。

> **纯 Vibe Coding 项目**：本项目全部代码由 AI 驱动开发（Oh My Pi + DeepSeek V4 Flash 模型），
> 人工仅提供需求描述与验收反馈。Logo 由豆包 AI 生成（assets/logo.png）。

## 功能

| 模块 | 能力 |
|---|---|
| Web 终端 | 多标签/分屏（VSCode 编辑器组模型，**第一层 tab 同样可拖拽分屏/合并**）、**工具页可拖到右缘停靠为固定右栏**（可折叠/移回/**拖动调宽**）、拖拽停靠（**布局重组零重连**）、断线**自动重连**（指数退避，历史不丢）、ws 断线补发恢复、tmux 会话持久（刷新/断连恢复）、`clear` 不清屏（滚动到顶部）、Ctrl+F 搜索、命令补全、多行粘贴确认、主题预设、会话录制回放、连接状态徽标 |
| 主机管理 | 分组/标签/备注（**自由输入+下拉选择**）、**凭据管理**（单独保存用户名/密码/私钥，设置主机时下拉引用，更新全量生效）、**右键菜单克隆主机**、凭据 AES-256-GCM 加密落盘、每主机信任开关、侧栏**双击**打开终端、编辑弹窗模态化（ESC/按钮关闭） |
| SFTP 文件管理 | 目录浏览、拖拽上传（目录递归/进度条）、下载（流式+进度）、**双击文本编辑**（Ctrl+S 保存）、复制/剪切/粘贴、打包下载（tar 流式）、权限修改、文本预览、传输管理器（进行中/已完成，桌面端下载后📂一键定位文件） |
| 端口转发 | 远程转发为主：把目标内网端口暴露到部署服务器端口 |
| MCP Server | 独立监听端口可配（`TUNNELADMIN_MCP_PORT`）、接入提示词**动态生成**（地址/端口/令牌，多令牌可选），16 个工具：`ssh_list_hosts` / `ssh_connect` / `ssh_exec`（支持后台任务）/ `ssh_read_file` / `ssh_write_file` / `ssh_list_dir` / `ssh_stat` / `ssh_session_info` / `ssh_disconnect` / `ssh_job_status` / `ssh_tail`（流式跟踪）/ `ssh_tail_poll` / `ssh_tail_stop` / `ssh_port_forward` / `ssh_list_forwards` / `ssh_stop_forward`；会话保持 cwd，命令超时与输出截断 |
| 危险命令规则 | 可配置正则规则（拦截/审批），如 `rm -rf /`、`mkfs` 默认拦截 |
| 共享会话 | MCP 建立的连接实时出现在 Web 终端（🤖 标签），点击即可在同一连接上打开自己的终端同时操作；agent 每条命令与输出实时镜像到该视图 |
| 连接审批 | agent 连接/危险命令请求实时推送 Web 弹窗，批准/拒绝/记住信任，60s 超时自动拒绝 |
| 监控 | 状态栏实时指标（CPU/内存/磁盘/网络）、近 3 分钟趋势 sparkline、告警阈值配置 |
| 审计日志 | MCP 命令全量记录（命令/退出码/耗时），Web 终端记录会话级 |
| 桌面客户端 | Electron 打包（Windows NSIS 安装器/便携版），内嵌 server、免登录、数据目录隔离 |

## 技术栈

- 后端：Node.js 22+ / TypeScript / Fastify 5 / ssh2 / better-sqlite3 / @modelcontextprotocol/sdk
- 前端：React 19 / Vite / xterm.js (@xterm/xterm 6) / Tailwind 4 / zustand
- 桌面：Electron 33 / electron-builder（Windows / Linux）
- 安全：密码登录（httpOnly cookie，可免登录模式）、MCP Bearer token、AES-256-GCM 凭据加密、主密钥 0600 文件

## 快速开始

```bash
npm install

# 开发模式（server :8080 + web :5173 热更新）
npm run dev

# 生产构建并启动（server 托管 web/dist）
npm run build
npm start
```

首次启动会在 `data/` 下生成：
- `master.key` — AES 主密钥（0600）
- `password.hash` — Web 登录密码哈希；**初始密码打印在启动日志中**（可在设置页修改）

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 8080 | 监听端口 |
| `HOST` | 0.0.0.0 | 监听地址 |
| `TUNNELADMIN_PASSWORD` | 自动生成 | Web 登录密码 |
| `TUNNELADMIN_AUTH` | password | `none` = 免登录（桌面客户端用） |
| `TUNNELADMIN_MASTER_KEY` | 自动生成 | 64 位 hex 主密钥（覆盖密钥文件） |
| `TUNNELADMIN_DATA_DIR` | ./data | 数据目录 |
| `TUNNELADMIN_APPROVAL_TIMEOUT` | 60000 | 审批超时（ms） |
| `TUNNELADMIN_MCP_TIMEOUT` | 30000 | MCP 命令默认超时（ms） |
| `TUNNELADMIN_MCP_OUTPUT_LIMIT` | 65536 | MCP 命令输出截断（字节） |

## 桌面客户端（Windows）

```powershell
# Windows 侧一键打包（建议管理员运行；自动下载便携 Node/代理探测）
scripts\build-win.ps1
# 或双击 scripts\build-win.bat
```

产物：`release\TunnelAdmin-<version>-x64.exe`（安装器）+ `.zip`（便携版）。
桌面版自动免登录（`TUNNELADMIN_AUTH=none`），数据存于 `%APPDATA%\tunneladmin`。

## MCP 接入 AI Agent

1. Web 界面 → 设置 → MCP → 新建 Token（或「📋 复制提示词」一键生成接入说明）
2. Agent 配置示例（Claude Code / Cursor 的 `.mcp.json`）：

```json
{
  "mcpServers": {
    "tunneladmin": {
      "type": "http",
      "url": "https://你的服务器:8080/mcp",
      "headers": { "Authorization": "Bearer ta_xxxxx" }
    }
  }
}
```

3. Agent 调用 `ssh_connect` 时，你的浏览器会弹出确认框；批准后返回 `sessionId`，后续 `ssh_exec` / 文件操作复用该会话并保持工作目录。

## 安全说明

- 公网部署务必置于 HTTPS 反向代理后（如 Caddy：`caddy reverse-proxy --from your.domain --to :8080`）
- MCP endpoint 强制 Bearer token 认证
- 凭据全量加密落盘；主密钥文件权限 0600，建议备份
- 单用户设计；多用户/RBAC 不在当前范围

## 目录结构

```
server/src/
  index.ts          入口：Fastify + WS + MCP + 静态托管
  config.ts         配置加载 / 密码与 cookie 签名
  crypto.ts         AES-256-GCM
  db.ts             SQLite schema
  approval.ts       agent 连接审批服务
  events.ts         WebSocket 事件总线
  ws.ts             终端桥（xterm ↔ ssh2 流，断连检测 + tmux 持久）
  ssh/manager.ts    连接池（跳板机链、keepalive）
  routes/           auth / hosts / tokens / misc / sftp / forward
  mcp/              MCP server（Streamable HTTP 无状态模式）+ 工具集
web/src/
  pages/            Terminals（外层 tab：主机/编辑器/设置/传输/审计）/ tabs / Login
  components/       TerminalView (xterm) / SideBar / ReplayOverlay / ApprovalModal
  store.ts          zustand（布局树 / 工作区持久化 / 传输记录）
desktop/            Electron 主进程 + server 启动器
scripts/            Windows 打包脚本（build-win.ps1 / bat）
```

## 设计要点

- **Web 与 MCP 共享连接核心**：连接配置、凭据解密、跳板机逻辑只有一份
- **MCP 无状态模式**：每个请求新建 Server + transport（SDK Protocol 单实例只支持单 transport），会话状态存进程级共享 Map
- **审批链路**：MCP 请求挂起 → WS 推送弹窗 → 用户批准 → 连接建立，超时自动拒绝
- **共享会话**：同一 SSH 连接可开多 channel——MCP 的 exec 与用户在 Web 附加的交互 shell 并行（ssh2 多 channel），agent 活动经 `exec:activity` 事件实时镜像；终端协议按 `streamId` 区分多视图
- **终端保活**：外层/内层 tab 切换不卸载终端（CSS 隐藏保持挂载）；SSH 断连自动重连（5s→30s 退避）且 tmux 现场不丢
- **远程转发为主**：部署在服务器上时「本地转发」的端口开在服务器上浏览器够不着，故主推远程转发；本地转发仅服务端进程可用

## 开发统计（Vibe Coding 用量）

<!-- usage -->
| 会话 | 输入 | 输出 | 缓存读 | 成本 |
|---|---|---|---|---|
| 1 | 1,411,009 | 1,875,692 | 883,219,712 | $3.20 |
| 2 | 23,393 | 2,512 | 87,680 | $0.00 |
| **累计（2 个会话）** | **1,434,402** | **1,878,204** | **883,307,392** | **$3.20** |
<!-- /usage -->

> 本表由 `node scripts/update-usage.cjs` 自动生成（提交前运行）：统计 `~/.omp/agent/sessions/` 下 tunneladmin 会话（`-sources-tunneladmin` 或 `home-tunneladmin-*`），每个会话文件 = 一次会话；新会话自动累加进「累计」。
