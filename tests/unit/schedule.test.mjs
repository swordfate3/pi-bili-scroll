import assert from "node:assert/strict";
import test from "node:test";
import {
  dayKey,
  fmt,
  minutesOfDay,
  needsCatchUp,
  notifyTelegram,
  parseHHMM,
  planToday,
  shouldRun,
  windowRange,
} from "../../scripts/schedule-core.mjs";

/** 按顺序吐出预设值，用完后重复最后一个 —— 让"窗口/位置/跳过"三次取值可控。 */
function seqRng(values) {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

test("parseHHMM 接受合法值、拒绝非法值", () => {
  assert.equal(parseHHMM("20:00"), 1200);
  assert.equal(parseHHMM("0:05"), 5);
  assert.equal(parseHHMM("23:59"), 1439);
  for (const bad of ["24:00", "20:60", "8", "", null, "aa:bb", "-1:00"]) {
    assert.equal(parseHHMM(bad), null, `${bad} 应被拒绝`);
  }
});

test("windowRange 处理跨午夜", () => {
  assert.deepEqual(windowRange({ start: "20:00", end: "22:00" }), [1200, 1320]);
  assert.deepEqual(windowRange({ start: "22:00", end: "02:00" }), [1320, 1560]);
  assert.equal(windowRange({ start: "x", end: "22:00" }), null);
});

test("fmt 循环到 24 小时内", () => {
  assert.equal(fmt(1200), "20:00");
  assert.equal(fmt(1500), "01:00");
  assert.equal(fmt(0), "00:00");
});

test("planToday：rng 恒定 0 时挑窗口起点，不跳过", () => {
  const plan = planToday({
    now: new Date(2026, 9, 19, 10, 0),
    windows: [{ start: "20:00", end: "22:00", wakes: 1 }],
    skipChance: 0.3,
    rng: seqRng([0, 0, 0.9]), // 挑窗口 0 → 位置 0 → 不跳过
  });
  assert.equal(plan.skip, false);
  assert.equal(plan.at, 1200); // 窗口起点
  assert.equal(plan.date, "2026-10-19");
});

test("planToday：rng 落在 skipChance 内 → 选择不看，且没有 at", () => {
  const plan = planToday({
    now: new Date(2026, 9, 19, 10, 0),
    windows: [{ start: "20:00", end: "22:00" }],
    skipChance: 0.3,
    rng: seqRng([0, 0, 0.1]), // 第三次 0.1 < 0.3 → 不想看
  });
  assert.equal(plan.skip, true);
  assert.equal(plan.at, null);
  assert.match(plan.reason, /不想看/);
});

test("planToday：没有窗口时安全退化（skip，不崩）", () => {
  const plan = planToday({ now: new Date(), windows: [], rng: seqRng([0]) });
  assert.equal(plan.skip, true);
  assert.match(plan.reason, /没有配置有效窗口/);
});

test("planToday：wakes 受 maxWakes 上限约束", () => {
  const plan = planToday({
    now: new Date(2026, 9, 19, 10, 0),
    windows: [{ start: "20:00", end: "22:00", wakes: 99 }],
    maxWakes: 2,
    skipChance: 0,
    rng: seqRng([0.9, 0.5, 0.9]),
  });
  assert.equal(plan.wakes, 2);
});

test("shouldRun：没到点不跑，到点才跑，跑过不再跑", () => {
  const state = { date: dayKey(new Date(2026, 9, 19, 10, 0)), at: 1200, fired: false, skip: false };
  assert.equal(shouldRun(state, new Date(2026, 9, 19, 19, 59)).due, false);
  assert.equal(shouldRun(state, new Date(2026, 9, 19, 20, 0)).due, true);
  assert.equal(shouldRun({ ...state, fired: true }, new Date(2026, 9, 19, 21, 0)).due, false);
});

test("shouldRun：昨天的计划不算今天", () => {
  const state = { date: "2026-10-18", at: 1200, fired: false, skip: false };
  const r = shouldRun(state, new Date(2026, 9, 19, 21, 0));
  assert.equal(r.due, false);
  assert.match(r.why, /还没做计划/);
});

test("shouldRun：skip 的日子不跑", () => {
  const state = { date: dayKey(new Date(2026, 9, 19, 10, 0)), at: null, skip: true, reason: "不想看" };
  assert.equal(shouldRun(state, new Date(2026, 9, 19, 23, 0)).due, false);
});

test("needsCatchUp：过点一小时且今天没报告 → 补跑", () => {
  const now = new Date(2026, 9, 19, 22, 30);
  const state = { date: dayKey(now), at: 1200, fired: false, skip: false };
  assert.equal(needsCatchUp(state, now, () => false), true);
  assert.equal(needsCatchUp(state, now, () => true), false); // 有报告就不补
  assert.equal(needsCatchUp({ ...state, fired: true }, now, () => false), false);
  assert.equal(needsCatchUp(state, new Date(2026, 9, 19, 20, 30), () => false), false); // 才过半小时
});

test("notifyTelegram：没配 token/chatId 时静默跳过，不发请求", async () => {
  let called = false;
  const post = async () => {
    called = true;
    return { status: 200, body: { ok: true } };
  };
  assert.deepEqual(await notifyTelegram({ token: "", chatId: "", text: "x", post }), {
    sent: false,
    reason: "未配置 TG bot token / chat_id",
  });
  assert.equal(called, false, "没配置就不该发请求");
});

test("notifyTelegram：成功返回 sent:true", async () => {
  const post = async () => ({ status: 200, body: { ok: true } });
  assert.deepEqual(await notifyTelegram({ token: "t", chatId: "c", text: "hi", post }), { sent: true });
});

test("notifyTelegram：HTTP 失败返回结构化原因，不抛异常", async () => {
  const post = async () => ({ status: 401, body: { ok: false, description: "Unauthorized" } });
  const r = await notifyTelegram({ token: "t", chatId: "c", text: "hi", post });
  assert.equal(r.sent, false);
  assert.match(r.reason, /401/);
  assert.match(r.reason, /Unauthorized/);
});

test("notifyTelegram：底层抛错也收敛成 sent:false", async () => {
  const post = async () => {
    throw new Error("network down");
  };
  const r = await notifyTelegram({ token: "t", chatId: "c", text: "hi", post });
  assert.equal(r.sent, false);
  assert.match(r.reason, /network down/);
});

test("minutesOfDay 用本地时间", () => {
  assert.equal(minutesOfDay(new Date(2026, 9, 19, 20, 30)), 1230);
});
