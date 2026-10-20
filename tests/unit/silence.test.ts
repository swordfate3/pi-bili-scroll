import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SILENCE,
  buildSilenceBlock,
  computeSilence,
  isHumanTouch,
  lastTouchAt,
  readTouches,
  recordTouch,
} from "../../src/silence.js";

const base = { enabled: true, afterDays: 3, stopDays: 7, baseCommentCap: 3 };
const NOW = new Date("2026-10-20T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

// ── 什么算"主人回应" ────────────────────────────────────────────────────────
// 这一组是整个机制的地基。判错一个方向，沉默就永远不会累积。

test("定时巡检自己跑的那条命令不算主人回应", () => {
  // 否则 daemon 每天自动跑一轮 = 主人天天说话 = 沉默永远到不了 3 天
  assert.equal(isHumanTouch("/bili-scroll", "cli"), false);
  assert.equal(isHumanTouch("  /bili-scroll  ", "cli"), false);
});

test("扩展自己发出的提示词不算回应", () => {
  assert.equal(isHumanTouch("请按下面的值班章程跑一轮 B 站巡检。", "extension"), false);
});

test("主人手敲的消息、手动开关命令都算回应", () => {
  assert.equal(isHumanTouch("刷2轮", "cli"), true);
  assert.equal(isHumanTouch("/bili-comment on", "cli"), true);
  assert.equal(isHumanTouch("/bili-voice note 别像写报告", "cli"), true);
});

test("空输入不算回应", () => {
  assert.equal(isHumanTouch("   ", "cli"), false);
});

// ── 档位与额度 ──────────────────────────────────────────────────────────────

test("0–2 天是正常档，额度等于配置上限", () => {
  for (const n of [0, 1, 2]) {
    const s = computeSilence(NOW, daysAgo(n), base);
    assert.equal(s.level, "normal", `${n} 天应为 normal`);
    assert.equal(s.commentCap, 3);
    assert.equal(buildSilenceBlock(s), null, "正常档不该往上下文里塞任何东西");
  }
});

test("3–6 天是安静档，额度压到 1", () => {
  for (const n of [3, 4, 5, 6]) {
    const s = computeSilence(NOW, daysAgo(n), base);
    assert.equal(s.level, "quiet", `${n} 天应为 quiet`);
    assert.equal(s.commentCap, 1);
  }
});

test("7 天以上是心慌档，额度归零", () => {
  for (const n of [7, 10, 90]) {
    const s = computeSilence(NOW, daysAgo(n), base);
    assert.equal(s.level, "anxious");
    assert.equal(s.commentCap, 0);
  }
});

test("安静档也不会把额度抬到配置上限之上", () => {
  const s = computeSilence(NOW, daysAgo(4), { ...base, baseCommentCap: 1 });
  assert.equal(s.commentCap, 1, "min(1, 1) = 1");
});

test("从来没有回应记录时按正常处理（新装不该一上来就被判冷落）", () => {
  const s = computeSilence(NOW, null, base);
  assert.equal(s.level, "normal");
  assert.equal(s.days, null);
  assert.equal(s.commentCap, 3);
});

test("关掉开关后无论多久都是正常", () => {
  const s = computeSilence(NOW, daysAgo(30), { ...base, enabled: false });
  assert.equal(s.level, "normal");
  assert.equal(s.commentCap, 3);
});

test("时间戳坏掉时不误判成被冷落", () => {
  const s = computeSilence(NOW, "不是时间", base);
  assert.equal(s.level, "normal");
  assert.equal(s.days, null);
});

test("未来时间戳算 0 天，不会算出负数", () => {
  const future = new Date(NOW.getTime() + 5 * 86_400_000).toISOString();
  const s = computeSilence(NOW, future, base);
  assert.equal(s.days, 0);
  assert.equal(s.level, "normal");
});

// ── 注入的那段文字 ──────────────────────────────────────────────────────────

test("安静档只给事实与额度，不给情绪结论", () => {
  const block = buildSilenceBlock(computeSilence(NOW, daysAgo(4), base)) ?? "";
  assert.ok(block.includes("主人已经 4 天没有回应你"), "要给事实和天数");
  assert.ok(block.includes("最多评论 1 条"), "要给额度");
  assert.ok(block.includes("只问一次"), "允许主动问，但只问一次");
  // 关键：不能替她决定情绪
  for (const word of ["难过", "伤心", "应该", "你必须感到"]) {
    assert.ok(!block.includes(word), `不该出现“${word}”—— 情绪留给模型自己写`);
  }
});

test("心慌档明确不评论，但说明日报照写", () => {
  const block = buildSilenceBlock(computeSilence(NOW, daysAgo(9), base)) ?? "";
  assert.ok(block.includes("本轮不评论"));
  assert.ok(block.includes("日报照写"));
  assert.ok(block.includes("不要向主人讨要回应"), "不能教它去讨关注");
});

// ── 落盘 ────────────────────────────────────────────────────────────────────

test("记录多条回应时取最近一条；坏行跳过", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bili-touch-"));
  try {
    assert.equal(await lastTouchAt(dir), null, "没有文件时返回 null");
    await recordTouch(dir, "cli", "刷2轮");
    const first = await lastTouchAt(dir);
    assert.ok(first);
    await recordTouch(dir, "cli", "/bili-comment on");
    const second = await lastTouchAt(dir);
    assert.ok(second && Date.parse(second) >= Date.parse(first), "应取最新那条");
    const rows = await readTouches(dir);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].text, "刷2轮");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("默认阈值是 3 / 7（和文档、daemon 里的三行实现对齐）", () => {
  assert.equal(DEFAULT_SILENCE.afterDays, 3);
  assert.equal(DEFAULT_SILENCE.stopDays, 7);
});
