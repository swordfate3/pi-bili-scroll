#!/usr/bin/env node
/**
 * dev-links.mjs —— 恢复开发用的 peer 软链。
 *
 * ## 为什么需要这个脚本
 *
 * 开发时不想把 `@earendil-works/pi-coding-agent`（上百 MB、含 pi 本体）复制进本项目的
 * node_modules，所以用软链指向全局安装。但 **`npm install` 会把这两个软链当成
 * "多余的包"清理掉**，而且实测会顺着软链把**目标目录的内容也删掉** ——
 * 2026-10-19 就是这么把 `/home/node/.local/lib/node_modules/@earendil-works/` 清空的，
 * 结果 `pi` 命令直接不可用，只能用 `npm i -g @earendil-works/pi-coding-agent@1.3.0` 重装恢复。
 *
 * ## 规矩
 *
 * **每次在这个目录跑过 `npm install` 之后，立刻跑 `npm run devlinks`。**
 * 并在跑之前确认全局安装还在（`pi --version` 能出结果）。
 */
import { existsSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const nodeModules = join(projectRoot, "node_modules");

const GLOBAL_PI = "/home/node/.local/lib/node_modules/@earendil-works";
const GLOBAL_SCOPE = "/home/node/.local/lib/node_modules/@earendil-works";
const GLOBAL_TYPEBOX =
  "/home/node/.local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/typebox";

if (!existsSync(join(GLOBAL_PI, "pi-coding-agent"))) {
  console.error(
    `✗ 全局 pi 安装不在：${GLOBAL_PI}/pi-coding-agent\n` +
      "  先恢复它：npm i -g @earendil-works/pi-coding-agent@1.3.0",
  );
  process.exit(1);
}

function relink(linkPath, target) {
  // 先删（可能是 npm 留下的空目录、也可能是旧软链），否则会插到目录里面去
  rmSync(linkPath, { recursive: true, force: true });
  symlinkSync(target, linkPath, "dir");
  console.log(`✓ ${linkPath.replace(projectRoot + "/", "")} → ${target}`);
}

relink(join(nodeModules, "@earendil-works"), GLOBAL_SCOPE);
relink(join(nodeModules, "typebox"), GLOBAL_TYPEBOX);
console.log("完成。现在可以 npm run check。");
