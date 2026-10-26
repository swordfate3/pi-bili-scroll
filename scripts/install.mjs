#!/usr/bin/env node
/**
 * install.mjs —— 一条命令把 bili 扩展需要的运行时全装好。
 *
 * 装什么：
 *   1. Node 依赖（npm install，缺 node_modules 时）
 *   2. dsh-bili-whale 的凭证软链（setup-whale.mjs）
 *   3. 写能力 MCP 的 venv + Python 依赖（setup-mcp-write.mjs）
 *
 * 幂等：已装好会跳过对应步骤。
 *
 * 用法：
 *   node scripts/install.mjs
 *   node scripts/install.mjs --check     # 只检查，不安装
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CHECK_ONLY = process.argv.includes("--check");
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = homedir();

const RUNTIME = process.env.BILI_SCROLL_HOME?.trim() || join(home, ".local", "share", "bili-scroll");
const NODE_MODULES = join(projectRoot, "node_modules");
const MCP_READ = join(RUNTIME, "mcp", "node_modules", "@xzxzzx", "bilibili-mcp", "dist", "cli.js");
const MCP_WRITE_PY = join(RUNTIME, "mcp-write", "venv", "bin", "python");
const MCP_WRITE = join(RUNTIME, "mcp-write", "mcp_server.py");

function ok(label, path) {
  const exists = existsSync(path);
  console.log(`  ${exists ? "✓" : "✗"} ${label}${exists ? "" : "  → " + path}`);
  return exists;
}

function run(label, cmd, args, cwd = projectRoot) {
  console.log(`\n· ${label}`);
  execFileSync(cmd, args, { stdio: "inherit", cwd });
}

/** 验证写 MCP 的 Python 依赖能 import（比起一次 server 更稳：
 *  FastMCP 在 stdin EOF 时可能丢掉 tools/list 的响应）。 */
function checkPythonDeps(venvPython) {
  const r = spawnSync(venvPython, ["-c", "import mcp, bilibili_api, aiohttp; print('ok')"], {
    timeout: 20000,
    encoding: "utf8",
    env: { ...process.env },
  });
  const ok = (r.stdout || "").trim() === "ok";
  console.log(`  ${ok ? "✓" : "✗"} 写 MCP 的 Python 依赖（mcp / bilibili-api / aiohttp）`);
  if (!ok) console.log(`      ${(r.stderr || "").split("\n")[0].slice(0, 100)}`);
  return ok;
}

/** 验证 Node 侧的 MCP 入口能被 node 正常加载 */
function checkNodeEntry(cliPath) {
  const r = spawnSync("node", ["-e", `import('file://${cliPath}').then(()=>console.log('ok')).catch(e=>console.log('err:'+e.message))`], {
    timeout: 20000,
    encoding: "utf8",
  });
  const out = (r.stdout || "").trim();
  const ok = out === "ok" || out.startsWith("err:Cannot find module") === false;
  console.log(`  ${ok ? "✓" : "✗"} 只读 MCP 的 Node 入口`);
  return ok;
}

function main() {
  console.log("检查现状：");
  const hasDeps = ok("Node 依赖", NODE_MODULES);
  const hasRead = ok("只读 MCP", MCP_READ);
  const hasWrite = ok("写 MCP 脚本", MCP_WRITE);
  const hasWritePy = ok("写 MCP venv", MCP_WRITE_PY);

  if (CHECK_ONLY) {
    console.log("\n验证（--check 只读）：");
    if (hasRead) checkNodeEntry(MCP_READ);
    if (hasWrite && hasWritePy) checkPythonDeps(MCP_WRITE_PY);
    console.log("\n--check：未做任何改动。");
    return;
  }

  // 1) Node 依赖
  if (!hasDeps) run("安装 Node 依赖（npm install）", "npm", ["install"]);
  else console.log("\n· Node 依赖已就绪，跳过");

  // 2) whale 凭证软链
  if (existsSync(join(projectRoot, "scripts", "setup-whale.mjs"))) {
    run("对接 dsh-bili-whale 凭证", process.execPath, ["scripts/setup-whale.mjs"]);
  }

  // 3) 写 MCP（venv + pip）
  if (!hasWrite || !hasWritePy) {
    run("准备写能力 MCP（venv + Python 依赖）", process.execPath, ["scripts/setup-mcp-write.mjs"]);
  } else {
    console.log("\n· 写 MCP 已就绪，跳过");
  }

  // 4) 验证
  console.log("\n验证：");
  const readOk = hasRead && checkNodeEntry(MCP_READ);
  const writeOk = hasWrite && hasWritePy && checkPythonDeps(MCP_WRITE_PY);

  console.log(
    readOk && writeOk
      ? "\n✅ 都装好了。重启 Pi 后两个 MCP 会连上。"
      : "\n⚠️ 有组件没起来，看上面的 ✗ 行。"
  );
}

main();
