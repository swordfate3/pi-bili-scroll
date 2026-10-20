#!/usr/bin/env node
/**
 * backfill-voice.mjs —— 从审计日志回填 `taste/voice.jsonl`。
 *
 * 为什么要它：`voice.jsonl` 是从 v2.3.0 才开始写的，而审计 `writes.log` 从
 * 更早就在记每一次真实发出的评论。不回填的话，说话方式的统计会永远"从零开始"，
 * 已有的判断依据白扔了。
 *
 * 只做一件事：把 `writes.log` 里 `bili_comment` 的行搬进 `voice.jsonl`，去重。
 * 不联网、不改审计、不碰其它文件。
 *
 * 已知局限（如实写下来，不假装完美）：
 * - v2.3.0 之前的审计行只有正文、没有 BV 号，所以老记录的 `bvid` 会是空串；
 * - 审计把换行压成了空格，所以多行评论回填后是单行。
 * 两条都不影响长度/用词/套话这类统计，只影响"哪条视频"的追溯。
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const home = process.env.BILI_SCROLL_HOME ?? join(homedir(), ".local/share/bili-scroll");
const auditPath = join(home, "writes.log");
const voicePath = join(home, "taste", "voice.jsonl");

const readOr = async (path) => {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
};

const audit = await readOr(auditPath);
if (audit === null) {
  console.error(`找不到审计日志：${auditPath}`);
  process.exit(1);
}

// 已有语料：按「时间+正文」去重，重复跑不会灌出重复条目。
const existing = new Set();
for (const line of (await readOr(voicePath))?.split("\n") ?? []) {
  if (!line.trim()) continue;
  try {
    const parsed = JSON.parse(line);
    existing.add(`${parsed.at}\u0000${parsed.text}`);
  } catch {
    // 坏行忽略
  }
}

const rows = [];
for (const line of audit.split("\n")) {
  if (!line.trim()) continue;
  const [at, tool, ...rest] = line.split("\t");
  if (tool !== "bili_comment") continue;
  const payload = rest.join("\t").trim();
  if (!payload) continue;
  // v2.3.0 起审计前缀带 BV 号：`BV1xxx 正文`
  const match = payload.match(/^(BV[0-9A-Za-z]{6,})\s+(.*)$/);
  const bvid = match ? match[1] : "";
  const text = (match ? match[2] : payload).trim();
  if (!text) continue;
  const key = `${at}\u0000${text}`;
  if (existing.has(key)) continue;
  existing.add(key);
  rows.push({ at, bvid, text });
}

if (rows.length === 0) {
  console.log("没有需要回填的评论（要么已回填过，要么审计里没有 bili_comment）。");
  process.exit(0);
}

await mkdir(dirname(voicePath), { recursive: true });
await appendFile(voicePath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");

console.log(`已回填 ${rows.length} 条真实评论到 ${voicePath}`);
const noBvid = rows.filter((row) => !row.bvid).length;
if (noBvid > 0) console.log(`  其中 ${noBvid} 条是旧格式审计（无 BV 号），bvid 留空`);
