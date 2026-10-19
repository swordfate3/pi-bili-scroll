/**
 * round.ts —— "等这一轮真的跑完"。
 *
 * 单独成模块的原因和 prompt.ts 一样：这属于**容易被忽略但会静默出错**的逻辑，
 * 抽出来才能用假 ctx 做确定性测试（真跑一轮要模型和网络，测不了）。
 */

export interface RoundWaitContext {
  isIdle(): boolean;
  waitForIdle(): Promise<void>;
}

const DEFAULT_START_TIMEOUT_MS = 2_000;
const POLL_INTERVAL_MS = 25;

/**
 * ⚠️ `sendUserMessage()` 是**异步生效**的：它内部调 `prompt()`，而 `prompt()` 在第一个
 * `await` 处就让出，把 agent 标成"运行中"是之后的事。所以紧接着调 `waitForIdle()` 会因为
 * "此刻还空闲"直接返回 —— 等于没等。这里先轮询等它起来（isIdle 变 false），再等它结束。
 *
 * `startTimeoutMs` 是兜底：万一这一轮根本没起来（例如模型未配置、内部报错），
 * 不能让命令处理器挂死；超时就退化成"只等 waitForIdle 一次"。
 */
export async function waitForRound(
  ctx: RoundWaitContext,
  startTimeoutMs: number = DEFAULT_START_TIMEOUT_MS,
): Promise<void> {
  const startedAt = Date.now();
  while (ctx.isIdle() && Date.now() - startedAt < startTimeoutMs) {
    await sleep(POLL_INTERVAL_MS);
  }
  await ctx.waitForIdle();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
