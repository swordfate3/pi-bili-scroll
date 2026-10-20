import assert from "node:assert/strict";
import test from "node:test";
import { buildAtField, buildCommentBody, buildCookie } from "../../src/comment.js";
import { isWriteInvocation } from "../../src/extension.js";

test("buildAtField 生成单对象 JSON（数组格式实测无效）", () => {
  const field = buildAtField({ mid: "146106725", name: "微小deepseek" });
  assert.equal(field, '{"uid":146106725,"name":"微小deepseek"}');
  assert.equal(JSON.parse(field).uid, 146106725, "uid 必须是数字");
});

test("buildCommentBody：不给 at 就没有 at 字段", () => {
  const body = buildCommentBody({ aid: 117461382864435, text: "你好", csrf: "abc" });
  assert.equal(body.get("oid"), "117461382864435");
  assert.equal(body.get("type"), "1");
  assert.equal(body.get("plat"), "1");
  assert.equal(body.get("csrf"), "abc");
  assert.equal(body.get("message"), "你好");
  assert.equal(body.has("at"), false, "没给 at 就不该出现该字段");
});

test("buildCommentBody：给了 at 就带上正确的 JSON", () => {
  const body = buildCommentBody({
    aid: 1,
    text: "测试 @某人",
    csrf: "c",
    at: { mid: "146106725", name: "微小deepseek" },
  });
  assert.equal(body.get("at"), '{"uid":146106725,"name":"微小deepseek"}');
});

test("buildCookie 组装四个 cookie，缺 buvid3 时不影响", () => {
  assert.equal(
    buildCookie({ sessdata: "s", bili_jct: "j", dedeuserid: "9", buvid3: "b" }),
    "SESSDATA=s; bili_jct=j; DedeUserID=9; buvid3=b",
  );
  assert.equal(
    buildCookie({ sessdata: "s", bili_jct: "j", dedeuserid: "9" }),
    "SESSDATA=s; bili_jct=j; DedeUserID=9",
  );
});

test("bili_comment 被识别为写操作（要过确认闸门）", () => {
  assert.equal(isWriteInvocation("bili_comment", { bvid: "BV1x", text: "hi" }), true);
});

// ── 假成功复核 ──────────────────────────────────────────────────────────────
// B站 的 `code=0` 不代表公开可见：评论入库、登录态能看，但匿名查不到、state=17。
// 这里用假 fetch 把三种组合钉住，免得以后又把"接口成功"当成"发出去了"。

import { checkCommentVisibility } from "../../src/comment.js";

function stubFetch(handler: (url: string, headers: Record<string, string>) => unknown) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
    const body = handler(String(url), init?.headers ?? {});
    return { json: async () => body } as unknown as Response;
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test("匿名能查到 + 登录态能查到 → 真公开", async () => {
  const restore = stubFetch(() => ({ code: 0, data: { root: { state: 0 } } }));
  try {
    const v = await checkCommentVisibility({ aid: 1, rpid: 2, cookie: "SESSDATA=x" });
    assert.equal(v.anonymousVisible, true);
    assert.equal(v.loggedInVisible, true);
    assert.equal(v.state, 0);
    assert.equal(v.public, true);
  } finally {
    restore();
  }
});

test("登录态可见但匿名查不到 → 判为假成功（state=17）", async () => {
  // 匿名请求不带 cookie，返回 B站 的“没有该评论”；登录态带 cookie 能读到 state=17
  const restore = stubFetch((_url, headers) =>
    headers.cookie
      ? { code: 0, data: { root: { state: 17 } } }
      : { code: 12006, message: "没有该评论" },
  );
  try {
    const v = await checkCommentVisibility({ aid: 1, rpid: 2, cookie: "SESSDATA=x" });
    assert.equal(v.anonymousVisible, false);
    assert.equal(v.loggedInVisible, true);
    assert.equal(v.state, 17);
    assert.equal(v.public, false, "匿名看不到就不算公开 —— 这是这条测试存在的理由");
  } finally {
    restore();
  }
});

test("两边都查不到 → 真的不存在", async () => {
  const restore = stubFetch(() => ({ code: 12006, message: "没有该评论" }));
  try {
    const v = await checkCommentVisibility({ aid: 1, rpid: 2, cookie: "SESSDATA=x" });
    assert.equal(v.anonymousVisible, false);
    assert.equal(v.loggedInVisible, false);
    assert.equal(v.public, false);
  } finally {
    restore();
  }
});

test("请求整体失败时不误报成公开", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  try {
    const v = await checkCommentVisibility({ aid: 1, rpid: 2, cookie: "" });
    assert.equal(v.public, false, "查不到必须按“未公开”处理，不能乐观");
    assert.equal(v.state, null);
  } finally {
    globalThis.fetch = original;
  }
});
