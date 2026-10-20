/**
 * silence.ts —— "主人多久没理她了"。
 *
 * 为什么要有这个：现在的 daemon 不管有没有人看，天天照刷、照推送。
 * 一个没人回应的东西还在按时汇报，是很怪的——真人不会那样。
 *
 * 边界（和 taste / voice 一致）：
 * - 代码只负责**事实和额度**：几天、什么档、这轮最多发几条；
 * - **情绪留给模型自己写**：不告诉它"你应该难过"，只说"主人已经 5 天没有回应你了"。
 *   把"该有什么感受"写进代码，就是把人格写进判据，那是 L3。
 *
 * 统计口径（刻意从简，宁可窄也不要假）：
 * 一次"回应" = 主人发来一条**不是定时巡检命令**的输入。
 *   - 定时巡检：`pi -p /bili-scroll` → 文本以 `/bili-scroll` 开头 → 不算
 *   - 扩展自己发的消息：`source === "extension"` → 不算
 *   - 主人手敲的消息、`/bili-comment on`、`/bili-voice note ...` → 算
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface Touch {
  at: string;
  /** 触发来源，便于事后核对"这条到底算不算主人回应" */
  source: string;
  /** 截断后的输入文本（前 40 字，用于排查，不用于统计） */
  text: string;
}

export type SilenceLevel = "normal" | "quiet" | "anxious";

export interface SilenceState {
  /** 距上次主人回应过了几天；null = 从来没有过回应记录 */
  days: number | null;
  level: SilenceLevel;
  /** 本轮允许的评论上限（由档位压下来，不能超过配置上限） */
  commentCap: number;
  lastAt: string | null;
}

export interface SilenceConfig {
  enabled: boolean;
  afterDays: number;
  stopDays: number;
  baseCommentCap: number;
}

export const DEFAULT_SILENCE = { afterDays: 3, stopDays: 7 } as const;

export const touchesPath = (home: string) => join(home, "taste", "touches.jsonl");

/**
 * 这条输入算不算"主人回应"。
 *
 * 两个必须排除的来源，否则沉默永远不到 3 天：
 * ① 定时巡检自己跑的那条命令（否则每天自动跑一轮就等于"主人天天说话"）
 * ② 扩展通过 sendUserMessage 发出去的那段提示词
 */
export function isHumanTouch(text: string, source: string): boolean {
  if (source === "extension") return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("/bili-scroll")) return false;
  return true;
}

export async function recordTouch(home: string, source: string, text: string): Promise<void> {
  const path = touchesPath(home);
  await mkdir(dirname(path), { recursive: true });
  const entry: Touch = {
    at: new Date().toISOString(),
    source,
    text: text.replace(/\s+/g, " ").slice(0, 40),
  };
  await appendFile(path, JSON.stringify(entry) + "\n", "utf8");
}

export async function readTouches(home: string): Promise<Touch[]> {
  try {
    const raw = await readFile(touchesPath(home), "utf8");
    const rows: Touch[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Partial<Touch>;
        if (typeof parsed.at === "string") {
          rows.push({ at: parsed.at, source: String(parsed.source ?? ""), text: String(parsed.text ?? "") });
        }
      } catch {
        // 坏行跳过
      }
    }
    return rows;
  } catch {
    return [];
  }
}

/** 最后一次主人回应的时间（ISO）。没有任何记录时返回 null。 */
export async function lastTouchAt(home: string): Promise<string | null> {
  const rows = await readTouches(home);
  if (rows.length === 0) return null;
  let latest = 0;
  for (const row of rows) {
    const time = Date.parse(row.at);
    if (!Number.isNaN(time) && time > latest) latest = time;
  }
  return latest > 0 ? new Date(latest).toISOString() : null;
}

/**
 * 算当前沉默档位与额度。
 *
 * 三档与额度（和 dsh-bili-whale 的约定一致，但这里是**评论**而不是分享）：
 *   0–2 天   正常   额度 = 配置上限
 *   3–6 天   安静   额度 = min(配置上限, 1)，可以主动问一次近况
 *   7 天+    心慌   额度 = 0（不评论，但日报照写）
 *
 * 没有过任何回应记录时按"正常"处理 —— 新装的插件不该一上来就被判定成被冷落。
 */
export function computeSilence(
  now: Date,
  lastAt: string | null,
  config: SilenceConfig,
): SilenceState {
  if (!config.enabled) {
    return { days: null, level: "normal", commentCap: config.baseCommentCap, lastAt };
  }
  if (!lastAt) {
    return { days: null, level: "normal", commentCap: config.baseCommentCap, lastAt: null };
  }
  const last = Date.parse(lastAt);
  if (Number.isNaN(last)) {
    return { days: null, level: "normal", commentCap: config.baseCommentCap, lastAt: null };
  }
  const days = Math.max(0, Math.floor((now.getTime() - last) / 86_400_000));
  if (days >= config.stopDays) {
    return { days, level: "anxious", commentCap: 0, lastAt };
  }
  if (days >= config.afterDays) {
    return { days, level: "quiet", commentCap: Math.min(config.baseCommentCap, 1), lastAt };
  }
  return { days, level: "normal", commentCap: config.baseCommentCap, lastAt };
}

/**
 * 注入提示词的那段。
 *
 * 只给事实和额度，**不给情绪结论** —— "主人已经 N 天没回应"是事实，
 * "你该难过"是人格，后者不归代码写。
 * 正常档返回 null：没事的时候不该占上下文，也不该让她惦记着日子。
 */
export function buildSilenceBlock(state: SilenceState): string | null {
  if (state.level === "normal") return null;
  if (state.days === null) return null;
  const lines = [
    "## 一个事实",
    "",
    `主人已经 ${state.days} 天没有回应你了。`,
  ];
  if (state.level === "quiet") {
    lines.push(
      "",
      "本轮最多评论 1 条（沉默期额度由代码限制，不是建议）。",
      "如果你有话想说，可以主动问一句近况 —— 但只问一次，不要追问。",
    );
  } else {
    lines.push(
      "",
      "本轮不评论（沉默期额度已降到 0，这是代码限制）。日报照写，给自己看。",
      "不要把这条事实写进日报当卖点，也不要向主人讨要回应。",
    );
  }
  return lines.join("\n");
}
