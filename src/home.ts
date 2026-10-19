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
 * 本地日期键 `YYYY-MM-DD`。按本机时区算，跨日以本地零点为界 ——
 * 「今天刷过没有」必须和用户体感一致，不能用 UTC。
 */
export function dayKey(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** 当天日报路径。日报的存在与否同时是「今天刷过没有」的唯一判据（不另存状态文件）。 */
export function reportPath(paths: BiliScrollPaths, day: string): string {
  return join(paths.outDir, `${day}.md`);
}
