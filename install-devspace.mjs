#!/usr/bin/env node
/**
 * install-devspace.mjs —— DevSpace MCP 一键安装器（Windows / WorkBuddy 托管 Node）
 *
 * 解决本机踩过的所有坑：
 *   1) Git Bash 找不到  -> 若 C:\Program Files\Git 不存在，则把 WorkBuddy 自带的
 *      PortableGit 通过 NTFS junction 挂到 C:\Program Files\Git（DevSpace 硬编码找这个路径）。
 *   2) workspaceId 必填导致 ChatGPT 报 INVALID_ARGUMENT -> 给 server.js 打补丁，
 *      workspaceId 变可选，自动复用上一次 open_workspace 的工作区。
 *   3) open_workspace 的 mode 只认 checkout/worktree，拒绝 "sandbox" -> 放宽成任意字符串。
 *   4) devspace serve 的孤儿子进程一直占用 7676 -> 启动时先按"真实监听 PID"杀干净再起。
 *   5) 路径用正斜杠（本脚本只做安装，使用层面提醒在文末）。
 *   6) bash 工具在开机自启/托管环境下解析到跑不起来的占位 bash，导致命令一律
 *      "(no output) Command exited with code 1" -> 给 pi-tools.js 打补丁，显式锁定 Git Bash。
 *   7) git 仓库属主与当前用户不一致触发 "dubious ownership"，bash 里的 git 命令被拒 ->
 *      start-devspace-serve.mjs 每次启动顺手 git config --global --add safe.directory '*'。
 *
 * 用法（在另一台机器上，用 WorkBuddy 的 Bash 跑，需管理员权限）：
 *   node install-devspace.mjs                         # 交互询问项目根目录
 *   node install-devspace.mjs --root "C:\Jim\proj"    # 指定项目根
 *   node install-devspace.mjs --root "C:\Jim\proj" --tunnel-url "https://xxx.trycloudflare.com"
 *        # 已自备隧道时直接传入，供 ChatGPT 远程访问
 *   node install-devspace.mjs --root "C:\Jim\proj" --local
 *        # 仅本机 WorkBuddy 通过 127.0.0.1 访问，不建隧道
 *
 * 版本固定为 @waishnav/devspace@1.0.8（补丁文案与该版本逐字对应）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execSync, spawn } from "node:child_process";
import readline from "node:readline";

const HOME = os.homedir();
const log = (...a) => console.log("•", ...a);
const warn = (...a) => console.warn("⚠", ...a);
const ok = (...a) => console.log("✅", ...a);
const fail = (...a) => console.error("❌", ...a);

// ---------- 参数 ----------
const argv = process.argv.slice(2);
let ROOT = null;
let TUNNEL_URL = null;
let LOCAL_ONLY = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--root") ROOT = argv[++i];
  else if (argv[i] === "--tunnel-url") TUNNEL_URL = argv[++i];
  else if (argv[i] === "--local") LOCAL_ONLY = true;
}
const DEVSPACE_VERSION = "1.0.8";

// ---------- 1. 定位 WorkBuddy 托管 Node / npm / PortableGit ----------
function findManagedNode() {
  const base = path.join(HOME, ".workbuddy", "binaries", "node", "versions");
  if (!fs.existsSync(base)) return null;
  const vers = fs.readdirSync(base).filter((v) => /^[\d.]+$/.test(v)).sort().reverse();
  for (const v of vers) {
    const node = path.join(base, v, "node.exe");
    if (fs.existsSync(node)) return { node, verDir: path.join(base, v) };
  }
  return null;
}
const managed = findManagedNode();
if (!managed) {
  fail("找不到 WorkBuddy 托管 Node（~/.workbuddy/binaries/node/versions/*/node.exe）。请先确认 WorkBuddy 已安装。");
  process.exit(1);
}
const NODE = managed.node;
log("托管 Node:", NODE);

const NPM_CLI = path.join(managed.verDir, "node_modules", "npm", "bin", "npm-cli.js");
const PORTABLE_GIT = path.join(HOME, ".workbuddy", "vendor", "PortableGit");

// ---------- 2. 询问项目根目录 ----------
async function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim()); }));
}
if (!ROOT) {
  const def = process.cwd();
  const a = await ask(`请输入要让 DevSpace 暴露的项目根目录（默认 ${def}）：`);
  ROOT = a || def;
}
ROOT = path.resolve(ROOT);
if (!fs.existsSync(ROOT)) {
  fail("项目根目录不存在:", ROOT);
  process.exit(1);
}
ok("项目根目录:", ROOT);

