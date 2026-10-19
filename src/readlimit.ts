/**
 * readlimit.ts —— 每轮巡检的「读取」限额。
 *
 * ## 为什么读也要限
 * 2026-10-19 实测：一天内对同一账号/同一出口发了 100+ 次 B站请求（16 次读字幕 + 10 次读评论
 * + 14 次搜索 + 一次 35MB 视频下载…），B站 返回 **412 风控**。而那个只读服务器把 412 误标成
 * "无效响应"，让我一度误判成"服务器失效"。
 *
 * 结论：**限流风险不是只来自"发评论"，读得太猛一样会撞。** 而模型在每轮里并不会自己收敛
 * （每读一条都觉得"这条值得"），所以上限必须写成代码。
 *
 * ## 两类
 * - **普通读**（搜/字幕/评论/元数据）：便宜，一页一次
 * - **重读**（`watch-video` / `debrief`）：会下载视频、跑 ffmpeg 抽帧，几十 MB 起步
 *
 * ## 计数范围
 * 从 `/bili-scroll` 开始算一轮，直到下次 `/bili-scroll` 重置。交互式会话里如果没跑过巡检，
 * 计数从会话开始算 —— 宁可早停，也不放任无限读。
 */
import { READ_COMMANDS } from "./whale.js";

export type ReadKind = "light" | "heavy";

export interface ReadCounter {
  light: number;
  heavy: number;
}

export const EMPTY_COUNTER: ReadCounter = { light: 0, heavy: 0 };

export interface ReadLimits {
  /** 一轮内普通读的上限 */
  maxReadsPerRound: number;
  /** 一轮内"重读"（下载/抽帧）的上限 */
  maxHeavyReadsPerRound: number;
}

export const DEFAULT_READ_LIMITS: ReadLimits = {
  maxReadsPerRound: 10,
  maxHeavyReadsPerRound: 2,
};

/** 会下载视频 / 跑 ffmpeg 的命令 —— 单独一档，别和查一页字幕混着算。 */
export const HEAVY_READ_COMMANDS = new Set(["watch-video", "debrief"]);

/** 只读但**很便宜、不碰 B站**的命令，不该计数（否则会把诊断类调用也算进去）。 */
export const FREE_COMMANDS = new Set(["help", "deps", "session", "diary", "quota", "notify"]);

/**
 * 只读服务器（MCP 侧）会碰 B站 的工具名。
 *
 * ⚠️ 匹配用**裸工具名**，不加前导下划线：实际调用传的是
 * `pi-bili-scroll__bilibili_search_bilibili_videos`（服务器名与工具名之间的分隔符是 `_`，
 * 但工具名前面是 `bilibili` 的最后一个字母），加了下划线反而一处都匹配不上 —— 踩过。
 */
const MCP_READ_TOOLS = [
  "search_bilibili_videos",
  "search_bilibili_creators",
  "get_video_transcript",
  "get_video_comments",
  "get_video_metadata",
  "get_video_info",
  "get_video_chapters",
  "get_bilibili_creator_content",
  "list_bilibili_favorite_videos",
];

/**
 * 这次调用算哪一种读？不算读、或不是读操作时返回 null。
 * @param toolName 工具名（`bili_whale` / `mcp` / 命名空间代理 / 其他）
 * @param input 工具参数
 */
export function classifyRead(toolName: string, input: unknown): ReadKind | null {
  const record = (input ?? {}) as { command?: unknown; tool?: unknown; args?: unknown };

  if (toolName === "bili_whale") {
    const command = String(record.command ?? "").trim();
    if (!command) return null;
    if (FREE_COMMANDS.has(command)) return null;
    if (!(READ_COMMANDS as readonly string[]).includes(command)) return null;
    return HEAVY_READ_COMMANDS.has(command) ? "heavy" : "light";
  }

  // MCP 代理：`mcp({ tool: "…_search_bilibili_videos" })` 或命名空间代理
  const target = String(record.tool ?? "");
  const hit = MCP_READ_TOOLS.find((name) => target.endsWith(name) || toolName.endsWith(name));
  if (!hit) return null;
  // 读字幕/元数据会解析整段内容，算普通读；MCP 侧没有下载视频的工具
  return "light";
}

export interface ReadDecision {
  allowed: boolean;
  kind?: ReadKind;
  reason?: string;
  /** 放行时把新的计数器一起返回，避免调用方忘记录账 */
  next?: ReadCounter;
}

/** 判据（纯函数）。放行时返回已加一的计数器。 */
export function checkRead(
  counter: ReadCounter,
  kind: ReadKind,
  limits: ReadLimits = DEFAULT_READ_LIMITS,
): ReadDecision {
  const total = counter.light + counter.heavy;
  if (total >= limits.maxReadsPerRound) {
    return {
      allowed: false,
      kind,
      reason:
        `本轮已读 ${total} 次，达到上限 ${limits.maxReadsPerRound}（maxReadsPerRound）。` +
        "读太猛会撞 B站 412 风控，而且那种失败会被误报成'无效响应'。请先出结论，下一轮再读。",
    };
  }
  if (kind === "heavy" && counter.heavy >= limits.maxHeavyReadsPerRound) {
    return {
      allowed: false,
      kind,
      reason:
        `本轮已做过 ${counter.heavy} 次重读（下载视频/抽帧），达到上限 ${limits.maxHeavyReadsPerRound}` +
        "（maxHeavyReadsPerRound）。重读一次几十 MB，别连着来。",
    };
  }
  return {
    allowed: true,
    kind,
    next: {
      light: counter.light + (kind === "light" ? 1 : 0),
      heavy: counter.heavy + (kind === "heavy" ? 1 : 0),
    },
  };
}
