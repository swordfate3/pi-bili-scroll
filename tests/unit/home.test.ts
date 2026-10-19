import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { DEFAULT_HOME, dayKey, formatDayKey, formatMinutesOfDay, homeDir, pathsFor, reportPath, setTimeZone } from "../../src/home.js";

test("formatDayKey 按指定时区算日期（不依赖宿主 TZ）", () => {
  // 2026-01-03T20:00Z = 北京时间 01-04 04:00
  const t = new Date("2026-01-03T20:00:00Z");
  assert.equal(formatDayKey(t, "UTC"), "2026-01-03");
  assert.equal(formatDayKey(t, "Asia/Shanghai"), "2026-01-04", "跨日必须按使用者时区");
});

test("dayKey 默认用 Asia/Shanghai，切换后跟着变", () => {
  setTimeZone("Asia/Shanghai");
  assert.equal(dayKey(new Date("2026-06-09T15:59:00Z")), "2026-06-09"); // 北京 23:59
  assert.equal(dayKey(new Date("2026-06-09T16:00:00Z")), "2026-06-10"); // 北京 00:00
  setTimeZone("UTC");
  assert.equal(dayKey(new Date("2026-06-09T16:00:00Z")), "2026-06-09");
  setTimeZone("Asia/Shanghai");
});

test("formatMinutesOfDay 按指定时区算当天第几分钟", () => {
  const t = new Date("2026-10-19T10:43:00Z");
  assert.equal(formatMinutesOfDay(t, "UTC"), 643);           // 10:43
  assert.equal(formatMinutesOfDay(t, "Asia/Shanghai"), 1123); // 18:43
});

test("setTimeZone 拒绝非法时区名且不改变现状", () => {
  setTimeZone("Asia/Shanghai");
  setTimeZone("Mars/Olympus");
  assert.equal(dayKey(new Date("2026-06-09T16:00:00Z")), "2026-06-10", "非法时区应被忽略");
});

test("pathsFor 拼出家目录下的固定结构", () => {
  const paths = pathsFor("/tmp/bili-scroll-test");
  assert.equal(paths.home, "/tmp/bili-scroll-test");
  assert.equal(paths.config, join("/tmp/bili-scroll-test", "config.json"));
  assert.equal(paths.outDir, join("/tmp/bili-scroll-test", "out"));
  assert.equal(paths.log, join("/tmp/bili-scroll-test", "bili-scroll.log"));
});

test("homeDir 默认落在持久卷下的 bili-scroll", () => {
  const saved = process.env.BILI_SCROLL_HOME;
  try {
    delete process.env.BILI_SCROLL_HOME;
    assert.equal(homeDir(), DEFAULT_HOME);
    assert.ok(DEFAULT_HOME.includes("bili-scroll"));
    // 空白覆盖值不算覆盖
    process.env.BILI_SCROLL_HOME = "   ";
    assert.equal(homeDir(), DEFAULT_HOME);
    process.env.BILI_SCROLL_HOME = "/tmp/override";
    assert.equal(homeDir(), "/tmp/override");
  } finally {
    if (saved === undefined) delete process.env.BILI_SCROLL_HOME;
    else process.env.BILI_SCROLL_HOME = saved;
  }
});

test("reportPath 用日期做文件名", () => {
  const paths = pathsFor("/tmp/bili-scroll-test");
  assert.equal(reportPath(paths, "2026-05-04"), join(paths.outDir, "2026-05-04.md"));
});