// ---------- 3. 确保 Git Bash 可被 DevSpace 找到 ----------
const GIT_DIR = "C:\\Program Files\\Git";
const gitBash = path.join(GIT_DIR, "bin", "bash.exe");
if (fs.existsSync(gitBash)) {
  ok("已检测到 Git Bash:", gitBash);
} else if (fs.existsSync(PORTABLE_GIT)) {
  try {
    execSync(`cmd /c mklink /J "${GIT_DIR}" "${PORTABLE_GIT}"`, { stdio: "ignore" });
    ok("已用 NTFS junction 把", GIT_DIR, "->", PORTABLE_GIT);
  } catch (e) {
    warn("创建 junction 失败（可能没管理员权限）。请手动以管理员运行：");
    warn(`  cmd /c mklink /J "${GIT_DIR}" "${PORTABLE_GIT}"`);
  }
} else {
  warn("既无 Git for Windows 也无 WorkBuddy PortableGit。请先安装 Git for Windows，或确认 WorkBuddy 自带的 PortableGit 存在。");
}
const gitBin = path.join(PORTABLE_GIT, "bin");

// ---------- 4. 安装 devspace@1.0.8 ----------
const HOST_DIR = path.join(HOME, ".devspace-host");
fs.mkdirSync(HOST_DIR, { recursive: true });
const pkgDir = path.join(HOST_DIR, "node_modules", "@waishnav", "devspace");
const serverJs = path.join(pkgDir, "dist", "server.js");
const cliJs = path.join(pkgDir, "dist", "cli.js");

if (fs.existsSync(serverJs)) {
  log("devspace 已安装于", pkgDir, "（跳过 npm install）");
} else {
  log("正在安装 @waishnav/devspace@" + DEVSPACE_VERSION + " ...");
  try {
    execSync(`"${NODE}" "${NPM_CLI}" install @waishnav/devspace@${DEVSPACE_VERSION}`, {
      cwd: HOST_DIR, stdio: "inherit",
    });
  } catch (e) {
    fail("npm install 失败。可手动在", HOST_DIR, "执行：npm install @waishnav/devspace@" + DEVSPACE_VERSION);
    process.exit(1);
  }
}
if (!fs.existsSync(serverJs)) {
  fail("安装后仍未找到", serverJs);
  process.exit(1);
}
ok("devspace", DEVSPACE_VERSION, "已就绪:", cliJs);

// ---------- 5. 写配置 + ownerToken ----------
const cfgDir = path.join(HOME, ".devspace");
fs.mkdirSync(cfgDir, { recursive: true });
const ownerToken = crypto.randomBytes(32).toString("base64url");
fs.writeFileSync(path.join(cfgDir, "auth.json"), JSON.stringify({ ownerToken }, null, 2));
// 合并根目录：保留已存在的 allowedRoots（如后加的 weixin_video_skill），避免重跑被覆盖成单根
let existingRoots = [];
const existingCfg = path.join(cfgDir, "config.json");
if (fs.existsSync(existingCfg)) {
  try { existingRoots = JSON.parse(fs.readFileSync(existingCfg, "utf8")).allowedRoots || []; } catch { /* 损坏则忽略，下面用 ROOT 兜底 */ }
}
const allowedRoots = Array.from(new Set([ROOT, ...existingRoots])).filter(Boolean);
const config = {
  host: "127.0.0.1",
  port: 7676,
  allowedRoots,
};
if (TUNNEL_URL) config.publicBaseUrl = TUNNEL_URL.replace(/\/+$/, "");
fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify(config, null, 2));
ok("已写入配置:", path.join(cfgDir, "config.json"), "（ownerToken 已生成）");

