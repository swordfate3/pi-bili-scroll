import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendWriteAudit } from "../../src/extension.js";
import { DEFAULT_CONFIG, normalizeConfig } from "../../src/config.js";

test("confirmWrites 默认 false —— 写操作直接执行", () => {
  // 用户明确要求：不要每次弹 yes/no，要能无人值守地自己发。
  assert.equal(DEFAULT_CONFIG.confirmWrites, false);
  assert.equal(normalizeConfig({}).config.confirmWrites, false);
});

test("confirmWrites 可以显式设回 true，且坏值回退 false", () => {
  assert.equal(normalizeConfig({ confirmWrites: true }).config.confirmWrites, true);
  const bad = normalizeConfig({ confirmWrites: "yes" });
  assert.equal(bad.config.confirmWrites, false);
  assert.equal(bad.notices.length, 1);
});

test("审计日志能记下每次写操作（闸门关掉后唯一的追溯手段）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bili-audit-"));
  try {
    appendWriteAudit("bili_comment", 'BV1xx 内容 "你好"', dir);
    appendWriteAudit("bili_whale dm", "--msg 私信内容 --go", dir);
    const lines = (await readFile(join(dir, "writes.log"), "utf8")).trim().split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[0], /bili_comment/);
    assert.match(lines[1], /bili_whale dm/);
    // 每行以 ISO 时间戳开头
    assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("审计把换行压成一行，避免伪造多条记录", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bili-audit-"));
  try {
    appendWriteAudit("x", "第一行\n伪造的第二行", dir);
    const lines = (await readFile(join(dir, "writes.log"), "utf8")).trim().split("\n");
    assert.equal(lines.length, 1, "换行必须被压掉，否则可伪造审计记录");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
