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
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dayKey, needsCatchUp, notifyTelegram, planToday, setTimeZone, shouldRun } from "./schedule-core.mjs";

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
  /** 到点后实际执行的命令（数组形式，避免 shell 拼接） */
  command: ["pi", "-p", "按 bili-scroll 判据刷一轮"],
};
const DEFAULT_NOTIFY = { telegram: { token: "", chatId: "" } };

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
  console.log(text);
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, `${text}\n`);
  } catch {}
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

/** 跑一轮巡检（detached，不阻塞循环）。 */
function runRound(command, dry) {
  const [bin, ...args] = command;
  log(`▶ 执行：${bin} ${args.join(" ")}`);
  if (dry) {
    log("  [dry] 未真正执行");
    return;
  }
  const child = spawn(bin, args, {
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, BILI_SCROLL_DAEMON: "1" },
  });
  child.unref();
  log(`  已拉起 pid=${child.pid ?? "?"}（不等待完成）`);
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
  runRound(config.command ?? DEFAULTS.command, dry);
  await notifySummary(`B站巡检已开始（${check.why}）· 报告会在 ${reportPathFor(now)}`, dry);
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
