import assert from "node:assert/strict";
import test from "node:test";
import { findText, isWriteInvocation } from "../../src/extension.js";

test("识别经 mcp 代理的 bili_reply 调用", () => {
  const input = {
    tool: "pi-bili-scroll__bilibili-write__bili_reply",
    args: { bvid: "BV1xx", text: "写得不错" },
  };
  assert.equal(isWriteInvocation("mcp", input), true);
});

test("识别命名空间形式与直接工具名", () => {
  assert.equal(isWriteInvocation("mcp__pi_bili_scroll__bilibili_write", { tool: "bili_reply" }), true);
  assert.equal(isWriteInvocation("bili_reply", {}), true);
  assert.equal(isWriteInvocation("x__bili_reply", {}), true);
});

test("读工具不被误拦", () => {
  assert.equal(
    isWriteInvocation("mcp", { tool: "pi-bili-scroll__bilibili__search_bilibili_videos", args: { query: "AI" } }),
    false,
  );
  assert.equal(isWriteInvocation("mcp", { tool: "search_bilibili_videos" }), false);
  assert.equal(isWriteInvocation("bash", { command: "echo bili_reply" }), false);
  assert.equal(isWriteInvocation("read", { path: "/tmp/x" }), false);
});

test("findText 能从嵌套参数里取出评论正文", () => {
  assert.equal(findText({ args: { text: "  hi  " } }), "hi");
  assert.equal(findText({ tool: "x", args: { nested: [{ text: "深层" }] } }), "深层");
  assert.equal(findText({ args: {} }), null);
  assert.equal(findText({ text: "   " }), null);
  assert.equal(findText("string"), null);
  assert.equal(findText(null), null);
});

test("findText 有深度上限，不会因自引用结构卡死", () => {
  const deep: Record<string, unknown> = {};
  let cursor = deep;
  for (let i = 0; i < 20; i += 1) {
    const next: Record<string, unknown> = {};
    cursor.next = next;
    cursor = next;
  }
  assert.doesNotThrow(() => findText(deep));
});
