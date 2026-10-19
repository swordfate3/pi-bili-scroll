/**
 * extension.ts —— 组合根。
 *
 * 这里只做三件事：注册命令、注册状态工具、在会话开始时提示。
 * **不在工厂里做任何 IO / 起进程 / 定时器**（Pi 有些调用只加载扩展而不开会话），
 * 也不持有需要清理的长期资源 —— 配置与资料都是按需读，读完即弃。
 */
import { stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadCharter } from "./charter.js";
import { loadConfig, type BiliScrollConfig } from "./config.js";
import { dayKey, pathsFor, reportPath, type BiliScrollPaths } from "./home.js";
import {
  CREDENTIAL_PATH,
  QR_TTL_SECONDS,
  pollQrSession,
  qrFileName,
  readExistingCredential,
  removeQrFile,
  renderQrPng,
  requestQrSession,
  writeCredential,
  type QrSession,
} from "./login.js";
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
  if (toolName === WRITE_TOOL_MARKER || toolName.endsWith(`__${WRITE_TOOL_MARKER}`)) return true;
  if (toolName !== "mcp" && !toolName.startsWith("mcp__")) return false;
  try {
    return JSON.stringify(input ?? {}).includes(WRITE_TOOL_MARKER);
  } catch {
    return false;
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

      const prompt = buildRunPrompt({
        charter,
        day: snap.day,
        report: snap.report,
        keywords: snap.config.keywords,
        perDay: snap.config.perDay,
        reportDetail: snap.config.reportDetail,
        workdir: snap.config.workdir,
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


  // ── 写能力闸门 ──────────────────────────────────────────────────────────────
  // 发评论是拿用户的号说话，属于不可撤销的对外动作：模型不能自己决定。
  // 有 UI 时必须用户在弹窗里点头；无 UI（print/JSON/RPC）时**一律拒绝**（fail closed），
  // 绝不因为"没有界面"就默许通过。
  pi.on("tool_call", async (event, ctx) => {
    const toolName = String(event.toolName ?? "");
    const input = event.input as unknown;
    if (!isWriteInvocation(toolName, input)) return;

    const text = findText(input);
    const preview = text
      ? text.length > 200 ? `${text.slice(0, 200)}…` : text
      : "（未能从参数里读到评论正文）";

    if (!ctx.hasUI) {
      return {
        block: true,
        reason:
          `已阻止 B 站写操作：发评论必须由用户确认，当前为无 UI 模式（${ctx.mode}），` +
          "已按 fail-closed 拒绝。请在交互会话里发起，或让用户自己发。",
      };
    }
    const approved = await ctx.ui.confirm(
      "确认往 B 站发评论？",
      `内容：${preview}\n\n这会用你已登录的 B 站账号公开发布，无法撤回。`,
    );
    if (!approved) {
      return { block: true, reason: "用户拒绝了这次 B 站写操作。" };
    }
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
