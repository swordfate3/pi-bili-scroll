#!/usr/bin/env node
/**
 * setup-whale.mjs —— 让 dsh-bili-whale 工具集能用本扩展已有的登录。
 *
 * 两边凭证位置不同，但**字段名对得上**（sessdata / bili_jct）：
 *   我们登录写：  ~/.bilibili-mcp/config.json          （有多余的 dedeuserid、expiresAt）
 *   whale 读：    ~/.bili-ai/credentials.json         （多一个可选的 buvid3）
 * 所以不复制、只建软链 —— 换账号后自动同步，不会出现"一边新一边旧"。
 *
 * ⚠️ whale 的脚本把路径写死成 `$HOME/.bili-ai/credentials.json`，没有环境变量可覆盖，
 *    因此软链是唯一不修改它源码的对接方式。
 */
import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const home = process.env.HOME || homedir();
const credSource = join(home, ".bilibili-mcp", "config.json");
const whaleDir = join(home, ".bili-ai");
const credLink = join(whaleDir, "credentials.json");

if (!existsSync(credSource)) {
  console.error(`✗ 还没有 B 站凭证：${credSource}\n  先在 pi 里执行 /bili-login 扫码登录。`);
  process.exit(1);
}

mkdirSync(whaleDir, { recursive: true });

if (existsSync(credLink) || isSymlink(credLink)) {
  const current = isSymlink(credLink) ? readlinkSync(credLink) : "(普通文件)";
  if (current === credSource) {
    console.log(`✓ 已就绪：${credLink} → ${credSource}`);
    process.exit(0);
  }
  console.log(`· 替换已有凭证：原指向 ${current}`);
  unlinkSync(credLink);
}

symlinkSync(credSource, credLink);
console.log(`✓ 已建软链：${credLink} → ${credSource}`);
console.log("  换账号后无需重跑本脚本（软链跟着源文件走）。");
console.log("\n下一步（可选）：装 ffmpeg 才能用「抽帧看画面」");
console.log("  whale 的 deps 命令会告诉你它从哪儿找 ffmpeg");

function isSymlink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
