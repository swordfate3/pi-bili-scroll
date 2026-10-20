#!/usr/bin/env node
/**
 * bili-daemon.mjs —— 常驻调度进程（替代容器里不存在的 cron）。
 *
 * ## 为什么不是 crontab
 * 本容器没有 cron / systemd，也没有 root。所以"定时"只能自己写循环，用
 * `setsid nohup` 挂到后台。**容器重启就没了** —— 这是环境限制，不是实现缺陷，
 * 需要时由 `/bili-daemon start` 或外部再拉起一次。
 *
 * ## 它做什么
 * 每 `tickSeconds` 秒醒一次：
 *   1. 今天没计划 → 掷骰子做计划（窗口内随机时刻 + skipChance 概率"今天不看"）
 *   2. 到点且没跑过 → `spawn pi -p "<命令>"`（detached，不阻塞循环）
 *   3. 跑完把报告摘要通过 Telegram 推给用户（配了才推）
 *
 * ## 用法
 *   node scripts/bili-daemon.mjs                # 常驻（一般由 /bili-daemon start 拉起）
 *   node scripts/bili-daemon.mjs --once         # 只跑一次判断，不循环
 *   node scripts/bili-daemon.mjs --dry          # 只打印"本该执行什么"，不真的跑
 *   node scripts/bili-daemon.mjs --status       # 打印计划与状态
 */
import { execFile, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dayKey, needsCatchUp, notifyTelegram, planToday, setTimeZone, shouldRun, summarizeReport } from "./schedule-core.mjs";

// ⚠️ Node 的 fetch 不读 HTTP_PROXY。但 `NODE_USE_ENV_PROXY` 必须在 Node **启动前**生效，
// 在脚本里 process.env 赋值没用（实测）。所以真正兜底的是 schedule-core 里
// 「fetch 失败 → 自动改走 curl」。这里给子进程设一下，让它们少走一次失败重试。
if (!process.env.NODE_USE_ENV_PROXY) process.env.NODE_USE_ENV_PROXY = "1";

const HOME = homedir();
const DATA = process.env.BILI_SCROLL_HOME?.trim() || join(HOME, ".local", "share", "bili-scroll");
const CONFIG_PATH = join(DATA, "schedule.json");
const STATE_PATH = join(DATA, "schedule-state.json");
const LOG_PATH = join(DATA, "daemon.log");
const REPORT_DIR = join(DATA, "out");
const NOTIFY_PATH = join(DATA, "notify.json");

const DEFAULTS = {
  enabled: true,
  windows: [{ start: "20:00", end: "22:00", wakes: 1 }],
  skipChance: 0.3,
  maxWakesPerDay: 2,
  tickSeconds: 60,
  catchUp: true,
  /** 使用者时区。容器是 UTC，不能拿容器时区解释窗口。 */
  timezone: "Asia/Shanghai",
  /** 一轮巡检最多等多久（秒）产出报告；超时就推超时通知 */
  roundTimeoutSeconds: 1200,
  /**
   * 到点后实际执行的命令（数组形式，避免 shell 拼接）。
   *
   * ⚠️ 必须用 `/bili-scroll` 这个**命令**，不能用一句自然语言描述。
   * 实测：`pi -p "按 bili-scroll 判据刷一轮"` 会让模型在聊天里输出报告、
   * **不写文件**（它不知道该写到哪个路径）；而 `/bili-scroll` 会注入含确切路径的请求，
   * 报告才会落到 out/<日期>.md。
   */
  command: ["pi", "-p", "/bili-scroll"],
};
const DEFAULT_NOTIFY = { telegram: { token: "", chatId: "" }, bilibiliDm: true };

/** vendor 进来的 whale 工具入口（相对本脚本的上一级）。 */
const WHALE_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor", "bili-whale", "tools", "bili.mjs");

function readJson(path, fallback) {
  try {
    return { ...fallback, ...JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    return fallback;
  }
}
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path); // 原子替换：读的人不会看到半截文件
  return value;
}
function log(line) {
  const text = `${new Date().toISOString()}  ${line}`;
  // ⚠️ 不要同时 console.log + 写文件：启动时 stdout 会被重定向到同一个 daemon.log，
  // 于是每行都出现两次（实测踩过）。
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, `${text}\n`);
  } catch {
    // 日志写不进去时至少打到 stderr，别静默吞掉
    console.error(text);
  }
}

