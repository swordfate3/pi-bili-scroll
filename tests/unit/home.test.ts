import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { DEFAULT_HOME, dayKey, homeDir, pathsFor, reportPath } from "../../src/home.js";

test("dayKey 按本地日期补零", () => {
  assert.equal(dayKey(new Date(2026, 0, 3)), "2026-01-03");
  assert.equal(dayKey(new Date(2026, 11, 31)), "2026-12-31");
  // 本地 23:59 与次日 00:00 分属两天（不能用 UTC 算）
  assert.equal(dayKey(new Date(2026, 5, 9, 23, 59)), "2026-06-09");
  assert.equal(dayKey(new Date(2026, 5, 10, 0, 0)), "2026-06-10");
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
