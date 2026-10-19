import assert from "node:assert/strict";
import test from "node:test";
import {
  CONSECUTIVE_FAILURE_LIMIT,
  DEFAULT_READ_LIMITS,
  EMPTY_COUNTER,
  classifyRead,
  checkRead,
  settleRead,
} from "../../src/readlimit.js";

test("识别 whale 的普通读与重读", () => {
  assert.equal(classifyRead("bili_whale", { command: "search" }), "light");
  assert.equal(classifyRead("bili_whale", { command: "subtitles" }), "light");
  assert.equal(classifyRead("bili_whale", { command: "comment-digest" }), "light");
  assert.equal(classifyRead("bili_whale", { command: "watch-video" }), "heavy");
  assert.equal(classifyRead("bili_whale", { command: "debrief" }), "heavy");
});

test("不碰 B站的命令不计数（否则诊断类调用也会被限）", () => {
  for (const cmd of ["help", "deps", "session", "diary", "quota", "notify"]) {
    assert.equal(classifyRead("bili_whale", { command: cmd }), null, `${cmd} 不该计数`);
  }
});

test("写命令不算读（另有写闸门管）", () => {
  for (const cmd of ["comment", "dm", "dynamic", "danmaku"]) {
    assert.equal(classifyRead("bili_whale", { command: cmd }), null);
  }
});

test("识别 MCP 读工具", () => {
  assert.equal(classifyRead("mcp", { tool: "pi-bili-scroll__bilibili_search_bilibili_videos" }), "light");
  assert.equal(classifyRead("mcp", { tool: "x_get_video_transcript" }), "light");
  assert.equal(classifyRead("mcp__pi_bili_scroll__bilibili", { tool: "get_video_comments" }), "light");
  // 非读工具
  assert.equal(classifyRead("mcp", { tool: "whatever__bili_reply" }), null);
  assert.equal(classifyRead("bash", { command: "ls" }), null);
});

test("普通读超过上限就拒，并说明理由", () => {
  let counter = { ...EMPTY_COUNTER };
  for (let i = 0; i < DEFAULT_READ_LIMITS.maxReadsPerRound; i += 1) {
    const d = checkRead(counter, "light");
    assert.equal(d.allowed, true, `第 ${i + 1} 次应放行`);
    counter = d.next!;
  }
  const blocked = checkRead(counter, "light");
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason ?? "", /maxReadsPerRound/);
  assert.match(blocked.reason ?? "", /412/);
});

test("重读单独一档：上限更小，且也计入总数", () => {
  let counter = { ...EMPTY_COUNTER };
  for (let i = 0; i < DEFAULT_READ_LIMITS.maxHeavyReadsPerRound; i += 1) {
    const d = checkRead(counter, "heavy");
    assert.equal(d.allowed, true);
    counter = d.next!;
  }
  const blocked = checkRead(counter, "heavy");
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason ?? "", /maxHeavyReadsPerRound/);
  // 重读占的名额也算进总数
  assert.equal(counter.light + counter.heavy, DEFAULT_READ_LIMITS.maxHeavyReadsPerRound);
});

test("限额可配：上限设 0 就一次都不许读", () => {
  const d = checkRead(EMPTY_COUNTER, "light", { maxReadsPerRound: 0, maxHeavyReadsPerRound: 0 });
  assert.equal(d.allowed, false);
});

test("放行时返回已加一的计数器，避免调用方忘记录账", () => {
  const d = checkRead({ light: 2, heavy: 1, consecutiveFailures: 0 }, "heavy");
  assert.equal(d.allowed, true);
  assert.deepEqual(d.next, { light: 2, heavy: 2, consecutiveFailures: 0 });
});

test("失败的读取要退还额度（今天 10 次里 4 次白扣的教训）", () => {
  const afterReserve = checkRead(EMPTY_COUNTER, "light").next!;
  assert.equal(afterReserve.light, 1);
  // 结果回来是失败 → 退还，但记一次连续失败
  const refunded = settleRead(afterReserve, "light", false);
  assert.equal(refunded.light, 0, "失败的读取不该占用额度");
  assert.equal(refunded.consecutiveFailures, 1);
  // 成功 → 额度留着，连续失败清零
  const settled = settleRead(afterReserve, "light", true);
  assert.equal(settled.light, 1);
  assert.equal(settled.consecutiveFailures, 0);
});

test("连续失败到阈值就熔断，别再白试", () => {
  let c = { ...EMPTY_COUNTER };
  for (let i = 0; i < CONSECUTIVE_FAILURE_LIMIT; i += 1) {
    assert.equal(checkRead(c, "light").allowed, true, `第 ${i + 1} 次还允许试`);
    c = settleRead(checkRead(c, "light").next!, "light", false);
  }
  const blocked = checkRead(c, "light");
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason ?? "", /连续 \d+ 次读取失败/);
  assert.match(blocked.reason ?? "", /风控|HTML/);
});