// ---------- 6. 给 server.js 打补丁（规避 INVALID_ARGUMENT）----------
const PATCHES = [
  {
    name: "模块级 lastWorkspaceId",
    old: `const workspaceIdDescription = "Workspace to use. Reuse the current project's workspaceId.";`,
    new: `const workspaceIdDescription = "Workspace to use. Reuse the current project's workspaceId.";\nlet lastWorkspaceId = null;`,
  },
  {
    name: 'open_workspace mode 枚举放宽',
    old: `            mode: z
                .enum(["checkout", "worktree"])
                .optional()
                .describe("Defaults to checkout, which works in the actual directory. Use worktree for isolated or parallel Git work."),`,
    new: `            mode: z
                .string()
                .optional()
                .describe("Defaults to checkout, which works in the actual directory. Use worktree for isolated or parallel Git work."),`,
  },
  {
    name: "open_workspace 记录 lastWorkspaceId",
    old: `    }, async ({ path, mode, baseRef }, { _meta }) => {
        const startedAt = performance.now();
        const { workspace, agentsFiles, availableAgentsFiles, workspaceReused, includeBootstrapContext, } = await workspaces.openWorkspace({ path, mode, baseRef }, { conversationScopeId: openAiConversationScopeId(_meta) });`,
    new: `    }, async ({ path, mode, baseRef }, { _meta }) => {
        const startedAt = performance.now();
        const { workspace, agentsFiles, availableAgentsFiles, workspaceReused, includeBootstrapContext, } = await workspaces.openWorkspace({ path, mode, baseRef }, { conversationScopeId: openAiConversationScopeId(_meta) });
        lastWorkspaceId = workspace.id;`,
  },
  {
    name: "bash schema: workspaceId 可选",
    old: `                workspaceId: z
                    .string()
                    .describe(workspaceIdDescription),`,
    new: `                workspaceId: z
                    .string()
                    .optional()
                    .describe(workspaceIdDescription),`,
  },
  {
    name: "read schema: workspaceId 可选",
    old: `            workspaceId: z
                .string()
                .describe(workspaceIdDescription),`,
    new: `            workspaceId: z
                .string()
                .optional()
                .describe(workspaceIdDescription),`,
  },
  {
    name: "bash handler: 回退 lastWorkspaceId",
    old: `        }, async ({ workspaceId, workingDirectory, ...input }) => {
            const startedAt = performance.now();
            const workspace = workspaces.getWorkspace(workspaceId);`,
    new: `        }, async ({ workspaceId, workingDirectory, ...input }) => {
            if (workspaceId == null) workspaceId = lastWorkspaceId;
            if (!workspaceId) return { content: [{ type: "text", text: "No workspaceId provided and no workspace is currently open. Call open_workspace with the project path first." }], isError: true };
            const startedAt = performance.now();
            const workspace = workspaces.getWorkspace(workspaceId);`,
  },
  {
    name: "read handler: 回退 lastWorkspaceId",
    old: `    }, async ({ workspaceId, ...input }) => {
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const readPath = workspaces.resolveReadPath(workspace, input.path);`,
    new: `    }, async ({ workspaceId, ...input }) => {
        if (workspaceId == null) workspaceId = lastWorkspaceId;
        if (!workspaceId) return { content: [{ type: "text", text: "No workspaceId provided and no workspace is currently open. Call open_workspace with the project path first." }], isError: true };
        const startedAt = performance.now();
        const workspace = workspaces.getWorkspace(workspaceId);
        const readPath = workspaces.resolveReadPath(workspace, input.path);`,
  },
  {
    name: "注册 screenshot 桌面截图工具（宿主能力，不受 toolMode 限制）",
    old: `    return server;
}
export function createServer(config = loadConfig(), options = {}) {`,
    new: `    // ---- 桌面截图工具（宿主能力，不受 toolMode 限制）----
    const SCREENSHOT_PS_LINES = [
        'Add-Type -AssemblyName System.Windows.Forms',
        'Add-Type -AssemblyName System.Drawing',
        '$display = $env:DEVSPACE_SHOT_DISPLAY',
        'if ($display -eq "primary") {',
        '  $s = [System.Windows.Forms.Screen]::PrimaryScreen',
        '  $b = $s.Bounds',
        '} else {',
        '  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen',
        '}',
        '$bmp = New-Object System.Drawing.Bitmap([int]$b.Width, [int]$b.Height)',
        '$g = [System.Drawing.Graphics]::FromImage($bmp)',
        '$g.CopyFromScreen([int]$b.X, [int]$b.Y, 0, 0, $b.Size)',
        '$g.Dispose()',
        '$bmp.Save($env:DEVSPACE_SHOT_OUT, [System.Drawing.Imaging.ImageFormat]::Png)',
        '$bmp.Dispose()',
    ];
    registerAppTool(server, "screenshot", {
        title: "Capture desktop screenshot",
        description: "Capture a screenshot of this DevSpace host machine desktop and return it as an image. display='all' captures the entire virtual desktop across all monitors; display='primary' captures only the main monitor. Optional savePath also writes a copy into the workspace so it can be referenced as a file later.",
        inputSchema: {
            display: z.enum(["all", "primary"]).optional().describe("Which screen to capture. 'all' (default) = entire virtual desktop (all monitors); 'primary' = main monitor only."),
            workspaceId: z.string().optional().describe(workspaceIdDescription),
            savePath: z.string().optional().describe("Optional relative path in the workspace to also save the PNG (e.g. 'shots/desktop.png'). Requires a workspace to be open."),
        },
        outputSchema: { result: z.string() },
        annotations: { readOnlyHint: true, title: "Desktop screenshot" },
        ...toolWidgetDescriptorMeta(config, "shell"),
    }, async ({ display, workspaceId, savePath }) => {
        const startedAt = performance.now();
        const nodeOs = await import("node:os");
        const nodePath = await import("node:path");
        const nodeFs = await import("node:fs");
        const nodeCp = await import("node:child_process");
        const tmp = nodeOs.tmpdir();
        const psPath = nodePath.join(tmp, "devspace-screenshot.ps1");
        if (!nodeFs.existsSync(psPath)) {
            nodeFs.writeFileSync(psPath, SCREENSHOT_PS_LINES.join("\\n"), "utf8");
        }
        const outPath = nodePath.join(tmp, "devspace-screenshot-" + randomUUID() + ".png");
        const res = nodeCp.spawnSync("powershell.exe", [
            "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
            "-File", psPath,
        ], {
            env: { ...process.env, DEVSPACE_SHOT_OUT: outPath, DEVSPACE_SHOT_DISPLAY: display || "all" },
            timeout: 30000,
            windowsHide: true,
        });
        if (res.status !== 0 || !nodeFs.existsSync(outPath)) {
            const errMsg = (res.stderr ? res.stderr.toString() : "") || (res.error ? String(res.error) : "powershell exited " + res.status);
            return { content: [{ type: "text", text: "Screenshot failed: " + errMsg }], isError: true };
        }
        const buf = nodeFs.readFileSync(outPath);
        const content = [{ type: "image", data: buf.toString("base64"), mimeType: "image/png" }];
        let note = "";
        if (savePath) {
            const wsId = workspaceId || lastWorkspaceId;
            if (!wsId) {
                note = " (savePath ignored: no workspace open)";
            } else {
                try {
                    const ws = workspaces.getWorkspace(wsId);
                    const dest = workspaces.resolvePath(ws, savePath);
                    nodeFs.mkdirSync(nodePath.dirname(dest), { recursive: true });
                    nodeFs.copyFileSync(outPath, dest);
                    note = " Saved to: " + savePath;
                } catch (e) {
                    note = " (save failed: " + (e && e.message ? e.message : String(e)) + ")";
                }
            }
        }
        content.push({ type: "text", text: "Screenshot captured (" + buf.length + " bytes)" + note + "." });
        try { logToolCall(config, { tool: "screenshot", success: true, durationMs: Math.round(performance.now() - startedAt) }); } catch { /* ignore */ }
        return { content, structuredContent: { result: "Screenshot captured." } };
    });

    return server;
}
export function createServer(config = loadConfig(), options = {}) {`,
  },
];

