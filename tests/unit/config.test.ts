import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, normalizeConfig, patchConfig } from "../../src/config.js";
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

// ── autoComment 开关 ────────────────────────────────────────────────────────
// 默认必须关：这是唯一一个会拿用户账号对外公开发言的动作，默认开着等于替他做主。

test("autoComment 默认为关", () => {
  assert.equal(DEFAULT_CONFIG.autoComment, false);
  assert.equal(normalizeConfig({}).config.autoComment, false);
});

test("autoComment 是布尔值才认，别的类型回默认并留提示", () => {
  assert.equal(normalizeConfig({ autoComment: true }).config.autoComment, true);
  for (const bad of ["true", 1, { on: true }, null]) {
    const { config, notices } = normalizeConfig({ autoComment: bad });
    assert.equal(config.autoComment, false, `${JSON.stringify(bad)} 应回默认 false`);
    assert.ok(
      notices.some((n) => n.includes("autoComment")),
      `${JSON.stringify(bad)} 应留一条提示`,
    );
  }
});

test("autoComment 和 confirmWrites 互相独立，互不影响默认值", () => {
  assert.equal(normalizeConfig({ autoComment: true }).config.confirmWrites, false);
  assert.equal(normalizeConfig({ confirmWrites: true }).config.autoComment, false);
});

test("patchConfig 只改指定字段，其余原样保留（不清空用户手写的键）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bili-cfg-"));
  try {
    const paths = pathsFor(dir);
    await writeFile(
      paths.config,
      JSON.stringify({ keywords: ["AI Agent"], perDay: 7, 自定义字段: "别丢" }, null, 2),
      "utf8",
    );
    await patchConfig(paths, { autoComment: true });
    const { config } = await loadConfig(paths);
    assert.equal(config.autoComment, true, "开关应已生效");
    assert.deepEqual(config.keywords, ["AI Agent"], "关键词不能被抹掉");
    assert.equal(config.perDay, 7, "perDay 不能被重置成默认 5");
    const raw = JSON.parse(await readFileNew(paths.config));
    assert.equal(raw["自定义字段"], "别丢", "normalize 不认识的键也要留着");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("patchConfig 在配置不存在时也能写出（首次开关不该报错）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bili-cfg2-"));
  try {
    const paths = pathsFor(dir);
    await patchConfig(paths, { autoComment: true });
    assert.equal((await loadConfig(paths)).config.autoComment, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function readFileNew(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}
