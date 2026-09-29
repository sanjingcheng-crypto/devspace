// start-devspace-serve.mjs — 只重启 devspace serve，不改 auth.json / 不重生成 ownerToken。
// 用途：机器重启或 serve 崩了之后，把它拉起来即可（full 工具模式 + 多 allowedRoots 都从现有 config.json 读取）。
// 用法：node start-devspace-serve.mjs
import { spawn, execSync } from "child_process";
import { existsSync, readFileSync, mkdirSync, openSync } from "fs";
import { homedir } from "os";
import path from "path";

const HOME = homedir();
const HOST_DIR = path.join(HOME, ".devspace-host");
const CFG_DIR = path.join(HOME, ".devspace");
const NODE = process.execPath; // 用当前运行的 Node（托管版）即可
const cliJs = path.join(HOST_DIR, "node_modules", "@waishnav", "devspace", "dist", "cli.js");
const LOG = path.join(HOST_DIR, "serve.log");

function log(...a) { console.log("[start-devspace-serve]", ...a); }

if (!existsSync(cliJs)) { console.error("找不到", cliJs, "——请先运行 install-devspace.mjs"); process.exit(1); }

// 读现有 config（publicBaseUrl / allowedRoots 都从这里来，本脚本不改动）
let cfg = {};
try { cfg = JSON.parse(readFileSync(path.join(CFG_DIR, "config.json"), "utf8")); } catch {}
const publicBaseUrl = cfg.publicBaseUrl;
if (publicBaseUrl) log("publicBaseUrl:", publicBaseUrl);
if (Array.isArray(cfg.allowedRoots)) log("allowedRoots:", cfg.allowedRoots.join(", "));

// 1) 清理占用 7676 的真实监听进程
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
// 给旧进程一点退出时间
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(1500);

// 2) 准备环境：full 模式 + git 在 PATH（devspace 命令里要用 git）
let gitBin = "";
for (const cand of [
  "C:\\Program Files\\Git\\bin",
  path.join(HOME, ".workbuddy", "vendor", "PortableGit", "bin"),
]) {
  if (existsSync(path.join(cand, "git.exe"))) { gitBin = cand; break; }
}
if (!gitBin) { try { gitBin = execSync("where git").toString().trim().split(/\r?\n/)[0].replace(/git\.exe$/i, ""); } catch {} }
const env = { ...process.env };
if (gitBin) env.PATH = gitBin + ";" + process.env.PATH;
if (publicBaseUrl) env.DEVSPACE_PUBLIC_BASE_URL = publicBaseUrl.replace(/\/+$/, "");
// 关键：full 模式才注册 ls/grep/glob，否则 ChatGPT 无法列目录
env.DEVSPACE_TOOL_MODE = "full";
env.DEVSPACE_MINIMAL_TOOLS = "false";

// 2.5) 自愈 git "dubious ownership"：仓库属主与当前用户不一致时 git 会拒绝执行。
// 个人开发机上把当前用户信任为所有仓库属主，避免 bash 里的 git status/log 等命令失败。
if (gitBin) {
  try {
    execSync(`"${path.join(gitBin, "git.exe")}" config --global --add safe.directory "*"`, { stdio: "ignore" });
    log("已确保 git safe.directory 已设置（避免 dubious ownership 拦截）");
  } catch { /* 失败不阻断启动 */ }
}

// 3) 以 detached 拉起 serve（脱离当前 shell，比后台任务耐久）
mkdirSync(HOST_DIR, { recursive: true });
const logFd = openSync(LOG, "a");
const serveProc = spawn(NODE, [cliJs, "serve"], {
  cwd: HOST_DIR,
  env,
  detached: true,
  stdio: ["ignore", logFd, logFd],
  windowsHide: true,
});
serveProc.unref();
log("serve 已以 PID", serveProc.pid, "拉起（日志:", LOG, "），等待冷启动…");
await wait(6000);

// 4) 校验监听
let listening = false;
try {
  const out = execSync("netstat -ano | findstr :7676", { stdio: ["ignore", "pipe", "ignore"] }).toString();
  listening = /LISTEN/i.test(out);
} catch {}
if (listening) log("✅ 127.0.0.1:7676 已监听，serve 就绪。");
else { console.error("⚠️ serve 似乎未监听 7676，请查日志:", LOG); process.exit(2); }
