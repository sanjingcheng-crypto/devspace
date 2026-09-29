// DevSpace 开机自启（纯 Node，绕过 PowerShell 限制）
// 清理旧 cloudflared -> 起 cloudflared quick tunnel 并捕获新 URL
// -> 回写 config.publicBaseUrl -> 起 devspace serve（保留 ownerToken）-> 验证链路
// 由启动文件夹的 VBS 调用：node <仓库根>/start-all.mjs
import { spawn, execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const NODE = process.execPath;
// 仓库根 = 本脚本所在目录（换机器/换盘符也能用）
const DEVSPACE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLOUDFLARED = path.join("C:\\Program Files (x86)", "cloudflared", "cloudflared.exe");
const CONFIG = path.join(os.homedir(), ".devspace", "config.json");
const URL_FILE = path.join(DEVSPACE_DIR, "last-tunnel-url.txt");
const LOG = path.join(DEVSPACE_DIR, "start-all.log");

function log(m) {
  const line = `[${new Date().toISOString()}] ${m}\n`;
  fs.appendFileSync(LOG, line);
}
log("=== start-all 启动 ===");

// 1. 清理旧 cloudflared（重启后通常无，手动重复运行才需要；失败忽略）
try {
  execSync("taskkill /F /IM cloudflared.exe", { stdio: "ignore", windowsHide: true });
  log("已清理旧 cloudflared");
} catch (_) { /* 忽略 */ }

// 2. 起 cloudflared quick tunnel（detached 使其在本脚本退出后继续存活）
const cf = spawn(CLOUDFLARED, ["tunnel", "--url", "http://127.0.0.1:7676"], {
  detached: true,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
cf.unref();
let url = null;
function onData(buf) {
  if (url) return;
  const s = buf.toString();
  const m = s.match(/https:\/\/([a-z0-9-]+\.trycloudflare\.com)/);
  if (m) {
    url = m[1];
    gotUrl();
  }
}
cf.stdout.on("data", onData);
cf.stderr.on("data", onData);
cf.on("error", (e) => log("cloudflared spawn error: " + e.message));

async function gotUrl() {
  const base = "https://" + url;
  log("隧道 URL=" + base);
  fs.writeFileSync(URL_FILE, base);

  // 3. 回写 config.publicBaseUrl（OAuth resource 校验依赖它）
  const c = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  c.publicBaseUrl = base;
  fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2) + "\n");
  log("config.publicBaseUrl -> " + base);

  // 4. 起 devspace serve（脚本会处理 7676 占用并自动用最新 publicBaseUrl，保留 ownerToken）
  const serve = spawn(NODE, [path.join(DEVSPACE_DIR, "start-devspace-serve.mjs")], {
    windowsHide: true,
    stdio: "ignore",
  });
  serve.on("exit", () => log("start-devspace-serve 退出（serve 已在后台运行）"));

  // 5. 稍等 serve 起来后验证链路
  setTimeout(verify, 4000);
}

async function verify() {
  const base = "https://" + url;
  try {
    const r = await fetch(base + "/");
    log("验证 GET / -> " + r.status);
  } catch (e) {
    log("验证 GET / 失败: " + e.message);
  }
  try {
    const r = await fetch(base + "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    log("验证 POST /mcp -> " + r.status + " (401=需 OAuth token，链路正常)");
  } catch (e) {
    log("验证 POST /mcp 失败: " + e.message);
  }
  log("=== start-all 完成 (URL=" + base + ") ===");
}

// 超时保护：45s 内没拿到 URL 则退出
setTimeout(() => {
  if (!url) {
    log("ERROR: 45s 内未拿到隧道 URL，cloudflared 可能未能联网");
    process.exit(1);
  }
}, 45000);
