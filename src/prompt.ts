/**
 * prompt.ts —— `/bili-scroll` 注入的那段请求。
 *
 * 单独成模块是为了**可测**：这段文本决定模型要不要写日报、写哪、挑几条，
 * 而它过去藏在大文件里没有任何测试覆盖，于是 `reportDetail: "none"` 时
 * 一边说"不写日报"、一边又要求"用 write 写到那个路径"，自相矛盾。
 * 这里只接受纯数据，不依赖 Pi 上下文，因此可以脱开宿主直接断言。
 */
import type { ReportDetail } from "./config.js";

export interface RunPromptInput {
  /** 值班章程（判据）正文 */
  charter: string;
  /** 本地日期键 YYYY-MM-DD */
  day: string;
  /** 当天日报的绝对路径 */
  report: string;
  /** 实际生效的关键词（已回退到内置那几组） */
  keywords: string[];
  perDay: number;
  reportDetail: ReportDetail;
  /** 人设工作区；null = 不读设定 */
  workdir: string | null;
  /** 从 workdir/AGENTS.md 读到的正文；null/缺省 = 没有可用人设 */
  persona?: { path: string; content: string; truncated?: boolean } | null;
  /** 插件自己长出来的口味块（只在巡检轮次注入，不进全局） */
  taste?: string | null;
  /** 本轮是否允许它自己发评论（config.autoComment） */
  autoComment?: boolean;
  /** 评论频控（写进提示词，让模型知道撞限就该停） */
  commentLimits?: { perDay: number; minMinutes: number; cooldownDays: number };
  /** 家目录 */
  home: string;
}

const BUILTIN_KEYWORDS = ["AI Agent", "编程", "技术分享"];

/** 关键词为空时回退到内置几组。 */
export function effectiveKeywords(keywords: string[]): string[] {
  return keywords.length > 0 ? keywords : BUILTIN_KEYWORDS;
}

/**
 * 评论授权段落。
 *
 * 两边都得写清楚，原因不同：
 * - 开着时：`bili_comment` 工具一直在工具列表里，不告诉模型"现在允许"它也不会自己发；
 *   而不把边界写死，它就会把"挑中 4 条"理解成"该评 4 条"。
 * - 关着时：同样因为工具就在那儿，不明确禁止就有被顺手调用的可能。
 */
export function buildCommentRules(
  autoComment: boolean,
  limits: { perDay: number; minMinutes: number; cooldownDays: number } = {
    perDay: 3,
    minMinutes: 30,
    cooldownDays: 7,
  },
): string {
  if (!autoComment) {
    return [
      "## 本轮不发评论",
      "",
      "`autoComment` 为关：只看不说。不要调用 `bili_comment`，也不要发私信、动态或弹幕。",
    ].join("\n");
  }
  return [
    "## 本轮允许评论（`autoComment` 为开）",
    "",
    "可以用 `bili_comment` 在**你确实读完字幕并挑中**的视频下面发言。这是唯一一个会用账号对外公开发声的动作，按下面规矩来：",
    "",
    `- **宁可不评。** 挑中 ${limits.perDay} 条不代表要评 ${limits.perDay} 条。没有真正想说的话，本轮一条都不发是正常结果。`,
    "- 评论必须指到具体内容：某句话、某个数字、某条论据、某个可以核对的事实。",
    "- **禁止**放之四海皆准的话（“讲得真好”“学到了”“UP主辛苦”“一键三连”），这类比不评更差。",
    "- 只评你读完正文的视频。没字幕、字幕和标题对不上的，一律不评。",
    `- 代码已经硬限制：每天最多 ${limits.perDay} 条、两条至少隔 ${limits.minMinutes} 分钟、同一视频 ${limits.cooldownDays} 天内只评一次。`,
    "  撞到限制就**直接停**，不要重试、不要换一种方式发。",
    "- 工具报错或被拒绝就当本轮不能发，把情况写进日报，不要绕路。",
  ].join("\n");
}

export function buildRunPrompt(input: RunPromptInput): string {
  const { charter, day, report, perDay, reportDetail, workdir, home } = input;
  const writeReport = reportDetail !== "none";

  const bullets = [
    `- 日期：${day}`,
    `- 关注关键词：${effectiveKeywords(input.keywords).map((word) => `「${word}」`).join("、")}`,
    `- 每天最多挑：${perDay} 条`,
    `- 日报详细程度：${reportDetail}${writeReport ? "" : "（本轮不写日报文件）"}`,
    `- 评论：${input.autoComment ? "允许（见下方规则）" : "本轮不发评论"}`,
  ];
  if (writeReport) bullets.push(`- 日报写到：${report}`);
  const personaBlock = input.persona
    ? [
        "",
        `## 你的人设（来自 ${input.persona.path}）`,
        "",
        "下面这段是用户为你写好的角色设定，**必须按它说话**，与本轮任何默认语气冲突时以它为准：",
        "",
        input.persona.content,
        input.persona.truncated ? "" : "",
      ].join("\n")
    : null;

  bullets.push(
    personaBlock
      ? `- 人设：已加载（见下方「你的人设」一节）`
      : workdir
        ? `- 人设工作区：${workdir}（里面没有可用的 AGENTS.md，按中性语气说话）`
        : "- 人设：未设置（按中性语气说话）",
    `- 家目录：${home}`,
  );

  // ⚠️ 这两行必须和 reportDetail 保持一致：reportDetail=none 时不能要求写文件，
  //    否则模型收到的是互相矛盾的指令（同一段请求里既说"不写日报"又说"写到某路径"）。
  const body = writeReport
    ? `搜索和读取都用 mcp 工具里 B 站那个服务器的工具（搜索视频 / 读字幕 / 读评论 / 视频元数据）。\n` +
      `不要凭标题猜内容；没有字幕的视频跳过并计数。写日报用 write 工具写到上面那个路径。`
    : `搜索和读取都用 mcp 工具里 B 站那个服务器的工具（搜索视频 / 读字幕 / 读评论 / 视频元数据）。\n` +
      `不要凭标题猜内容；没有字幕的视频跳过并计数。本轮不写任何日报文件，只在会话里把结论说清楚。`;

  return [
    "请按下面的值班章程跑一轮 B 站巡检。",
    "",
    ...bullets,
    "",
    body,
    input.taste ? `\n${input.taste}` : "",
    `\n${buildCommentRules(input.autoComment ?? false, input.commentLimits)}`,
    personaBlock ?? "",
    "",
    "---",
    "",
    charter,
  ].join("\n");
}
