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
