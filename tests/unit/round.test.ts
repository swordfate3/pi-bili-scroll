import assert from "node:assert/strict";
import test from "node:test";
import { waitForRound, type RoundWaitContext } from "../../src/round.js";

/** 假 ctx：idle 序列按顺序返回，用完后恒定返回最后一个值。 */
function fakeCtx(idleSequence: boolean[]): RoundWaitContext & {
  waited: number;
  idleQueries: number;
} {
  let index = 0;
  const state = {
    waited: 0,
    idleQueries: 0,
    isIdle() {
      state.idleQueries += 1;
      const value = idleSequence[Math.min(index, idleSequence.length - 1)];
      index += 1;
      return value ?? true;
    },
    async waitForIdle() {
      state.waited += 1;
    },
  };
  return state;
}

test("send 之后先等它真的起来，再等它结束", async () => {
  // 起始仍空闲（模拟 sendUserMessage 还没生效），之后进入运行中。
  const ctx = fakeCtx([true, false, false]);
  await waitForRound(ctx, 500);
  assert.equal(ctx.waited, 1, "必须最终调用 waitForIdle");
  assert.ok(ctx.idleQueries >= 2, "必须先轮询到非空闲，不能一上来就 waitForIdle");
});

test("已经在运行时不做多余轮询，直接等结束", async () => {
  const ctx = fakeCtx([false]);
  await waitForRound(ctx, 500);
  assert.equal(ctx.idleQueries, 1);
  assert.equal(ctx.waited, 1);
});

test("轮次始终没起来时按超时兜底，不会挂死", async () => {
  // 永远空闲：模拟这一轮根本没起来（例如模型未配置）。
  const ctx = fakeCtx([true]);
  const startedAt = Date.now();
  await waitForRound(ctx, 120);
  const elapsed = Date.now() - startedAt;
  assert.equal(ctx.waited, 1, "超时后仍应调用一次 waitForIdle");
  assert.ok(elapsed >= 100, `应等待到超时，实际 ${elapsed}ms`);
  assert.ok(elapsed < 2_000, `不应无限等待，实际 ${elapsed}ms`);
});
