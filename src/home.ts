/**
 * home.ts —— 家目录推导与日期键。
 *
 * 这里只放纯函数：路径怎么拼、今天是哪天。文件读写留在 config.ts / extension.ts，
 * 这样这一层可以脱开文件系统测试。
 */
import { homedir } from "node:os";
import { join } from "node:path";

export interface BiliScrollPaths {
  /** 家目录根 */
  home: string;
  /** 用户配置 */
  config: string;
  /** 日报目录 */
  outDir: string;
  /** 运行日志 */
  log: string;
}

/**
 * 默认家目录落在 pi-runtime 持久卷（~/.local），容器重建后日报与配置不丢。
 * 可用 BILI_SCROLL_HOME 覆盖（测试与非默认部署用），不要靠 shell export —— 见 skill
 * persistent-local-install 第 3 节：~/.bashrc 只读、非登录 shell 也不读 ~/.profile。
 */
export const DEFAULT_HOME = join(homedir(), ".local", "share", "bili-scroll");

export function homeDir(): string {
  const override = process.env.BILI_SCROLL_HOME?.trim();
  return override && override.length > 0 ? override : DEFAULT_HOME;
}

export function pathsFor(home: string = homeDir()): BiliScrollPaths {
  return {
    home,
    config: join(home, "config.json"),
    outDir: join(home, "out"),
    log: join(home, "bili-scroll.log"),
  };
}

/**
 * 时区。
 *
 * ⚠️ 容器实测是 `Etc/UTC`，而使用者在 UTC+8。若按容器时区算：
 * · 「今天」在北京时间早上 8 点就翻页
 * · 配置的 20:00–22:00 窗口实际落在北京时间凌晨 4 点
 * 所以这里**显式指定时区**，不依赖进程的 TZ。
 */
export const DEFAULT_TIMEZONE = "Asia/Shanghai";

let activeTimeZone = DEFAULT_TIMEZONE;

/** 由扩展在加载/每次读取配置时设置。非法时区会被忽略（保留上一个）。 */
export function setTimeZone(timeZone: string | null | undefined): void {
  const candidate = (timeZone ?? "").trim();
  if (!candidate) return;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: candidate });
    activeTimeZone = candidate;
  } catch {
    // 非法时区名，保留原值
  }
}

export function getTimeZone(): string {
  return activeTimeZone;
}

/** 某时刻在指定时区下的日期键 `YYYY-MM-DD`。 */
export function formatDayKey(now: Date, timeZone: string): string {
  // en-CA 的 short date 就是 YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** 某时刻在指定时区下的「当天第几分钟」。 */
export function formatMinutesOfDay(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

/** 日期键 `YYYY-MM-DD`，按**使用者时区**（不是容器时区）算。 */
export function dayKey(now: Date = new Date()): string {
  return formatDayKey(now, activeTimeZone);
}

/** 当天第几分钟，按使用者时区。 */
export function minutesOfDay(now: Date = new Date()): number {
  return formatMinutesOfDay(now, activeTimeZone);
}

/** 当天日报路径。日报的存在与否同时是「今天刷过没有」的唯一判据（不另存状态文件）。 */
export function reportPath(paths: BiliScrollPaths, day: string): string {
  return join(paths.outDir, `${day}.md`);
}