let src = fs.readFileSync(serverJs, "utf8");
let applied = 0, skipped = 0;
for (const p of PATCHES) {
  // 先检查 new 是否已存在（幂等：已打过则跳过，避免重复声明/重复插入）
  if (src.includes(p.new)) {
    skipped++;
    log("补丁已存在（跳过）:", p.name);
  } else if (src.includes(p.old)) {
    src = src.replace(p.old, p.new);
    applied++;
    log("已打补丁:", p.name);
  } else {
    warn("补丁未匹配（可能版本不符）:", p.name);
  }
}
// 兜底：先把候选写到 .mjs 临时文件做语法检查（.mjs 才被 Node 正确识别为 ESM），
// 通过才覆盖原文件，避免写出坏 JS。注意不能用 .tmp 后缀——会被当成 CommonJS 误判。
const tmpJs = serverJs.replace(/\.js$/, "") + ".check.mjs";
fs.writeFileSync(tmpJs, src);
try {
  execSync(`"${NODE}" --check "${tmpJs}"`, { stdio: "ignore" });
  fs.renameSync(tmpJs, serverJs);
  ok(`server.js 补丁完成：应用 ${applied}，跳过 ${skipped}`);
} catch (e) {
  try { fs.unlinkSync(tmpJs); } catch {}
  fail("补丁后 server.js 语法检查失败，已中止，未修改原文件（请检查版本是否为 1.0.8）");
  process.exit(1);
}

