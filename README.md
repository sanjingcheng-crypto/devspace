# DevSpace 一键远程访问本机（MCP + ChatGPT）

把本机文件系统通过 [DevSpace](https://github.com/waishnav/devspace) MCP 暴露给 ChatGPT 网页版，
并内置「桌面截图」与「命令执行」两个增强能力。配套脚本一键安装、一键重启、登录自启。

> 适用：Windows + WorkBuddy 托管 Node（22.x）。DevSpace 固定版本 `@waishnav/devspace@1.0.8`。

## 目录结构

```
install-devspace.mjs        # 一键安装器：装 devspace、打补丁、生成 ownerToken、起隧道+serve
start-devspace-serve.mjs    # 只重启 serve（保留 token，加载现有 config.json）
start-all.mjs               # 开机自启：清理旧隧道 -> 起新隧道 -> 回写 URL -> 起 serve
devspace-autostart.vbs      # 登录自启入口（放「启动」文件夹，调用 start-all.mjs）
.gitignore                  # 已排除 auth.json / config.json / *.log / .workbuddy 等敏感/易变文件
```

## 快速开始

### 1. 首次安装（换机器时）
用 WorkBuddy 的 Bash 以管理员运行：

```bash
node install-devspace.mjs --root "C:\Jim\你的项目" --tunnel-url "https://xxx.trycloudflare.com"
# 或本机用、不建隧道：
node install-devspace.mjs --root "C:\Jim\你的项目" --local
```

安装器会：
- 确保 Git Bash 可被 DevSpace 找到（无则把 WorkBuddy 自带 PortableGit 挂成 junction）；
- 安装 `@waishnav/devspace@1.0.8` 到 `~/.devspace-host/`；
- 给 `server.js` / `pi-tools.js` 打补丁（见下方「已规避的坑」）；
- 生成 `ownerToken` 写入 `~/.devspace/auth.json`（**仅本机，不入库**）；
- 起 cloudflared 临时隧道并回写 `config.json` 的 `publicBaseUrl`；
- 以 **full 模式** 启动 serve（含 `ls`/`grep`/`glob`）。

### 2. 日常重启 serve（机器重启 / serve 崩了）
```bash
node start-devspace-serve.mjs
```

### 3. 开机自启（登录即自动恢复）
把 `devspace-autostart.vbs` 复制到「启动」文件夹：
```
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\
```
（注意 VBS 里写死了本机的 Node 路径与仓库路径，换机器请相应修改。）

## 在 ChatGPT 里连接

1. ChatGPT → 设置 → 连接器（Connectors）→ 添加 MCP；
2. 类型：**Streamable HTTP**；
3. URL：`https://<你的隧道域名>/mcp`（本地模式用 `http://127.0.0.1:7676/mcp`）；
4. 鉴权：OAuth，用户名随意，**密码填 `ownerToken`**（见 `~/.devspace/auth.json`）；
5. 开**新对话**让 ChatGPT 重新拉取工具列表。

可用工具：`open_workspace, read, write, edit, grep, glob, ls, bash, screenshot`。
其中 `screenshot` 会返回本机桌面截图图片；`bash` 已锁定为可靠的 Git Bash。

## 已规避的坑（补丁固化在安装器内，重装自动带上）

| 问题 | 修复 |
|---|---|
| ChatGPT 报 `INVALID_ARGUMENT`（workspaceId 必填） | `workspaceId` 改可选，自动复用上次 `open_workspace` 的工作区 |
| `open_workspace` 的 `mode` 拒绝 `"sandbox"` | 放宽枚举为任意字符串 |
| 默认 minimal 模式不注册 `ls`/`grep`/`glob`，无法列目录 | 强制 `DEVSPACE_TOOL_MODE=full` |
| bash 工具在开机自启下解析到跑不起来的占位 bash，命令一律 `(no output) exit 1` | `pi-tools.js` 显式锁定 Git Bash |
| git 报 `dubious ownership` 拦截 `git status` | 启动脚本顺手 `git config --global --add safe.directory '*'` |
| DevSpace 硬编码找 `C:\Program Files\Git` | 无 Git for Windows 时把 PortableGit junction 过去 |

## 已知限制

- **临时隧道 URL 每次重启都会变**（quick tunnel 特性）。固定域名需改用 Cloudflare named tunnel +
  自有域名，把 `config.publicBaseUrl` 锁成固定值。届时开机自启才真正「设好就忘」。
- 补丁打在 `~/.devspace-host/node_modules` 内，`npm` 升级 devspace 后会失效，需重跑安装器。

## 安全说明

- `ownerToken` 等价于本机文件系统完整访问权，**只在 `~/.devspace/` 本地保存，绝不入库**。
- `auth.json` / `config.json` / `*.log` / `.workbuddy/` 已在 `.gitignore` 排除。
- 公共仓库分享的是「安装/启动脚本 + 补丁逻辑」，不含任何凭据。
