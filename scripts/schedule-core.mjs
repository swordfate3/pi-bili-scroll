/**
 * schedule-core.mjs —— 调度与通知的纯逻辑（无副作用、可测）。
 *
 * 为什么单独成文件：容器里**没有 cron / systemd**，所以"定时"只能自己写循环。
 * 而循环里最容易错的是"该不该现在跑"这类判断 —— 一旦错了就是漏跑或重复跑，
 * 而且很难当场发现。所以把判断抽出来做成纯函数，用注入的 rng / now 测。
 *
 * 设计照搬 dsh-bili-whale 的生物钟（MIT）：
 *   · 窗口内**随机**挑一个时刻，不是固定时间
 *   · 每次醒来独立掷 `skipChance`，"今天不想看"也是合法结果
 *   · 计划落盘（含 date / at / fired / wakes），重启不丢
 */

/** "HH:MM" → 当天第几分钟。非法返回 null。 */
export function parseHHMM(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** 本地日期键 YYYY-MM-DD（不能用 UTC，"今天"要和用户体感一致）。 */
export function dayKey(date = new Date()) {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

export function minutesOfDay(date = new Date()) {
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * 把窗口按"可能跨午夜"展开成分钟区间。
 * 例：20:00–23:30 → [1200, 1410]；22:00–02:00 → [1320, 1560]（跨夜，表示次日 0 点后仍算）。
 */
export function windowRange(win) {
  const start = parseHHMM(win?.start);
  const end = parseHHMM(win?.end);
  if (start === null || end === null) return null;
  return end >= start ? [start, end] : [start, end + 1440];
}

/**
 * 掷今天的计划。
 * @returns {{date:string, at:number|null, skip:boolean, reason:string, wakes:number}}
 *   at 为当天第几分钟（可能 >1440，表示跨夜）
 */
export function planToday(options) {
  const { now = new Date(), windows = [], skipChance = 0.3, maxWakes = 10, rng = Math.random } = options ?? {};
  const date = dayKey(now);
  const valid = (windows ?? []).map((w) => ({ w, range: windowRange(w) })).filter((x) => x.range);
  if (!valid.length) {
    return { date, at: null, skip: true, reason: "没有配置有效窗口", wakes: 0 };
  }

  // 随机挑一个窗口，再在窗口内随机挑分钟
  const picked = valid[Math.floor(rng() * valid.length)];
  const [start, end] = picked.range;
  const span = Math.max(1, end - start);
  let at = start + Math.floor(rng() * span);

  // 允许跨夜的窗口里，如果挑到的是"昨天的延续"就顺延到今天
  const nowMin = minutesOfDay(now);
  if (at <= nowMin) at = Math.min(end + 1439, nowMin + 1 + Math.floor(rng() * 10));

  const wakes = Number(picked.w?.wakes ?? 1);
  if (Number(rng()) < Number(skipChance)) {
    return {
      date,
      at: null,
      skip: true,
      reason: `这次不想看（掷骰子掷到了「不看」那 ${Math.round(Number(skipChance) * 100)}%）`,
      wakes: 0,
    };
  }
  const capped = Math.max(1, Math.min(wakes, maxWakes));
  return { date, at, skip: false, reason: `窗口 ${picked.w.start}-${picked.w.end} 内随机定在 ${fmt(at)}`, wakes: capped };
}

export function fmt(minutes) {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/**
 * 现在该不该跑？
 * @returns {{due:boolean, why:string}}
 */
export function shouldRun(state, now = new Date(), options = {}) {
  const { catchUp = true, reportExists = () => false } = options;
  if (!state || state.date !== dayKey(now)) return { due: false, why: "今天还没做计划" };
  if (state.skip) return { due: false, why: state.reason ?? "今天选择不看" };
  if (state.fired) return { due: false, why: "今天这轮已经跑过" };

  // ⚠️ 报告已经存在 = 今天已经有结果（可能是手动跑的）。
  //    一轮就是一轮：不因为"到点了"就再跑一遍 —— 之前这个参数写在提前 return 之后，
  //    等于完全没生效，会让同一天跑两轮、白烧一次额度。
  if (reportExists(now)) return { due: false, why: "今天已经有报告，不重复跑" };

  const nowMin = minutesOfDay(now);
  const at = Number(state.at);
  if (!Number.isFinite(at)) return { due: false, why: "计划里没有有效时刻" };
  if (nowMin >= at) return { due: true, why: `到点（计划 ${fmt(at)}，现在 ${fmt(nowMin)}）` };
  if (catchUp) return { due: false, why: `还没到点（计划 ${fmt(at)}）` };
  return { due: false, why: `还没到点（计划 ${fmt(at)}）` };
}

/** 补跑判断：窗口已经过去、今天又没报告 → 允许补一次。 */
export function needsCatchUp(state, now, reportExists) {
  if (!state || state.date !== dayKey(now)) return false;
  if (state.fired || state.skip) return false;
  if (reportExists(now)) return false;
  const at = Number(state.at);
  if (!Number.isFinite(at)) return false;
  return minutesOfDay(now) > at + 60; // 过了计划时刻一小时还没跑，才补
}

// ── 通知（Telegram）──────────────────────────────────────────────────────────

/**
 * ⚠️ 容器里配了 HTTP_PROXY，而 Node 的 fetch **不读**代理环境变量（curl 会读）。
 * 实测：默认 fetch → `fetch failed`；加 NODE_USE_ENV_PROXY=1 或 --use-env-proxy 才通。
 * 这里做一次兜底：先试原生 fetch，失败且存在代理变量时，返回一个说明性错误，
 * 由调用方决定是否改用 curl —— 免得"通知悄悄发不出去"。
 */
export const proxyHint =
  "若容器内有 HTTP_PROXY，请用 NODE_USE_ENV_PROXY=1 启动，或改用 curl 发送 Telegram";

/**
 * 发一个 POST：优先原生 fetch，失败则**降级到 curl**。
 *
 * 为什么要降级而不是只报错：`NODE_USE_ENV_PROXY` / `--use-env-proxy` 必须在 Node
 * **启动前**生效，运行中设置无效（实测）。而守护进程可能被以任何方式拉起，
 * 靠"记得加环境变量"太脆 —— 于是失败就走 curl（它读代理变量），保证通知真的发得出去。
 */
export async function postJson(url, payload) {
  const body = JSON.stringify(payload);
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } catch (error) {
    const curl = await curlPost(url, body);
    if (curl) return curl;
    throw new Error(`${error instanceof Error ? error.message : String(error)}（${proxyHint}）`);
  }
}

/** 用系统 curl 兜底（容器里一定有）。失败返回 null，由调用方报原始错误。 */
async function curlPost(url, body) {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const { stdout } = await run("curl", ["-sS", "-m", "30", "-X", "POST", "-H", "content-type: application/json", "-d", body, url]);
    return { status: 200, body: JSON.parse(stdout) };
  } catch {
    return null;
  }
}

/**
 * 发一条 Telegram 消息。
 * token / chatId 从配置读，**不写进仓库**；没有配置时静默跳过（return {sent:false}）。
 */
export async function notifyTelegram({ token, chatId, text, post = postJson }) {
  if (!token || !chatId) return { sent: false, reason: "未配置 TG bot token / chat_id" };
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    const { status, body } = await post(url, {
      chat_id: chatId,
      text: String(text).slice(0, 3800),
      disable_web_page_preview: true,
    });
    if (body?.ok === true) return { sent: true };
    return { sent: false, reason: `HTTP ${status} ${body?.description ?? ""}`.trim() };
  } catch (error) {
    return { sent: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
