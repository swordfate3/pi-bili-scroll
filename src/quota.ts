/**
 * quota.ts —— 发评论的限额闸。
 *
 * ## 为什么限额要写成代码
 * 闸门（逐次确认）关掉之后，唯一还在防"刷屏封号"的就是限额。而这种东西靠模型自觉 =
 * 等于没有：模型每次都觉得"this one is worth it"。
 * 所以做成**确定性判据**：超了就拒，不给例外，错误信息写清是哪一条撞的。
 *
 * ## 三个判据（都可在 config.json 调）
 * - `maxCommentsPerDay`      每天最多发几条（默认 3）
 * - `minMinutesBetweenComments` 两条之间至少隔几分钟（默认 30）
 * - `sameVideoCooldownDays`  同一个视频 N 天内只发一次（默认 7，与 whale 的口径一致）
 *
 * ## 状态
 * `~/.local/share/bili-scroll/comment-quota.json`，按本地日期记：
 * `{ days: { "YYYY-MM-DD": { count, lastAt } }, perVideo: { BVxxx: "ISO" } }`
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { dayKey } from "./home.js";

export interface QuotaLimits {
  maxCommentsPerDay: number;
  minMinutesBetweenComments: number;
  sameVideoCooldownDays: number;
}

export const DEFAULT_LIMITS: QuotaLimits = {
  maxCommentsPerDay: 3,
  minMinutesBetweenComments: 30,
  sameVideoCooldownDays: 7,
};

export interface QuotaState {
  /** 按日期记当天发了多少、最后一次是什么时候 */
  days: Record<string, { count: number; lastAt?: string }>;
  /** 每个视频最后一次发评论的时间 */
  perVideo: Record<string, string>;
}

export const EMPTY_STATE: QuotaState = { days: {}, perVideo: {} };

/** 只保留最近 N 天的历史，避免状态文件无限长。 */
export function pruneState(state: QuotaState, now: Date, keepDays = 30): QuotaState {
  const cutoff = new Date(now.getTime() - keepDays * 24 * 60 * 60 * 1000);
  const days: QuotaState["days"] = {};
  for (const [day, value] of Object.entries(state.days ?? {})) {
    const parsed = new Date(`${day}T00:00:00`);
    if (!Number.isNaN(parsed.getTime()) && parsed >= cutoff) days[day] = value;
  }
  const perVideo: QuotaState["perVideo"] = {};
  const cooldownMs = keepDays * 24 * 60 * 60 * 1000;
  for (const [bvid, iso] of Object.entries(state.perVideo ?? {})) {
    const t = new Date(iso).getTime();
    if (Number.isFinite(t) && now.getTime() - t <= cooldownMs) perVideo[bvid] = iso;
  }
  return { days, perVideo };
}

export interface QuotaDecision {
  allowed: boolean;
  /** 拒绝时说明撞了哪条限制 */
  reason?: string;
  /** 放行时给出剩余额度，便于提示 */
  remainingToday?: number;
}

/** 判据（纯函数，注入 now 便于测试）。 */
export function checkQuota(
  state: QuotaState,
  bvid: string,
  now: Date,
  limits: QuotaLimits = DEFAULT_LIMITS,
): QuotaDecision {
  const today = dayKey(now);
  const used = state.days?.[today]?.count ?? 0;
  const remaining = Math.max(0, limits.maxCommentsPerDay - used);

  if (used >= limits.maxCommentsPerDay) {
    return {
      allowed: false,
      reason: `今天已发 ${used} 条评论，达到上限 ${limits.maxCommentsPerDay} 条（maxCommentsPerDay）`,
      remainingToday: 0,
    };
  }

  const lastAt = state.days?.[today]?.lastAt;
  if (lastAt) {
    const gapMin = (now.getTime() - new Date(lastAt).getTime()) / 60000;
    // 负值 = 记录时间在未来。实测踩过：补记历史评论时写了个晚于当前的时间戳，
    // 于是算出"距上条只过了 -13 分钟"。这种情况说明记录不可信（时钟被改/写错），
    // 不能据此拒绝，否则会一直卡死；放行并由调用方去修正数据。
    if (Number.isFinite(gapMin) && gapMin >= 0 && gapMin < limits.minMinutesBetweenComments) {
      return {
        allowed: false,
        reason:
          `距上一条评论只过了 ${Math.floor(gapMin)} 分钟，` +
          `至少要隔 ${limits.minMinutesBetweenComments} 分钟（minMinutesBetweenComments）`,
        remainingToday: remaining,
      };
    }
  }

  const lastForVideo = state.perVideo?.[bvid];
  if (lastForVideo) {
    const days = (now.getTime() - new Date(lastForVideo).getTime()) / 86400000;
    if (Number.isFinite(days) && days >= 0 && days < limits.sameVideoCooldownDays) {
      return {
        allowed: false,
        reason:
          `这个视频 ${days.toFixed(1)} 天前已经评论过，` +
          `${limits.sameVideoCooldownDays} 天内只发一次（sameVideoCooldownDays）`,
        remainingToday: remaining,
      };
    }
  }

  return { allowed: true, remainingToday: remaining };
}

/** 记一笔（发成功后调用）。 */
export function recordComment(state: QuotaState, bvid: string, now: Date): QuotaState {
  const today = dayKey(now);
  const day = state.days?.[today] ?? { count: 0 };
  return {
    days: { ...state.days, [today]: { count: day.count + 1, lastAt: now.toISOString() } },
    perVideo: { ...state.perVideo, [bvid]: now.toISOString() },
  };
}

export async function loadQuota(path: string): Promise<QuotaState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return { days: {}, perVideo: {} };
    const record = parsed as Partial<QuotaState>;
    return {
      days: record.days && typeof record.days === "object" ? record.days : {},
      perVideo: record.perVideo && typeof record.perVideo === "object" ? record.perVideo : {},
    };
  } catch {
    return { days: {}, perVideo: {} };
  }
}

/** 原子写（先写临时文件再 rename），权限 600。 */
export async function saveQuota(path: string, state: QuotaState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

export function quotaPath(home: string): string {
  return join(home, "comment-quota.json");
}
