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
  const nowMin = minutesOfDay(now);
  const at = Number(state.at);
  if (!Number.isFinite(at)) return { due: false, why: "计划里没有有效时刻" };
  if (state.fired) return { due: false, why: "今天这轮已经跑过" };
  if (nowMin >= at) return { due: true, why: `到点（计划 ${fmt(at)}，现在 ${fmt(nowMin)}）` };
  if (catchUp && reportExists(now) === false && nowMin >= at) {
    return { due: true, why: "补跑：今天还没有报告" };
  }
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
 * 发一条 Telegram 消息。
 * token / chatId 从配置读，**不写进仓库**；没有配置时静默跳过（return {sent:false}）。
 */
export async function notifyTelegram({ token, chatId, text, fetchImpl = fetch }) {
  if (!token || !chatId) return { sent: false, reason: "未配置 TG bot token / chat_id" };
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 3800), disable_web_page_preview: true }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body?.ok === false) {
      return { sent: false, reason: `HTTP ${res.status} ${body?.description ?? ""}`.trim() };
    }
    return { sent: true };
  } catch (error) {
    return { sent: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
