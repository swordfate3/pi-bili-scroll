import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, normalizeConfig } from "../../src/config.js";
import { pathsFor } from "../../src/home.js";

test("配置不是对象时全部回退并留一条提示", () => {
  for (const bad of [null, 42, "text", [], true]) {
    const { config, notices } = normalizeConfig(bad);
    assert.deepEqual(config, { ...DEFAULT_CONFIG, keywords: [] });
    assert.equal(notices.length, 1);
  }
});

test("字段类型不对时回默认值，不是一个真值就放行", () => {
  // 教训来源：宿主传进来的值不保证是标量，对象是"真值"会让守卫失效。
  const { config, notices } = normalizeConfig({
    enabled: { nested: true },
    perDay: "5",
    reportDetail: "verbose",
    keywords: { 0: "AI" },
    workdir: 42,
    notifyOnStart: "yes",
  });
  assert.equal(config.enabled, true);
  assert.equal(config.perDay, 5);
  assert.equal(config.reportDetail, "brief");
  assert.deepEqual(config.keywords, []);
  assert.equal(config.workdir, null);
  assert.equal(config.notifyOnStart, true);
  // 六个字段全是非法类型 ⇒ 六条提示，一个都不该被当成真值放行。
  assert.equal(notices.length, 6);
});

test("合法字段被采用", () => {
  const { config, notices } = normalizeConfig({
    enabled: false,
    perDay: 0,
    reportDetail: "full",
    keywords: [" AI Agent ", "编程"],
    workdir: "/workspace",
    notifyOnStart: false,
  });
  assert.equal(config.enabled, false);
  assert.equal(config.perDay, 0);
  assert.equal(config.reportDetail, "full");
  assert.deepEqual(config.keywords, ["AI Agent", "编程"]);
  assert.equal(config.workdir, "/workspace");
  assert.equal(config.notifyOnStart, false);
  assert.deepEqual(notices, []);
});

test("keywords 丢弃空项、超长项与非字符串项", () => {
  const { config, notices } = normalizeConfig({
    keywords: ["ok", "", "   ", 7, null, "x".repeat(101)],
  });
  assert.deepEqual(config.keywords, ["ok"]);
  assert.equal(notices.length, 1);
});

test("perDay 拒绝负数与小数", () => {
  assert.equal(normalizeConfig({ perDay: -1 }).config.perDay, 5);
  assert.equal(normalizeConfig({ perDay: 2.5 }).config.perDay, 5);
  assert.equal(normalizeConfig({ perDay: 0 }).config.perDay, 0);
});

test("workdir 为 null 表示不读设定，且不报错", () => {
  const { config, notices } = normalizeConfig({ workdir: null });
  assert.equal(config.workdir, null);
  assert.deepEqual(notices, []);
});

test("loadConfig：文件不存在用默认值且不报警", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bili-scroll-config-"));
  try {
    const { config, notices } = await loadConfig(pathsFor(dir));
    assert.deepEqual(config, { ...DEFAULT_CONFIG, keywords: [] });
    assert.deepEqual(notices, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig：坏的 JSON 回默认值并提示", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bili-scroll-config-"));
  try {
    const paths = pathsFor(dir);
    await writeFile(paths.config, "{ not json", "utf8");
    const { config, notices } = await loadConfig(paths);
    assert.deepEqual(config, { ...DEFAULT_CONFIG, keywords: [] });
    assert.equal(notices.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadConfig：合法文件被读进来", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bili-scroll-config-"));
  try {
    const paths = pathsFor(dir);
    await writeFile(paths.config, JSON.stringify({ perDay: 3, keywords: ["量子计算"] }), "utf8");
    const { config, notices } = await loadConfig(paths);
    assert.equal(config.perDay, 3);
    assert.deepEqual(config.keywords, ["量子计算"]);
    assert.deepEqual(notices, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
