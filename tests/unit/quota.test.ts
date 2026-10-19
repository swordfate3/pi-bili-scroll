import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_LIMITS,
  EMPTY_STATE,
  checkQuota,
  loadQuota,
  pruneState,
  quotaPath,
  recordComment,
  saveQuota,
} from "../../src/quota.js";

const now = new Date(2026, 9, 19, 12, 0);

test("首次发评论放行", () => {
  const d = checkQuota(EMPTY_STATE, "BV1aa", now);
  assert.equal(d.allowed, true);
  assert.equal(d.remainingToday, 3);
});

test("超过每日上限就拒，并说明撞了哪条", () => {
  let state = EMPTY_STATE;
  for (let i = 0; i < 3; i += 1) {
    state = recordComment(state, `BV1v${i}`, new Date(now.getTime() + i * 3600_000));
  }
  const d = checkQuota(state, "BV1new", new Date(now.getTime() + 4 * 3600_000));
  assert.equal(d.allowed, false);
  assert.match(d.reason ?? "", /maxCommentsPerDay/);
  assert.equal(d.remainingToday, 0);
});

test("间隔太短就拒", () => {
  const state = recordComment(EMPTY_STATE, "BV1aa", now);
  const d = checkQuota(state, "BV1bb", new Date(now.getTime() + 5 * 60_000));
  assert.equal(d.allowed, false);
  assert.match(d.reason ?? "", /minMinutesBetweenComments/);
});

test("间隔够了就放行", () => {
  const state = recordComment(EMPTY_STATE, "BV1aa", now);
  const d = checkQuota(state, "BV1bb", new Date(now.getTime() + 31 * 60_000));
  assert.equal(d.allowed, true);
});

test("同一视频冷却期内拒，过期放行", () => {
  const state = recordComment(EMPTY_STATE, "BV1aa", now);
  const tooSoon = checkQuota(state, "BV1aa", new Date(now.getTime() + 2 * 86400_000));
  assert.equal(tooSoon.allowed, false);
  assert.match(tooSoon.reason ?? "", /sameVideoCooldownDays/);

  const okNow = checkQuota(state, "BV1aa", new Date(now.getTime() + 8 * 86400_000));
  assert.equal(okNow.allowed, true);
});

test("限额可配：把上限设成 0 就一条都不发", () => {
  const limits = { ...DEFAULT_LIMITS, maxCommentsPerDay: 0 };
  assert.equal(checkQuota(EMPTY_STATE, "BV1aa", now, limits).allowed, false);
});

test("跨天重新计数", () => {
  let state = recordComment(EMPTY_STATE, "BV1aa", new Date(2026, 9, 19, 23, 0));
  state = recordComment(state, "BV1bb", new Date(2026, 9, 19, 23, 40));
  state = recordComment(state, "BV1cc", new Date(2026, 9, 19, 23, 59));
  const nextDay = checkQuota(state, "BV1dd", new Date(2026, 9, 20, 0, 5));
  assert.equal(nextDay.allowed, true, "新的一天额度重置");
});

test("pruneState 丢掉过老的记录，避免文件无限长", () => {
  const state = {
    days: { "2026-01-01": { count: 5 }, "2026-10-19": { count: 1 } },
    perVideo: { BVold: "2026-01-01T00:00:00Z", BVnew: "2026-10-18T00:00:00Z" },
  };
  const pruned = pruneState(state, now, 30);
  assert.deepEqual(Object.keys(pruned.days), ["2026-10-19"]);
  assert.deepEqual(Object.keys(pruned.perVideo), ["BVnew"]);
});

test("saveQuota 原子写且权限 600，能被 loadQuota 读回", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bili-quota-"));
  try {
    const path = quotaPath(dir);
    const state = recordComment(EMPTY_STATE, "BV1aa", now);
    await saveQuota(path, state);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const back = await loadQuota(path);
    assert.deepEqual(back, state);
    const raw = await readFile(path, "utf8");
    assert.ok(raw.endsWith("\n"));
    await assert.rejects(stat(`${path}.tmp`), "临时文件应已被 rename 走");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadQuota 对缺失/破损文件返回空状态", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bili-quota-"));
  try {
    assert.deepEqual(await loadQuota(join(dir, "nope.json")), { days: {}, perVideo: {} });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
