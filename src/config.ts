/**
 * config.ts —— 配置读取与容错归一化。
 *
 * 教训来源：dsh-bili-scroll 在 2026-10-14 出过一次事故 —— 宿主传进来的配置字段值
 * **不保证是标量**（`pythonPath` 是对象、`keywords` 不是数组），而对象是"真值"，
 * 于是 `if (!cfg.peakValley) return` 这类守卫全部失效，一路走到 `cfg.keywords.filter()`
 * 把整个宿主炸了。所以这里**逐字段做类型检查**，类型不对就回默认值并记一条 notice，
 * 绝不把未校验的值当标量用。
 */
import { readFile } from "node:fs/promises";
import type { BiliScrollPaths } from "./home.js";

export type ReportDetail = "full" | "brief" | "none";

export interface BiliScrollConfig {
  /** 总开关：关掉后 session 开始不再提示 */
  enabled: boolean;
  /** 关注关键词；空数组 = 用内置那几组 */
  keywords: string[];
  /** 每天最多挑几条 */
  perDay: number;
  /** 日报写多细 */
  reportDetail: ReportDetail;
  /** session 开始时提示"今天还没刷" */
  notifyOnStart: boolean;
  /** 读人设的工作区路径（那里有 AGENTS.md）；null = 不读设定、按中性说话 */
  workdir: string | null;
  /** 登录二维码图片存放目录（相对 cwd 或绝对路径）；默认 downloads */
  qrDir: string;
  /**
   * 写操作（发评论/私信/动态）是否弹窗要用户确认。
   * **默认 false**：直接执行 —— 这是用户明确要求（要能定时无人值守地自己发）。
   * 设 true 可恢复逐次确认；但注意无 UI 模式（pi -p）下确认无从弹起，会被拒绝。
   * 无论开关如何，每次写操作都会记进 `writes.log` 审计。
   */
  confirmWrites: boolean;
  /** 每天最多发几条评论（代码强制，防刷屏封号） */
  maxCommentsPerDay: number;
  /** 两条评论之间至少隔几分钟 */
  minMinutesBetweenComments: number;
  /** 同一个视频 N 天内只评论一次 */
  sameVideoCooldownDays: number;
  /**
   * 使用者时区（IANA 名）。容器可能是 UTC，而窗口、"今天"都要按使用者体感算。
   * 实测：容器 Etc/UTC，用户 UTC+8 ⇒ 20:00 窗口会在凌晨 4 点触发。
   */
  timezone: string;
  /** 一轮巡检内普通读（搜/字幕/评论/元数据）的上限，防撞 B站 风控 */
  maxReadsPerRound: number;
  /** 一轮内"重读"（下载视频/抽帧）的上限 */
  maxHeavyReadsPerRound: number;
}

export const DEFAULT_CONFIG: BiliScrollConfig = {
  enabled: true,
  keywords: [],
  perDay: 5,
  reportDetail: "brief",
  notifyOnStart: true,
  workdir: null,
  qrDir: "downloads",
  confirmWrites: false,
  maxCommentsPerDay: 3,
  minMinutesBetweenComments: 30,
  sameVideoCooldownDays: 7,
  timezone: "Asia/Shanghai",
  maxReadsPerRound: 10,
  maxHeavyReadsPerRound: 2,
};

const REPORT_DETAILS: readonly ReportDetail[] = ["full", "brief", "none"];

const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

/** 关键词条数与单条长度都封顶，避免配置被写成超大数组拖垮提示词。 */
const MAX_KEYWORDS = 32;
const MAX_KEYWORD_LENGTH = 100;

/** 读不到文件 = 用默认值（不是错误）；读到了但字段不对 = 用默认值 + notice。 */
export async function loadConfig(
  paths: BiliScrollPaths,
): Promise<{ config: BiliScrollConfig; notices: string[] }> {
  let raw: string;
  try {
    raw = await readFile(paths.config, "utf8");
  } catch {
    return { config: { ...DEFAULT_CONFIG, keywords: [] }, notices: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      config: { ...DEFAULT_CONFIG, keywords: [] },
      notices: [`配置不是合法 JSON（${paths.config}），已全部回退到默认值。`],
    };
  }
  return normalizeConfig(parsed);
}

