/**
 * extension.ts —— 组合根。
 *
 * 这里只做三件事：注册命令、注册状态工具、在会话开始时提示。
 * **不在工厂里做任何 IO / 起进程 / 定时器**（Pi 有些调用只加载扩展而不开会话），
 * 也不持有需要清理的长期资源 —— 配置与资料都是按需读，读完即弃。
 */
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname as pathDirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, resolve } from "node:path";

/** 包根（src/ 的上一级），用于定位 scripts/ 下的调度器。 */
const PACKAGE_ROOT_HINT = join(pathDirname(fileURLToPath(import.meta.url)), "..");
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadCharter } from "./charter.js";
import { loadConfig, type BiliScrollConfig } from "./config.js";
import { dayKey, pathsFor, reportPath, setTimeZone, type BiliScrollPaths } from "./home.js";
import {
  CREDENTIAL_PATH,
  QR_TTL_SECONDS,
  pollQrSession,
  qrFileName,
  readExistingCredential,
  discardPreviousQr,
  removeQrFile,
  renderQrPng,
  requestQrSession,
  writeCredential,
  type QrSession,
} from "./login.js";
import { sendComment, type MentionTarget } from "./comment.js";
import { readPersona } from "./persona.js";
import { checkQuota, loadQuota, pruneState, quotaPath, recordComment, saveQuota } from "./quota.js";
import { classifyRead, checkRead, EMPTY_COUNTER, DEFAULT_READ_LIMITS, type ReadCounter } from "./readlimit.js";
import { isDryRunArgs, isKnownCommand, isWriteCommand, runWhale, READ_COMMANDS, WRITE_COMMANDS } from "./whale.js";
import { buildRunPrompt, effectiveKeywords } from "./prompt.js";
import { waitForRound } from "./round.js";

interface Snapshot {
  paths: BiliScrollPaths;
  day: string;
  report: string;
  ranToday: boolean;
  reportMtime: string | null;
  reportBytes: number | null;
  config: BiliScrollConfig;
  notices: string[];
}

async function snapshot(): Promise<Snapshot> {
  const paths = pathsFor();
  const day = dayKey();
  const report = reportPath(paths, day);
  const { config, notices } = await loadConfig(paths);
  // 时区要在算 dayKey / 窗口之前定下来 —— 容器可能是 UTC，用户不是。
  setTimeZone(config.timezone);
  let ranToday = false;
  let reportMtime: string | null = null;
  let reportBytes: number | null = null;
  try {
    const info = await stat(report);
    ranToday = info.isFile();
    reportMtime = info.mtime.toISOString();
    reportBytes = info.size;
  } catch {
    // 日报不存在 = 今天还没刷过。不是错误。
  }
  return { paths, day, report, ranToday, reportMtime, reportBytes, config, notices };
}

/**
 * 给用户回话。交互模式用 UI 通知；print / JSON 模式下 `ctx.ui` 是空实现
 * （`notify: () => {}`），只靠它等于什么都没输出，所以退到 stderr。
 * 不能写 stdout —— JSON 模式下 stdout 是机器可读通道，混进文本会破坏它。
 */
function say(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) {
    try {
      ctx.ui.notify(message, level);
      return;
    } catch {
      // UI 实现抛错也不能让命令失败，落到 stderr。
    }
  }
  console.error(level === "info" ? message : `[${level}] ${message}`);
}

async function statusText(): Promise<string> {
  const snap = await snapshot();
  const lines = [
    `家目录：${snap.paths.home}`,
    `今天：${snap.day}`,
    snap.ranToday
      ? `已刷过：${snap.report}（${snap.reportBytes ?? "?"} 字节，${snap.reportMtime}）`
      : `今天还没刷过；日报将写到 ${snap.report}`,
    `每天上限：${snap.config.perDay} 条；日报详细程度：${snap.config.reportDetail}`,
    `关注关键词：${effectiveKeywords(snap.config.keywords).join("、")}`,
    `开关：enabled=${snap.config.enabled} notifyOnStart=${snap.config.notifyOnStart}`,
  ];
  for (const notice of snap.notices) lines.push(`⚠️ ${notice}`);
  return lines.join("\n");
}

/**
 * 本轮已读次数。`/bili-scroll` 开始时清零 —— 一轮就是一轮。
 * 交互式会话里没跑过巡检时从会话开始累计，宁可早停。
 */
let readCounter: ReadCounter = { ...EMPTY_COUNTER };