function reportPathFor(date = new Date()) {
  return join(REPORT_DIR, `${dayKey(date)}.md`);
}
const reportExists = (date = new Date()) => existsSync(reportPathFor(date));

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return null;
  }
}
function saveState(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 报告的 mtime（毫秒）；不存在返回 0。用来判断"这一轮是否真的产出了新报告"。 */
function reportStamp(date = new Date()) {
  try {
    return statSync(reportPathFor(date)).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * 跑一轮巡检并**等它产出报告**。
 *
 * 之前只发一句"已开始"就完事 —— 用户收到通知却不知道结果，等于没推。
 * 现在 spawn 之后轮询报告 mtime，等到变化（或超时）再返回报告内容，
 * 由调用方压成摘要推出去。
 */
async function runRound(command, dry, options = {}) {
  const { timeoutSeconds = 1200, pollSeconds = 10 } = options;
  const [bin, ...args] = command;
  log(`▶ 执行：${bin} ${args.join(" ")}`);
  if (dry) {
    log("  [dry] 未真正执行");
    return { dryRun: true };
  }

  const before = reportStamp();
  const child = spawn(bin, args, {
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, BILI_SCROLL_DAEMON: "1", NODE_USE_ENV_PROXY: "1" },
  });
  child.unref();
  log(`  已拉起 pid=${child.pid ?? "?"}，等报告落盘（最多 ${timeoutSeconds}s）`);

  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    await sleep(pollSeconds * 1000);
    const after = reportStamp();
    if (after !== before && after > 0) {
      log("  ✓ 报告已更新");
      try {
        return { reportPath: reportPathFor(), content: readFileSync(reportPathFor(), "utf8") };
      } catch {
        return { reportPath: reportPathFor(), content: "" };
      }
    }
  }
  log(`  ✗ 等待超时（${timeoutSeconds}s 内报告没有更新）`);
  return { timedOut: true, reportPath: reportPathFor() };
}

/**
 * 沉默档位（和 src/silence.ts 同一套阈值，只是这里只需要"推不推"）。
 *
 * 为什么不 import 那边的 TypeScript：daemon 是纯 .mjs、由 node 直接跑，
 * 没有构建步骤。两边阈值从同一份配置读，逻辑只有三行，重复的代价小于引入构建。
 * 任何不一致都会在测试里被抓到（tests/unit/silence.test.ts 会对照同一个配置语义）。
 */
function silenceLevel(home, config) {
  if (config.silenceEnabled === false) return "normal";
  const after = Number(config.silenceAfterDays ?? 3);
  const stop = Number(config.silenceStopDays ?? 7);
  let lastAt = null;
  try {
    const raw = readFileSync(join(home, "taste", "touches.jsonl"), "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const at = JSON.parse(line).at;
        const time = Date.parse(at);
        if (!Number.isNaN(time) && (lastAt === null || time > lastAt)) lastAt = time;
      } catch {}
    }
  } catch {
    return "normal"; // 没记录 = 新装，不判冷落
  }
  if (lastAt === null) return "normal";
  const days = Math.floor((Date.now() - lastAt) / 86400000);
  if (days >= stop) return "anxious";
  if (days >= after) return "quiet";
  return "normal";
}

async function notifySummary(text, dry) {
  const notify = readJson(NOTIFY_PATH, DEFAULT_NOTIFY);
  const token = notify?.telegram?.token ?? "";
  const chatId = notify?.telegram?.chatId ?? "";
  if (!token || !chatId) {
    log("· 通知未配置（跳过）。配 ~/.local/share/bili-scroll/notify.json 的 telegram.token / chatId");
    return;
  }
  if (dry) {
    log("  [dry] 本应推送 Telegram");
    return;
  }
  const result = await notifyTelegram({ token, chatId, text });
  log(result.sent ? "✓ 已推送 Telegram" : `✗ 推送失败：${result.reason}`);
}

/**
 * 再把摘要发一条 B站私信给主人。
 *
 * 为什么不放进巡检那一轮：让它保持只读。daemon 手上已经有报告全文，
 * 发私信是确定性动作，不需要模型掺和。
 * ⚠️ B站私信正文上限 300 字，所以这里压成一行并截断 —— 只发 BV 号 + 一句话。
 */
