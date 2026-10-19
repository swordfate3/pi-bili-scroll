/**
 * whale.ts —— 把 dsh-bili-whale 的工具集（vendor 自 Alterssss/dsh-bili-whale，MIT）接进 pi。
 *
 * ## 为什么不重写
 * 那套有 46 个命令、约 5700 行，覆盖读（字幕/弹幕/评论/封面/抽帧）与写（评论/私信/动态/弹幕）。
 * 重写等于抄一遍还抄错。这里只做三件事：
 *   1. 分发：把 pi 的一次工具调用翻译成 `node bili.mjs <command> ...args`
 *   2. 分类：区分只读与写操作，写操作走确认闸门
 *   3. 收敛输出：截断超长 stdout，避免把上下文撑爆
 *
 * ## 它自己的约定（不改）
 * - 凭据读 `~/.bili-ai/credentials.json`（我们的登录写的是 `~/.bilibili-mcp/config.json`，
 *   由 scripts/setup-whale.mjs 建软链对接）
 * - 写操作脚本自己也有 `--dry` / `--go` 双跳，这是第二道保险
 */
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const WHALE_ENTRY = join(PACKAGE_ROOT, "vendor", "bili-whale", "tools", "bili.mjs");

/** 只读命令：不产生任何对外副作用，可直接跑。 */
export const READ_COMMANDS = [
  "session",
  "thread",
  "check-comment",
  "check-dynamic",
  "check-mention",
  "watch",
  "comment-await",
  "comment-digest",
  "recon",
  "video",
  "subtitles",
  "watch-video",
  "debrief",
  "feed",
  "quota",
  "likes",
  "deps",
  "diary",
  "search",
  "covers",
  "whois",
] as const;

/**
 * 写命令：会真的发出去。
 * ⚠️ `comment-del`（删自己的评论）也算写 —— 对外可见状态会变。
 */
export const WRITE_COMMANDS = [
  "comment",
  "comment-del",
  "dm",
  "dm-await",
  "dynamic",
  "dynamic-image",
  "dynamic-edit",
  "danmaku",
  "await",
  "reply-draft",
] as const;

/** 命令 → 是否写操作。未知命令一律当写（fail closed）。 */
export function isWriteCommand(command: string): boolean {
  if ((READ_COMMANDS as readonly string[]).includes(command)) return false;
  if ((WRITE_COMMANDS as readonly string[]).includes(command)) return true;
  return true;
}

/**
 * 这些参数表示"只预览/只看状态"，命令本身不会对外发送任何东西。
 * ⚠️ 用命令名一刀切会把 `dm --dry` 也拦下来 —— 让人为"预览"点确认，
 * 结果就是训练出闭眼点"同意"的习惯，反而削弱闸门。所以这里放行。
 * 安全性由工具自己保证：whale 的写命令强制 `--dry` 与 `--go` 二选一，
 * 给了 `--dry` 就一定不发。
 */
export const NOOP_FLAGS = new Set(["--dry", "--status", "--check"]);

export function isDryRunArgs(args: readonly string[] = []): boolean {
  return args.some((a) => NOOP_FLAGS.has(a));
}

export function isKnownCommand(command: string): boolean {
  return (
    (READ_COMMANDS as readonly string[]).includes(command) ||
    (WRITE_COMMANDS as readonly string[]).includes(command)
  );
}

export interface WhaleResult {
  ok: boolean;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

/** 输出上限：工具集里 `debrief` / `subtitles` 会吐很长的文本。 */
export const MAX_OUTPUT_CHARS = 20_000;

/**
 * 跑一个 whale 命令。
 * 不做 shell 展开（execFile + 参数数组），所以参数里的空格、引号、`$` 都不会被解释。
 */
export async function runWhale(
  command: string,
  args: readonly string[] = [],
  options: { timeoutMs?: number; maxChars?: number } = {},
): Promise<WhaleResult> {
  const { timeoutMs = 120_000, maxChars = MAX_OUTPUT_CHARS } = options;
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [WHALE_ENTRY, command, ...args], {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: "1" },
    });
    const cut = stdout.length > maxChars;
    return {
      ok: true,
      command,
      exitCode: 0,
      stdout: cut ? `${stdout.slice(0, maxChars)}\n\n…（输出过长，已截断，共 ${stdout.length} 字符）` : stdout,
      stderr: stderr.slice(0, 4000),
      truncated: cut,
    };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string; message?: string; killed?: boolean };
    const stdout = String(err.stdout ?? "");
    const stderr = String(err.stderr ?? err.message ?? "");
    return {
      ok: false,
      command,
      exitCode: typeof err.code === "number" ? err.code : -1,
      stdout: stdout.slice(0, maxChars),
      stderr: (err.killed ? "命令超时被终止（可能是等回复/抽帧太久）\n" : "") + stderr.slice(0, 4000),
      truncated: stdout.length > maxChars,
    };
  }
}
