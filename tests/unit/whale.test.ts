import assert from "node:assert/strict";
import test from "node:test";
import { READ_COMMANDS, WRITE_COMMANDS, isDryRunArgs, isKnownCommand, isWriteCommand, runWhale } from "../../src/whale.js";

test("只读命令不触发确认闸门", () => {
  for (const cmd of ["search", "subtitles", "debrief", "deps", "quota", "diary", "thread"]) {
    assert.equal(isWriteCommand(cmd), false, `${cmd} 应判为只读`);
  }
});

test("写命令一律触发闸门（含删除评论）", () => {
  for (const cmd of ["comment", "comment-del", "dm", "dynamic", "dynamic-image", "danmaku", "reply-draft"]) {
    assert.equal(isWriteCommand(cmd), true, `${cmd} 应判为写`);
  }
});

test("未知命令按写处理（fail closed）", () => {
  assert.equal(isKnownCommand("rm-rf"), false);
  assert.equal(isWriteCommand("rm-rf"), true, "未知命令不能默认可执行");
  assert.equal(isWriteCommand(""), true);
});

test("读写清单没有重叠", () => {
  const overlap = (READ_COMMANDS as readonly string[]).filter((c) =>
    (WRITE_COMMANDS as readonly string[]).includes(c),
  );
  assert.deepEqual(overlap, [], `读写清单不应有重叠：${overlap.join(",")}`);
});

test("runWhale 真跑一个只读命令并返回结构", async () => {
  // whale 的 help 不需要凭证、不联网，适合做冒烟。
  const result = await runWhale("help");
  assert.equal(result.ok, true, `help 应成功，stderr: ${result.stderr}`);
  assert.equal(result.command, "help");
  assert.match(result.stdout, /命令:/);
});

test("runWhale 对未知命令返回 ok:false 而不是抛异常", async () => {
  const result = await runWhale("no-such-command");
  assert.equal(result.ok, false);
  assert.ok(result.exitCode !== 0);
});

test("--dry / --status 属于预览，不该触发确认", () => {
  // 曾因只按命令名判定，连 `dm --dry` 都弹确认框：用户为"预览"点同意，
  // 会训练出闭眼确认的习惯，反而削弱闸门。
  assert.equal(isDryRunArgs(["--dry"]), true);
  assert.equal(isDryRunArgs(["--status"]), true);
  assert.equal(isDryRunArgs(["--check"]), true);
  assert.equal(isDryRunArgs(["--msg", "hi", "--dry"]), true);
  // 真发的参数不算预览
  assert.equal(isDryRunArgs(["--go"]), false);
  assert.equal(isDryRunArgs(["--msg", "hi", "--go"]), false);
  assert.equal(isDryRunArgs([]), false);
});

// ── v0.3.0 新命令的分类 ─────────────────────────────────────────────────────
// 默认"未知一律当写"能兜底，但只读命令被误当写会多弹一次确认；
// 真正的风险在反方向：把 fav --go / auto 当成读就会绕过闸门和审计。

test("v0.3.0 的只读命令被正确识别（不会被迫走写闸门）", () => {
  for (const cmd of ["selftest", "dyn-keywords", "dyn-page"]) {
    assert.equal(isWriteCommand(cmd), false, `${cmd} 不应被当成写操作`);
  }
});

test("收藏与直播间自动回复必须算写操作", () => {
  // fav 会改收藏夹（对外可见状态变了）；auto 会往直播间发弹幕。
  // 这两个如果漏判，就等于绕过 confirmWrites 与 writes.log。
  assert.equal(isWriteCommand("fav"), true);
  assert.equal(isWriteCommand("auto"), true);
});

test("fav --dry 仍然算预览（不该逼用户确认预览）", () => {
  assert.equal(isDryRunArgs(["BV1xxx", "--reason", "想再看", "--dry"]), true);
});
