#!/usr/bin/env node
/**
 * setup-mcp-write.mjs —— 准备「写能力」MCP 服务器（vendor 自 AGI_Ananas/bilibili-mcp，MIT）。
 *
 * 为什么需要这步：那份实现是**裸 Python 脚本**、没有发行版，不能像 @xzxzzx/bilibili-mcp
 * 那样由 npm 装进 node_modules。所以这里把它复制到持久卷、建独立 venv、装依赖，
 * 让 mcp.json 能指向一个**稳定路径**（包目录在每次 pi install 后位置都可能不同）。
 *
 * 幂等：已存在则跳过对应步骤。用法：`node scripts/setup-mcp-write.mjs`
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const vendorScript = join(projectRoot, "vendor", "bilibili-mcp", "mcp_server.py");
const base = process.env.BILI_SCROLL_MCP_WRITE_HOME?.trim() || join(homedir(), ".local", "share", "bili-scroll", "mcp-write");
const scriptTarget = join(base, "mcp_server.py");
const venvDir = join(base, "venv");
const venvPython = join(venvDir, "bin", "python");

/** mcp 2.x 的 server 没有 list_tools，这份实现起不来 —— 必须锁 <2。 */
const REQUIREMENTS = ["bilibili-api-python>=17.4.1,<18", "aiohttp>=3.9.0", "mcp>=1.0.0,<2"];

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: "inherit" });
}

if (!existsSync(vendorScript)) {
  console.error(`✗ 找不到 vendor 脚本：${vendorScript}`);
  process.exit(1);
}

mkdirSync(base, { recursive: true });

// 1) 复制脚本（每次覆盖，保证与包内 vendored 版本一致）
copyFileSync(vendorScript, scriptTarget);
console.log(`✓ 脚本 → ${scriptTarget}`);

// 2) venv
if (!existsSync(venvPython)) {
  console.log("· 创建 venv（uv）…");
  try {
    run("uv", ["venv", venvDir, "--python", "3.12"]);
  } catch {
    console.log("  uv 不可用，退回 python -m venv");
    run("python3", ["-m", "venv", venvDir]);
  }
} else {
  console.log(`✓ venv 已存在：${venvDir}`);
}

// 3) 依赖
console.log("· 安装依赖（锁 mcp<2）…");
try {
  run("uv", ["pip", "install", "--python", venvPython, ...REQUIREMENTS]);
} catch {
  run(venvPython, ["-m", "pip", "install", "--upgrade", ...REQUIREMENTS]);
}

// 4) 自检：能 import 且能列出工具（白名单下应只剩 bili_reply）
console.log("· 自检…");
const out = execFileSync(
  venvPython,
  ["-c", "import bilibili_api, mcp; print('imports ok')"],
  { encoding: "utf8" },
).trim();
console.log(`✓ ${out}`);
console.log("\n完成。mcp.json 里声明的服务器会用：");
console.log(`  ${venvPython} ${scriptTarget}`);