async function notifyBilibiliDm(text, dry) {
  const notify = readJson(NOTIFY_PATH, DEFAULT_NOTIFY);
  if (notify.bilibiliDm === false) {
    log("· B站私信已关闭（notify.bilibiliDm=false）");
    return;
  }
  const msg = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 280);
  if (!msg) return;
  if (dry) {
    log("  [dry] 本应发 B站私信");
    return;
  }
  try {
    await new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        [WHALE_ENTRY, "dm", "--msg", msg, "--go"],
        { timeout: 120000, env: { ...process.env, NODE_USE_ENV_PROXY: "1" } },
        (error, stdout, stderr) => {
          if (error) return reject(new Error(String(stderr || stdout || error.message).slice(0, 300)));
          resolve();
        },
      );
    });
    log("✓ 已发 B站私信");
  } catch (error) {
    // 私信失败不该影响整轮：Telegram 已经发过了
    log(`✗ B站私信失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function tick(dry) {
  const config = readJson(CONFIG_PATH, DEFAULTS);
  if (!setTimeZone(config.timezone)) log(`⚠️ 时区「${config.timezone}」无效，沿用默认`);
  if (!config.enabled) return;

  const now = new Date();
  let state = loadState();

  // 跨天：重做计划（保留历史不计，简单为主）
  if (!state || state.date !== dayKey(now)) {
    const plan = planToday({
      now,
      windows: config.windows,
      skipChance: config.skipChance,
      maxWakes: config.maxWakesPerDay,
    });
    state = plan;
    saveState(state);
    log(plan.skip ? `🛌 ${plan.reason}` : `📅 今天计划：${plan.at === null ? "-" : plan.reason}`);
    return;
  }

  const check = shouldRun(state, now, { catchUp: config.catchUp, reportExists });
  const catchUp = config.catchUp && needsCatchUp(state, now, reportExists);
  if (!check.due && !catchUp) return;

  saveState({ ...state, fired: true, firedAt: now.toISOString(), reason: check.why });
  log(`⏰ 触发：${check.why}`);

  const result = await runRound(config.command ?? DEFAULTS.command, dry, {
    timeoutSeconds: Number(config.roundTimeoutSeconds ?? 1200),
  });

  if (result.dryRun) {
    await notifySummary(`[dry] 本应执行一轮巡检（${check.why}）`, dry);
    await notifyBilibiliDm(`[dry] 本应执行一轮巡检（${check.why}）`, dry);
    return;
  }
  if (result.timedOut) {
    const msg = `⚠️ B站巡检超时：${config.roundTimeoutSeconds ?? 1200}s 内没有产出报告`;
    await notifySummary(`${msg}\n${reportPathFor(now)}`, dry);
    await notifyBilibiliDm(msg, dry);
    return;
  }
  if (!result.content) {
    const msg = "⚠️ B站巡检跑完了，但报告是空的";
    await notifySummary(`${msg}\n${result.reportPath}`, dry);
    await notifyBilibiliDm(msg, dry);
    return;
  }
  const { text, count } = summarizeReport(result.content, {
    intro: `📺 B站巡检 ${dayKey(now)} · ${check.why}`,
  });
  log(`  报告解析出 ${count} 条，开始推送`);

  // 沉默 7 天+ = 不分享，但日报照写（"日记照写"不能变）。
  const level = silenceLevel(home, config);
  if (level === "anxious") {
    log("  🫥 沉默超过阈值，本轮不推送（报告已写到磁盘，自己看）");
    return;
  }
  const prefix = level === "quiet" ? "（安静期）" : "";
  await notifySummary(prefix + text, dry);
  await notifyBilibiliDm(prefix + text, dry);
}

const argv = process.argv.slice(2);
const dry = argv.includes("--dry");
const once = argv.includes("--once");
const statusOnly = argv.includes("--status");

if (statusOnly) {
  const config = readJson(CONFIG_PATH, DEFAULTS);
  setTimeZone(config.timezone);
  const state = loadState();
  console.log(JSON.stringify({ config, state, report: reportPathFor(), reportExists: reportExists() }, null, 2));
  process.exit(0);
}

if (once) {
  await tick(dry);
  process.exit(0);
}

// 常驻循环
log(`bili-daemon 启动 · 配置 ${CONFIG_PATH} · 数据 ${DATA}${dry ? "（dry 模式）" : ""}`);
await tick(dry);
const interval = Math.max(15, Number(readJson(CONFIG_PATH, DEFAULTS).tickSeconds ?? 60)) * 1000;
const timer = setInterval(() => {
  tick(dry).catch((error) => log(`✗ tick 失败：${error?.message ?? error}`));
}, interval);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    clearInterval(timer);
    log(`收到 ${signal}，退出`);
    process.exit(0);
  });
}