// ---------- 6.5 给 pi-tools.js 打补丁（强制 bash 用可靠 Git Bash）----------
// 默认 getShellConfig 依赖启动进程的环境（ProgramFiles / PATH），开机自启(VBS)或托管环境
// 下可能解析到跑不起来的占位 bash，导致 ChatGPT 调 bash 工具一律 "(no output) exit 1"。
// 这里显式锁定 Git Bash，解析不到再退回默认逻辑。
const piToolsJs = path.join(pkgDir, "dist", "pi-tools.js");
const PI_PATCHES = [
  {
    name: "import existsSync + forcedShellPath 助手",
    old: `import { createBashTool, createEditTool, createFindTool, createGrepTool, createLsTool, createReadTool, createWriteTool, } from "@earendil-works/pi-coding-agent";
import { resolveAllowedPath } from "./roots.js";`,
    new: `import { createBashTool, createEditTool, createFindTool, createGrepTool, createLsTool, createReadTool, createWriteTool, } from "@earendil-works/pi-coding-agent";
import { resolveAllowedPath } from "./roots.js";
import { existsSync } from "node:fs";

// 强制使用可靠的 bash：devspace 默认的 getShellConfig 依赖启动进程的环境
// （ProgramFiles / PATH），在开机自启(VBS)或托管环境下可能解析到一个跑不起来的
// 占位 bash，导致 bash 工具一律 "(no output) Command exited with code 1"。
// 这里显式锁定 Git Bash（Windows 上最稳），解析不到再退回默认逻辑。
function forcedShellPath() {
  const candidates = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    process.env.USERPROFILE + "\\.workbuddy\\vendor\\PortableGit\\usr\\bin\\bash.exe",
  ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return undefined;
}`,
  },
  {
    name: "runShellTool 传入 shellPath",
    old: `export async function runShellTool(input, context) {
    const tool = createBashTool(context.cwd);`,
    new: `export async function runShellTool(input, context) {
    const tool = createBashTool(context.cwd, { shellPath: forcedShellPath() });`,
  },
];
if (fs.existsSync(piToolsJs)) {
  let psrc = fs.readFileSync(piToolsJs, "utf8");
  let pApplied = 0, pSkipped = 0;
  for (const p of PI_PATCHES) {
    if (psrc.includes(p.new)) { pSkipped++; log("pi-tools 补丁已存在（跳过）:", p.name); }
    else if (psrc.includes(p.old)) { psrc = psrc.replace(p.old, p.new); pApplied++; log("已给 pi-tools 打补丁:", p.name); }
    else { warn("pi-tools 补丁未匹配（可能版本不符）:", p.name); }
  }
  const pTmp = piToolsJs.replace(/\.js$/, "") + ".check.mjs";
  fs.writeFileSync(pTmp, psrc);
  try {
    execSync(`"${NODE}" --check "${pTmp}"`, { stdio: "ignore" });
    fs.renameSync(pTmp, piToolsJs);
    ok(`pi-tools.js 补丁完成：应用 ${pApplied}，跳过 ${pSkipped}`);
  } catch (e) {
    try { fs.unlinkSync(pTmp); } catch {}
    warn("pi-tools 补丁后语法检查失败，未修改原文件（请确认版本为 1.0.8）");
  }
} else {
  warn("未找到", piToolsJs, "——跳过 pi-tools 补丁");
}

// ---------- 7. 隧道（仅远程访问需要）----------
let publicBaseUrl = TUNNEL_URL || "";
if (!LOCAL_ONLY && !TUNNEL_URL) {
  let cf = null;
  try { cf = execSync("where cloudflared", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim().split("\n")[0]; } catch {}
  if (cf) {
    log("检测到 cloudflared，正在建立临时隧道 ...");
    const cfProc = spawn(cf, ["tunnel", "--url", "http://127.0.0.1:7676"], { stdio: ["ignore", "pipe", "ignore"] });
    const got = await new Promise((res) => {
      let buf = "";
      const t = setTimeout(() => res(null), 20000);
      cfProc.stdout.on("data", (d) => {
        buf += d.toString();
        const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m) { clearTimeout(t); res(m[0]); }
      });
    });
    if (got) { publicBaseUrl = got; ok("隧道已建立:", publicBaseUrl); }
    else warn("未能从 cloudflared 输出解析到隧道 URL，将使用本地模式。");
  } else {
    warn("未检测到 cloudflared，且未提供 --tunnel-url。将先用本地模式启动。");
    warn("如需 ChatGPT 远程访问：在另一窗口运行  cloudflared tunnel --url http://127.0.0.1:7676");
    warn("拿到 https://xxx.trycloudflare.com 后，重跑本脚本并加  --tunnel-url <该URL>");
  }
}
if (publicBaseUrl) {
  const c = JSON.parse(fs.readFileSync(path.join(cfgDir, "config.json"), "utf8"));
  c.publicBaseUrl = publicBaseUrl.replace(/\/+$/, "");
  fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify(c, null, 2));
}

