#!/usr/bin/env node
/**
 * uninstall.mjs —— 把 pi-bili-scroll 留下的东西一次清干净。
 *
 * 为什么需要：`pi remove` 只取消加载，不删运行时（几百 MB）和登录凭证。
 *
 * 用法：
 *   node scripts/uninstall.mjs                 # 交互确认，然后清理
 *   node scripts/uninstall.mjs --yes           # 不确认
 *   node scripts/uninstall.mjs --dry-run       # 只显示会删什么
 *   node scripts/uninstall.mjs --keep-data     # 保留日报/口味/人设
 *   node scripts/uninstall.mjs --keep-login    # 保留 B 站登录凭证
 *   node scripts/uninstall.mjs --keep-all      # 只取消加载，不删任何文件
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const argv = new Set(process.argv.slice(2));
const YES = argv.has("--yes") || argv.has("-y");
const DRY = argv.has("--dry-run");
const KEEP_DATA = argv.has("--keep-data") || argv.has("--keep-all");
const KEEP_LOGIN = argv.has("--keep-login") || argv.has("--keep-all");

const HOME = homedir();
const RUNTIME = process.env.BILI_SCROLL_HOME?.trim() || join(HOME, ".local", "share", "bili-scroll");
const CRED = join(HOME, ".bilibili-mcp");
const CACHE = join(HOME, ".pi", "agent", "mcp-cache.json");
const SETTINGS = join(HOME, ".pi", "agent", "settings.json");

/** 运行时目录里哪些是“用户数据”，--keep-data 时要保留 */
const USER_DATA = ["out", "persona", "taste", "config.json", "notify.json", "schedule-state.json", "comment-quota.json"];

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function dirSize(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  const walk = (p) => {
    let st;
    try {
      st = statSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      let names = [];
      try {
        names = readdirSync(p);
      } catch {
        return;
      }
      for (const n of names) walk(join(p, n));
    } else {
      total += st.size;
    }
  };
  walk(dir);
  return total;
}

/** 找出 settings 里声明的 bili 包（可能是 git 源，也可能是本地路径） */
function findPackageSpec() {
  try {
    const s = JSON.parse(readFileSync(SETTINGS, "utf8"));
    for (const p of s.packages || []) {
      const text = typeof p === "string" ? p : JSON.stringify(p);
      if (text.includes("pi-bili-scroll")) {
        return typeof p === "string" ? p : p.source || text;
      }
    }
  } catch {
    /* ignore */
  }
  return "git:github.com/swordfate3/pi-bili-scroll";
}

async function confirm(question) {
  if (YES || !process.stdin.isTTY) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function main() {
  const runtimeSize = dirSize(RUNTIME);
  const credSize = dirSize(CRED);
  const pkgSpec = findPackageSpec();

  console.log("将清理：");
  console.log(`  1. 包声明        ${pkgSpec}`);
  console.log(`  2. 运行时目录    ${RUNTIME}  ${humanSize(runtimeSize)}${KEEP_DATA ? "（保留用户数据）" : ""}`);
  console.log(`  3. 登录凭证      ${CRED}  ${humanSize(credSize)}${KEEP_LOGIN ? "（保留）" : ""}`);
  console.log(`  4. 工具缓存      ${CACHE} 里的 bili 条目`);

  if (KEEP_DATA && existsSync(RUNTIME)) {
    console.log(`\n会保留的用户数据：${USER_DATA.join("、")}`);
  }

  if (DRY) {
    console.log("\n--dry-run：什么都没删。");
    return;
  }

  if (!(await confirm("\n继续？[y/N] "))) {
    console.log("已取消。");
    return;
  }

  // 1) 取消加载
  try {
    execFileSync("pi", ["remove", pkgSpec], { stdio: "inherit" });
  } catch (e) {
    console.log(`· pi remove 失败（可能已经移除）：${e.message}`);
  }

  // 2) 运行时目录
  if (existsSync(RUNTIME)) {
    if (KEEP_DATA) {
      const survivors = new Set(USER_DATA);
      let keep = 0;
      for (const name of readdirSync(RUNTIME)) {
        if (survivors.has(name)) {
          keep++;
          continue;
        }
        rmSync(join(RUNTIME, name), { recursive: true, force: true });
      }
      console.log(`✓ 运行时已清理，保留 ${keep} 项用户数据于 ${RUNTIME}`);
    } else {
      rmSync(RUNTIME, { recursive: true, force: true });
      console.log(`✓ 已删除 ${RUNTIME}（${humanSize(runtimeSize)}）`);
    }
  } else {
    console.log("· 运行时目录不存在，跳过");
  }

  // 3) 登录凭证
  if (!KEEP_LOGIN && existsSync(CRED)) {
    rmSync(CRED, { recursive: true, force: true });
    console.log(`✓ 已删除 ${CRED}（下次要重新扫码登录）`);
  } else if (KEEP_LOGIN) {
    console.log("· 保留登录凭证");
  }

  // 4) 缓存条目
  try {
    if (existsSync(CACHE)) {
      const d = JSON.parse(readFileSync(CACHE, "utf8"));
      const s = d.servers || d;
      const hit = Object.keys(s).filter((k) => k.includes("bili"));
      for (const k of hit) delete s[k];
      writeFileSync(CACHE, JSON.stringify(d, null, 1));
      console.log(`✓ 清掉缓存条目 ${hit.length} 个${hit.length ? "：" + hit.join(", ") : ""}`);
    }
  } catch (e) {
    console.log(`· 缓存清理跳过：${e.message}`);
  }

  console.log("\n完成。重启 Pi 后扩展/技能/MCP 才彻底不再加载。");
}

main().catch((e) => {
  console.error("失败：", e.message);
  process.exit(1);
});