export function normalizeConfig(raw: unknown): { config: BiliScrollConfig; notices: string[] } {
  const config: BiliScrollConfig = { ...DEFAULT_CONFIG, keywords: [] };
  const notices: string[] = [];

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { config, notices: ["配置顶层不是 JSON 对象，已全部回退到默认值。"] };
  }
  const record = raw as Record<string, unknown>;

  if (record.enabled !== undefined) {
    if (isBoolean(record.enabled)) config.enabled = record.enabled;
    else notices.push("enabled 不是布尔值，已用默认值 true。");
  }

  if (record.notifyOnStart !== undefined) {
    if (isBoolean(record.notifyOnStart)) config.notifyOnStart = record.notifyOnStart;
    else notices.push("notifyOnStart 不是布尔值，已用默认值 true。");
  }

  if (record.perDay !== undefined) {
    const value = record.perDay;
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
      config.perDay = value;
    } else {
      notices.push("perDay 不是非负整数，已用默认值 5。");
    }
  }

  if (record.reportDetail !== undefined) {
    const value = record.reportDetail;
    if (typeof value === "string" && (REPORT_DETAILS as readonly string[]).includes(value)) {
      config.reportDetail = value as ReportDetail;
    } else {
      notices.push("reportDetail 不是 full/brief/none 之一，已用默认值 brief。");
    }
  }

  if (record.keywords !== undefined) {
    const value = record.keywords;
    if (Array.isArray(value)) {
      const cleaned = value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0 && item.length <= MAX_KEYWORD_LENGTH)
        .slice(0, MAX_KEYWORDS);
      config.keywords = cleaned;
      if (cleaned.length < value.length) {
        notices.push("keywords 里有空项、超长项或非字符串项，已丢弃。");
      }
    } else {
      notices.push("keywords 不是数组，已按空数组处理（将使用内置关键词）。");
    }
  }

  if (record.workdir !== undefined && record.workdir !== null) {
    if (typeof record.workdir === "string" && record.workdir.trim().length > 0) {
      config.workdir = record.workdir.trim();
    } else {
      notices.push("workdir 不是非空字符串，已按「不读设定」处理。");
    }
  }

  for (const key of [
    "maxCommentsPerDay",
    "minMinutesBetweenComments",
    "sameVideoCooldownDays",
    "maxReadsPerRound",
    "maxHeavyReadsPerRound",
  ] as const) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
      config[key] = value;
    } else {
      notices.push(`${key} 不是非负整数，已用默认值 ${DEFAULT_CONFIG[key]}。`);
    }
  }

  if (record.timezone !== undefined) {
    const value = record.timezone;
    if (typeof value === "string" && value.trim()) {
      try {
        new Intl.DateTimeFormat("en-CA", { timeZone: value.trim() });
        config.timezone = value.trim();
      } catch {
        notices.push(`timezone「${value}」不是合法 IANA 时区名，已用默认值 Asia/Shanghai。`);
      }
    } else {
      notices.push("timezone 不是非空字符串，已用默认值 Asia/Shanghai。");
    }
  }

  if (record.confirmWrites !== undefined) {
    if (isBoolean(record.confirmWrites)) config.confirmWrites = record.confirmWrites;
    else notices.push("confirmWrites 不是布尔值，已用默认值 false（直接执行）。");
  }

  if (record.qrDir !== undefined) {
    const value = record.qrDir;
    if (typeof value === "string" && value.trim().length > 0) config.qrDir = value.trim();
    else notices.push("qrDir 不是非空字符串，已用默认值 downloads。");
  }

  return { config, notices };
}
