/**
 * extension.ts —— 组合根。
 *
 * 这里只做三件事：注册命令、注册状态工具、在会话开始时提示。
 * **不在工厂里做任何 IO / 起进程 / 定时器**（Pi 有些调用只加载扩展而不开会话），
 * 也不持有需要清理的长期资源 —— 配置与资料都是按需读，读完即弃。
 */
import { stat } from "node:fs/promises";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadCharter } from "./charter.js";
import { loadConfig, type BiliScrollConfig } from "./config.js";
import { dayKey, pathsFor, reportPath, type BiliScrollPaths } from "./home.js";
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
      return {
        content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
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