// ---------- 8. 孤儿进程清理 + 启动 serve ----------
function killPort(port) {
  try {
    const out = execSync(`netstat -ano | findstr :${port}`, { stdio: ["ignore", "pipe", "ignore"] }).toString();
    const pids = new Set();
    for (const line of out.split("\n")) {
      if (/LISTEN/i.test(line)) {
        const cols = line.trim().split(/\s+/);
        const pid = cols[cols.length - 1];
        if (pid && /^\d+$/.test(pid)) pids.add(pid);
      }
    }
    for (const pid of pids) {
      try { execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" }); log("已结束占用", port, "的进程 PID", pid); }
      catch {}
    }
  } catch {}
}
killPort(7676);
await new Promise((r) => setTimeout(r, 1500));

const env = { ...process.env, PATH: gitBin + ";" + process.env.PATH };
if (publicBaseUrl) env.DEVSPACE_PUBLIC_BASE_URL = publicBaseUrl.replace(/\/+$/, "");
// 关键：full 模式才注册 ls/grep/glob，否则 ChatGPT 无法列目录（默认 minimal 会缺这三个工具）
env.DEVSPACE_TOOL_MODE = "full";
env.DEVSPACE_MINIMAL_TOOLS = "false";

const serveProc = spawn(NODE, [cliJs, "serve"], {
  cwd: HOST_DIR,
  env,
  detached: true,
  stdio: "ignore",
  windowsHide: true,
});
serveProc.unref();
await new Promise((r) => setTimeout(r, 6000));

// 验证监听
let listening = false;
try {
  const out = execSync("netstat -ano | findstr :7676", { stdio: ["ignore", "pipe", "ignore"] }).toString();
  listening = /LISTEN/i.test(out);
} catch {}
if (!listening) {
  warn("serve 似乎未监听 7676，请检查日志：", path.join(HOST_DIR, "serve.log"));
} else {
  ok("devspace serve 已在 127.0.0.1:7676 启动");
}

// ---------- 9. 输出使用说明 ----------
console.log("\n========================================");
console.log("🎉 DevSpace 安装完成");
console.log("========================================");
console.log("项目根目录 :", ROOT);
console.log("MCP 端点   :", publicBaseUrl ? `${publicBaseUrl.replace(/\/+$/, "")}/mcp` : "http://127.0.0.1:7676/mcp");
console.log("ownerToken :", ownerToken, "（ChatGPT 连接时作为密码填入）");
console.log("\n—— ChatGPT 远程访问（需隧道） ——");
console.log("  在 ChatGPT 的 MCP 连接器里添加：");
console.log("    类型: Streamable HTTP");
console.log("    URL :", publicBaseUrl ? `${publicBaseUrl.replace(/\/+$/, "")}/mcp` : "<先建立隧道>");
console.log("    Auth: OAuth，用户名随意，密码填上面的 ownerToken");
console.log("\n—— 本机 WorkBuddy 访问（本地，无需隧道） ——");
console.log('  在 ~/.workbuddy/mcp.json 增加：');
console.log(JSON.stringify({
  mcpServers: {
    devspace: {
      type: "streamable-http",
      url: "http://127.0.0.1:7676/mcp",
      headers: { Authorization: "Bearer " + ownerToken },
    },
  },
}, null, 2));
console.log("\n—— 使用提醒 ——");
console.log("  • 命令里路径用正斜杠：ls -la /c/Jim/proj  或 不写路径（默认工作区根）");
console.log("  • 不用传 workspaceId，先 open_workspace 打开项目即可");
console.log("  • 补丁在 node_modules 内，未来 npm 升级会失效，需重跑本脚本");
console.log("========================================");