/** 当前进行中的扫码登录（同一时刻只允许一个）。 */
interface ActiveLogin extends QrSession {
  qrPath: string;
}
let activeLogin: ActiveLogin | null = null;

/**
 * 统一的工具结果形状。
 * 各分支 details 字段不同，若逐个写 return 字面量，TS 会把 TDetails 推成"第一个分支的形状"，
 * 后续分支就报不兼容 —— 统一收敛成 Record<string, unknown> 最省事也最不容易再踩。
 */

/** 写能力工具名（vendor 自 AGI_Ananas/bilibili-mcp，白名单只放这一个）。 */
export const WRITE_TOOL_MARKER = "bili_reply";

/** 递归找出参数里第一个非空的 text 字段（用来在确认框里显示"要发什么"）。 */
export function findText(value: unknown, depth = 0): string | null {
  if (depth > 6 || value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findText(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  const direct = record.text;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  for (const child of Object.values(record)) {
    const found = findText(child, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * 这次调用是否是「往 B 站写东西」。
 * MCP 工具经 adapter 是以代理形式出现的（`mcp` + args.tool = "...bili_reply"），
 * 也可能直接以命名空间工具出现，所以两者都认：工具名命中，或参数里出现该标记。
 */
export function isWriteInvocation(toolName: string, input: unknown): boolean {
  if (toolName === "bili_comment") return true; // 本扩展自己的发评论工具
  if (toolName === WRITE_TOOL_MARKER || toolName.endsWith(`__${WRITE_TOOL_MARKER}`)) return true;
  if (toolName !== "mcp" && !toolName.startsWith("mcp__")) return false;
  try {
    return JSON.stringify(input ?? {}).includes(WRITE_TOOL_MARKER);
  } catch {
    return false;
  }
}


/** 调度守护进程（替代容器里不存在的 cron）。 */
const DAEMON_SCRIPT = join(PACKAGE_ROOT_HINT, "scripts", "bili-daemon.mjs");

function daemonPidFile(home: string): string {
  return join(home, "daemon.pid");
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readDaemonPid(home: string): number | null {
  try {
    const raw = readFileSync(daemonPidFile(home), "utf8").trim();
    const pid = Number(raw);
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * 审计日志：每次写操作追加一行（时间 + 工具 + 参数摘要）。
 * 确认闸门默认关掉之后，这是唯一能事后追溯"它发了什么"的东西 —— 所以不能省。
 */
export function appendWriteAudit(description: string, preview: string, home?: string): void {
  try {
    const dir = home ?? pathsFor().home;
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, "writes.log"),
      `${new Date().toISOString()}\t${description}\t${preview.replace(/\s+/g, " ").slice(0, 300)}\n`,
      "utf8",
    );
  } catch {
    // 审计写不进去不该阻断业务，但也不静默改行为
  }
}

export function jsonResult(details: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
    details,
  };
}

/** 二维码目录：配置项相对 cwd 解析成绝对路径。 */
function resolveQrDir(cwd: string, qrDir: string): string {
  return isAbsolute(qrDir) ? qrDir : resolve(cwd, qrDir);
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("bili-scroll", {
    description:
      "刷一轮 B 站并写日报：/bili-scroll [run|status|help]（默认 run）。run 会把判据交给当前会话执行。",
    async handler(args: string, ctx: ExtensionCommandContext) {
      const action = (args.trim().split(/\s+/)[0] || "run").toLowerCase();

      if (action === "help" || action === "-h" || action === "--help") {
        say(
          ctx,
          [
            "用法：",
            "/bili-scroll        跑一轮（搜 → 读字幕 → 读评论 → 写日报）",
            "/bili-scroll status 看家目录、今天刷过没有、配置",
            "/bili-scroll help   这段说明",
          ].join("\n"),
        );
        return;
      }

      if (action === "status") {
        say(ctx, await statusText());
        return;
      }

      if (action !== "run") {
        say(ctx, `不认识的动作「${action}」。可用：run / status / help。`, "warning");
        return;
      }

      readCounter = { ...EMPTY_COUNTER }; // 新一轮：读取额度重置
      const snap = await snapshot();
      if (!snap.config.enabled) {
        say(ctx, "扩展已关闭（config.enabled=false）。要跑就在配置里打开，或直接说一句让我手动刷一轮。", "warning");
        return;
      }
      for (const notice of snap.notices) say(ctx, `配置提示：${notice}`, "warning");

      let charter: string;
      try {
        charter = await loadCharter();
      } catch (error) {
        say(ctx, `读不到值班章程（判据），已中止本轮：${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }

      if (snap.ranToday) {
        say(ctx, `今天已经刷过了（${snap.report}）。这一轮会是第二遍。`, "warning");
      }

      // 人设必须"读进来内联"，只给路径等于赌模型会不会去看 —— 实测常被忽略。
      const persona = await readPersona(snap.config.workdir);
      if (snap.config.workdir && !persona) {
        say(ctx, `人设工作区 ${snap.config.workdir} 里没有可用的 AGENTS.md，本轮按中性语气。`, "warning");
      }

      const prompt = buildRunPrompt({
        charter,
        day: snap.day,
        report: snap.report,
        keywords: snap.config.keywords,
        perDay: snap.config.perDay,
        reportDetail: snap.config.reportDetail,
        workdir: snap.config.workdir,
        persona,
        home: snap.paths.home,
      });

      // 忙碌时必须显式给 deliverAs，否则 prompt() 会抛
      // "Agent is already processing. Specify streamingBehavior..."；空闲时该字段被忽略。
      pi.sendUserMessage(prompt, { deliverAs: "followUp" });

      // print / JSON 模式在输入路径返回后就会读末条消息并 dispose —— 不等这一轮跑完，
      // 巡检会被拦腰截断。交互/RPC 模式会话还活着（hasUI 为真），不必阻塞输入。
      if (!ctx.hasUI) await waitForRound(ctx);
    },
  });

  pi.registerTool({
    name: "bili_scroll_status",
    label: "B站巡检状态",
    description:
      "只读查看 B 站巡检的家目录、今天是否已刷过、日报路径与当前配置。不写任何文件、不发起搜索。跑完一轮后用它确认日报确实落盘。",
    promptSnippet: "bili_scroll_status: 查看 B 站巡检今天刷过没有、日报在哪",
    annotations: { readOnlyHint: true },
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      const snap = await snapshot();
      const details = {
        home: snap.paths.home,
        day: snap.day,
        report: snap.report,
        ranToday: snap.ranToday,
        reportMtime: snap.reportMtime,
        reportBytes: snap.reportBytes,
        config: { ...snap.config, effectiveKeywords: effectiveKeywords(snap.config.keywords) },
        notices: snap.notices,
      };
      return jsonResult(details);
    },
  });


  pi.registerTool({
    name: "bili_whale",
    label: "B站工具集（dsh-bili-whale 全功能）",
    description:
      "调用 dsh-bili-whale 工具集（MIT，vendor 自 Alterssss/dsh-bili-whale）的 46 个命令：读——session/thread/search/subtitles/video/debrief/watch-video(抽帧)/feed/quota/diary/likes/deps 等；写——comment/reply-draft/dm/dynamic/danmaku 等。写命令会在真正执行前要求用户确认；无 UI 模式一律拒绝。抽帧需要 ffmpeg。",
    promptSnippet: "bili_whale: 调 dsh-bili-whale 工具集（46 个命令，读写都有，写需确认）",
    parameters: Type.Object(
      {
        command: Type.String({ maxLength: 40 }),
        args: Type.Optional(Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 40 })),
        timeoutMs: Type.Optional(Type.Number({ maximum: 600_000 })),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params) {
      const command = String(params.command ?? "").trim();
      if (!isKnownCommand(command)) {
        const details = {
          ok: false,
          error: `未知命令「${command}」`,
          readCommands: [...READ_COMMANDS],
          writeCommands: [...WRITE_COMMANDS],
        };
        return jsonResult(details);
      }
      const result = await runWhale(command, params.args ?? [], { timeoutMs: params.timeoutMs });
      const details = {
        ...result,
        write: isWriteCommand(command),
      };
      return jsonResult(details);
    },
  });


  pi.registerCommand("bili-daemon", {
    description:
      "定时巡检守护进程（容器里没有 cron）：/bili-daemon [start|stop|status]（默认 status）。到点自动跑一轮并把结果推 Telegram。",
    async handler(args: string, ctx: ExtensionCommandContext) {
      const action = (args.trim().split(/\s+/)[0] || "status").toLowerCase();
      const snap = await snapshot();
      const home = snap.paths.home;
      const pidFile = daemonPidFile(home);
      const pid = readDaemonPid(home);

      if (action === "start") {
        if (pid && isAlive(pid)) {
          say(ctx, `守护进程已在运行（pid=${pid}）。`);
          return;
        }
        mkdirSync(home, { recursive: true });
        const child = spawn(process.execPath, [DAEMON_SCRIPT], {
          detached: true,
          stdio: ["ignore", "ignore", "ignore"],
          env: { ...process.env, BILI_SCROLL_HOME: home, NODE_USE_ENV_PROXY: "1" },
        });
        child.unref();
        if (child.pid) writeFileSync(pidFile, `${child.pid}\n`);
        await new Promise((r) => setTimeout(r, 1200));
        const ok = child.pid ? isAlive(child.pid) : false;
        say(
          ctx,
          ok
            ? [
                `✅ 守护进程已启动（pid=${child.pid}）`,
                `日志：${join(home, "daemon.log")}`,
                `状态：/bili-daemon status　停止：/bili-daemon stop`,
                "⚠️ 容器重启后进程会丢失，需要重新 start（这是环境限制，不是 cron）",
              ].join("\n")
            : `❌ 启动失败，看一眼日志：${join(home, "daemon.log")}`,
          ok ? "info" : "error",
        );
        return;
      }

      if (action === "stop") {
        if (!pid || !isAlive(pid)) {
          rmSync(pidFile, { force: true });
          say(ctx, "没有在运行的守护进程。");
          return;
        }
        try {
          process.kill(pid, "SIGTERM");
          rmSync(pidFile, { force: true });
          say(ctx, `已停止（pid=${pid}）。`);
        } catch (error) {
          say(ctx, `停止失败：${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }

      if (action !== "status") {
        say(ctx, `不认识的动作「${action}」。可用：start / stop / status。`, "warning");
        return;
      }

      let state = "(无)";
      try {
        const raw = JSON.parse(readFileSync(join(home, "schedule-state.json"), "utf8")) as Record<string, unknown>;
        state = JSON.stringify(raw);
      } catch {
        // 还没做过计划
      }
      let schedule = "(用默认：20:00-22:00，skipChance 0.3)";
      try {
        schedule = readFileSync(join(home, "schedule.json"), "utf8").replace(/\s+/g, " ").trim();
      } catch {
        // 没有配置文件
      }
      say(
        ctx,
        [
          `守护进程：${pid && isAlive(pid) ? `运行中（pid=${pid}）` : "未运行"}`,
          `今日计划：${state}`,
          `调度配置：${schedule}`,
          `今日报告：${snap.ranToday ? snap.report : "还没有"}`,
          `日志：${join(home, "daemon.log")}`,
          "",
          "启动：/bili-daemon start",
        ].join("\n"),
      );
    },
  });


  pi.registerTool({
    name: "bili_comment",
    label: "发B站评论（支持真@）",
    description:
      "在 B 站视频下发一条评论，可选**真 @ 一个人**（会在对方的提及消息里出现）。需要已登录。给 atMid+atName 才会真 @；只写文本里的 @名字 不会通知任何人。写操作，执行前需用户确认。",
    promptSnippet: "bili_comment: 发 B 站评论，可选真 @（要 mid+昵称）",
    parameters: Type.Object(
      {
        bvid: Type.String({ maxLength: 32 }),
        text: Type.String({ maxLength: 1000 }),
        atMid: Type.Optional(Type.String({ maxLength: 32 })),
        atName: Type.Optional(Type.String({ maxLength: 64 })),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params) {
      const credential = await readExistingCredential();
      if (!credential) {
        return jsonResult({ ok: false, error: "还没有 B 站凭证，先 /bili-login 扫码登录" });
      }
      const at: MentionTarget | null =
        params.atMid && params.atName ? { mid: String(params.atMid), name: String(params.atName) } : null;

      // 限额闸：闸门（逐次确认）关掉之后，这是唯一还在防刷屏的东西。
      // 判据是确定性的，超了就拒，不给例外。
      const { config } = await loadConfig(pathsFor());
      const now = new Date();
      const quotaFile = quotaPath(pathsFor().home);
      const limits = {
        maxCommentsPerDay: config.maxCommentsPerDay,
        minMinutesBetweenComments: config.minMinutesBetweenComments,
        sameVideoCooldownDays: config.sameVideoCooldownDays,
      };
      const state = pruneState(await loadQuota(quotaFile), now);
      const decision = checkQuota(state, params.bvid, now, limits);
      if (!decision.allowed) {
        return jsonResult({ ok: false, blockedBy: "quota", error: decision.reason, limits });
      }

      const result = await sendComment({
        credential: { sessdata: credential.sessdata, bili_jct: credential.bili_jct, dedeuserid: credential.dedeuserid },
        bvid: params.bvid,
        text: params.text,
        at,
      });
      if (result.ok) {
        await saveQuota(quotaFile, recordComment(state, params.bvid, now));
      }
      return jsonResult({ ...result, at, remainingToday: Math.max(0, (decision.remainingToday ?? 1) - 1) });
    },
  });

  pi.registerCommand("bili-login", {
    description: "扫码登录 B 站：把二维码存成 PNG 并给出路径，登录成功后自动删除二维码。",
    async handler(_args: string, ctx: ExtensionCommandContext) {
      const existing = await readExistingCredential();
      if (existing) {
        say(ctx, `已经是登录状态（凭证在 ${CREDENTIAL_PATH}，到期 ${new Date(existing.expiresAt).toISOString()}）。要重新登录就说一声。`);
        return;
      }
      try {
        const session = await requestQrSession();
        const qrPath = await renderQrPng(session.url, join(resolveQrDir(ctx.cwd, (await snapshot()).config.qrDir), qrFileName()));
        await discardPreviousQr(activeLogin?.qrPath ?? null);
        activeLogin = { ...session, qrPath };
        say(
          ctx,
          [
            "二维码已保存，请用手机 B站 App 扫码并在手机上确认：",
            qrPath,
            `有效期约 ${QR_TTL_SECONDS} 秒；登录成功后这个图片会被自动删除。`,
            "扫完告诉我，我查一下状态。",
          ].join("\n"),
        );
      } catch (error) {
        say(ctx, `发起登录失败：${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerTool({
    name: "bili_login_start",
    label: "B站扫码登录（生成二维码）",
    description:
      "发起 B 站扫码登录：把二维码渲染成 PNG 存到下载目录并返回文件路径，供用户用手机 B站 App 扫描。默认目录是 cwd/downloads，可用参数 dir 覆盖。已登录时默认不重复发起（force=true 可强制换号）。不返回任何 Cookie。",
    promptSnippet: "bili_login_start: 生成 B 站登录二维码到 downloads 并返回路径",
    parameters: Type.Object(
      {
        dir: Type.Optional(Type.String({ maxLength: 1024 })),
        force: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, _signal, _update, ctx) {
      const snap = await snapshot();
      if (!params.force) {
        const existing = await readExistingCredential();
        if (existing) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    status: "already_logged_in",
                    credentialPath: CREDENTIAL_PATH,
                    expiresAt: new Date(existing.expiresAt).toISOString(),
                    hint: "已经登录，无需扫码。要换账号请传 force=true。",
                  },
                  null,
                  2,
                ),
              },
            ],
            details: { status: "already_logged_in" },
          };
        }
      }
      const session = await requestQrSession();
      const dir = params.dir ?? resolveQrDir(ctx.cwd, snap.config.qrDir);
      const qrPath = await renderQrPng(session.url, join(dir, qrFileName()));
      await discardPreviousQr(activeLogin?.qrPath ?? null);
      activeLogin = { ...session, qrPath };
      const details = {
        status: "waiting_for_scan",
        qrPath,
        expiresInSeconds: QR_TTL_SECONDS,
        credentialPath: CREDENTIAL_PATH,
        next: "让用户用手机 B站 App 扫码并确认（选「记住我/长期」），随后调用 bili_login_status 查询结果。",
      };
      return jsonResult(details);
    },
  });

  pi.registerTool({
    name: "bili_login_status",
    label: "查询扫码登录结果",
    description:
      "查询当前扫码登录状态（pending/scanned/confirmed/expired）。登录成功时写入凭证文件并删除二维码图片，返回凭证路径。没有进行中的登录会提示先调用 bili_login_start。不返回任何 Cookie 值。",
    promptSnippet: "bili_login_status: 查扫码结果；成功则落凭证并删除二维码",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      if (!activeLogin) {
        const existing = await readExistingCredential();
        const details = existing
          ? {
              status: "already_logged_in",
              credentialPath: CREDENTIAL_PATH,
              expiresAt: new Date(existing.expiresAt).toISOString(),
            }
          : { status: "no_active_login", hint: "先调用 bili_login_start 生成二维码。" };
        return jsonResult(details);
      }

      const result = await pollQrSession(activeLogin);
      const qrPath = activeLogin.qrPath;

      if (result.status === "confirmed" && result.credential) {
        const credentialPath = await writeCredential(result.credential);
        const qrDeleted = await removeQrFile(qrPath);
        activeLogin = null;
        const details = {
          status: "confirmed",
          credentialPath,
          expiresAt: new Date(result.credential.expiresAt).toISOString(),
          qrPath,
          qrDeleted,
        };
        return jsonResult(details);
      }

      if (result.status === "expired") {
        const qrDeleted = await removeQrFile(qrPath);
        activeLogin = null;
        const details = {
          status: "expired",
          message: result.message,
          qrPath,
          qrDeleted,
          hint: "二维码已失效，需重新调用 bili_login_start 生成一张。",
        };
        return jsonResult(details);
      }

      const details = {
        status: result.status,
        message: result.message,
        qrPath,
        expiresInSeconds: Math.max(
          0,
          QR_TTL_SECONDS - Math.floor((Date.now() - activeLogin.startedAt) / 1000),
        ),
      };
      return jsonResult(details);
    },
  });


  // ── 写操作处理 ─────────────────────────────────────────────────────────────
  // 默认**直接执行**（`config.confirmWrites = false`）：用户要求能无人值守地自己发东西，
  // 而逐次确认在无 UI 模式（`pi -p`，定时巡检走的就是这条路）根本弹不出来。
  // 仍保留两层可控性：
  //   ① `confirmWrites: true` 恢复逐次确认（仅交互模式可用，无 UI 仍拒绝）
  //   ② 无论开关如何，**每一次写操作都记进 writes.log** —— 事后可查"它到底发了什么"
  pi.on("tool_call", async (event, ctx) => {
    const toolName = String(event.toolName ?? "");
    const input = event.input as unknown;

    // 判定这次调用是不是"对外写"
    let description: string | null = null;
    let preview = "";

    if (toolName === "bili_whale") {
      const command = String((input as { command?: unknown })?.command ?? "").trim();
      if (isWriteCommand(command)) {
        const args = ((input as { args?: unknown })?.args ?? []) as unknown;
        // `--dry` / `--status` 不会对外发送任何东西，连审计都不用记。
        if (!(Array.isArray(args) && isDryRunArgs(args as string[]))) {
          description = `bili_whale ${command}`;
          preview = Array.isArray(args) ? args.join(" ").slice(0, 300) : "";
        }
      }
    } else if (isWriteInvocation(toolName, input)) {
      description = toolName;
      preview = findText(input)?.slice(0, 300) ?? "";
    }

    if (description) {
      await appendWriteAudit(description, preview);
    }

    // 读取限额：读太猛一样会撞 B站 412 风控（实测过），而模型每轮不会自己收敛。
    const readKind = classifyRead(toolName, input);
    if (readKind) {
      const { config } = await loadConfig(pathsFor());
      const decision = checkRead(readCounter, readKind, {
        maxReadsPerRound: config.maxReadsPerRound ?? DEFAULT_READ_LIMITS.maxReadsPerRound,
        maxHeavyReadsPerRound: config.maxHeavyReadsPerRound ?? DEFAULT_READ_LIMITS.maxHeavyReadsPerRound,
      });
      if (!decision.allowed) return { block: true, reason: decision.reason };
      if (decision.next) readCounter = decision.next;
    }

    if (!description) return;

    const { config } = await loadConfig(pathsFor());
    if (!config.confirmWrites) return; // 默认：放行

    if (!ctx.hasUI) {
      return {
        block: true,
        reason:
          `已阻止 B 站写操作（${description}）：config.confirmWrites=true 要求确认，` +
          `但当前为无 UI 模式（${ctx.mode}），按 fail-closed 拒绝。要无人值守请把它设回 false。`,
      };
    }
    const approved = await ctx.ui.confirm(
      "确认执行 B 站写操作？",
      `${description}\n${preview}\n\n这会用你已登录的 B 站账号对外发布，可能无法撤回。`,
    );
    if (!approved) return { block: true, reason: "用户拒绝了这次 B 站写操作。" };
  });

  pi.on("session_start", async (_event, ctx) => {
    const snap = await snapshot();
    if (!snap.config.enabled || !snap.config.notifyOnStart) return;
    if (snap.ranToday) return;
    // 只提示，不自动跑：自动跑会在用户没打算的时候消耗额度。
    say(ctx, `今天还没刷 B 站。要刷就说一声，或敲 /bili-scroll。`);
    for (const notice of snap.notices) say(ctx, `配置提示：${notice}`, "warning");
  });
}
