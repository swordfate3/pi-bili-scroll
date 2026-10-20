/**
 * voice.ts —— 评论表达方式的自我优化（只改「怎么说」，不改「说什么」）。
 *
 * 边界（和 taste.ts 一致，见 DECISIONS 33）：
 * - 可写：表达习惯、用户对语气的直接要求 —— 属于 L2 记忆；
 * - 不可写：判据（章程）与"该不该评论"的授权（`autoComment`）—— 属于 L3/L4。
 *
 * 两个刻意的设计：
 *
 * 1. **数据由代码采集，不由模型自述。**
 *    评论一旦真的发出去，`bili_comment` 就会把正文落到 `voice.jsonl`。
 *    模型没法"报告自己已经变得更有人味了"——它能做的只是写下一句话，
 *    然后由代码去数它到底像不像人。
 *
 * 2. **指标只取能算的，不取需要主观判断的。**
 *    长度分布、开头重复、是否含具体数字、是否含口语词、套话命中 —— 这些都能被
 *    确定性计算，于是"有没有进步"是可验证的；至于"够不够有趣"这类判断，
 *    不进来，也不许模型自己给自己打分。
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { decayWeight, scale } from "./taste.js";

/** 一条真实发出的评论。只有发了才有记录 —— 没发就不算练习。 */
export interface VoiceEntry {
  at: string;
  bvid: string;
  text: string;
}

export interface VoiceStats {
  /** 历史总数 */
  total: number;
  /** 参与本次统计的条数（窗口内） */
  window: number;
  avgChars: number;
  minChars: number;
  maxChars: number;
  /** 长度标准差：太低说明每条一个模子 */
  spread: number;
  /** 开头两个字重复出现的次数（≥2 才算复读） */
  repeatedOpenings: { opening: string; count: number }[];
  /** 含数字/时间点/年份的条数占比 */
  concreteRate: number;
  /** 含口语词的条数占比 */
  colloquialRate: number;
  /** 带问号的条数占比 */
  questionRate: number;
  /** 分号总数（书面味的硬指标：一句话里塞两个判断） */
  semicolons: number;
  /** 每条平均分号数 */
  avgSemicolons: number;
  /** 命中的套话及次数 */
  bannedHits: { phrase: string; count: number }[];
  avgSentences: number;
}

/**
 * 明确禁止的套话。
 * 这些词的问题是**放进任何视频下面都成立**，等于没说 —— 比不评论更糟：
 * 它消耗的是账号的信用，而不是赚来注意力。
 */
export const BANNED_PHRASES = [
  "讲得真好",
  "学到了",
  "up主辛苦",
  "一键三连",
  "受益匪浅",
  "感谢分享",
  "太强了",
  "支持一下",
  "涨知识了",
  "说得好",
];

/** 口语标记：有这些词更像人在说话，全没有更像在写通知。 */
const COLLOQUIAL_MARKS = [
  "其实",
  "不过",
  "说实话",
  "说白了",
  "倒是",
  "反而",
  "结果",
  "挺",
  "而已",
  "我觉得",
  "我觉",
  "说真的",
  "难怪",
  "确实",
  "偏偏",
  "偏偏",
];

const voicePath = (home: string) => join(home, "taste", "voice.jsonl");
export const voiceNotesPath = (home: string) => join(home, "taste", "voice-notes.jsonl");

/**
 * 说话方式的所有落盘位置。和 taste 平行：
 * - `voice.jsonl`：真实发出的评论（语料，代码采）
 * - `voice-reflections.jsonl`：每几笔一次的自述（文字，模型写）
 * - `voice-profile.json`：当前风格快照（数字，**代码算**）
 * - `voice-profile-history.jsonl`：历次快照（可回滚、可看进化轨迹）
 * - `voice-notes.jsonl`：用户直接提的语气要求（可选，优先于统计）
 */
export function voicePaths(home: string) {
  const dir = join(home, "taste");
  return {
    dir,
    voice: join(dir, "voice.jsonl"),
    reflections: join(dir, "voice-reflections.jsonl"),
    profile: join(dir, "voice-profile.json"),
    history: join(dir, "voice-profile-history.jsonl"),
    notes: join(dir, "voice-notes.jsonl"),
  };
}

/**
 * 说话方式的四个可计数值（0-100，代码推导，模型无权直接设定）。
 *
 * 只选能被确定性计算的维度 —— "有没有趣"这种需要人判断的东西不进来，
 * 否则就成了模型给自己打分，而模型永远给自己打高分。
 */
export interface VoiceTraits {
  /** 具体度：多少条里真的点了数字/时间/原文 */
  concreteness: number;
  /** 口语度：多少条里有口语词（否则就是通知体） */
  conversationality: number;
  /** 变化度：长度起伏 + 开头不重复 */
  variety: number;
  /** 精炼度：有没有为了显得充实而硬凑长度 */
  brevity: number;
}

export const DEFAULT_VOICE_TRAITS: VoiceTraits = {
  concreteness: 50,
  conversationality: 50,
  variety: 50,
  brevity: 50,
};

export interface VoiceProfileEntry {
  version: number;
  at: string;
  traits: VoiceTraits;
  derivedFrom: { total: number; window: number };
}

export interface VoiceReflection {
  at: string;
  text: string;
}

export async function readVoice(home: string): Promise<VoiceEntry[]> {
  let raw: string;
  try {
    raw = await readFile(voicePath(home), "utf8");
  } catch {
    return [];
  }
  const entries: VoiceEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<VoiceEntry>;
      if (typeof parsed.text === "string" && typeof parsed.at === "string") {
        entries.push({ at: parsed.at, bvid: String(parsed.bvid ?? ""), text: parsed.text });
      }
    } catch {
      // 坏行跳过，不让一行脏数据毁掉整个统计
    }
  }
  return entries;
}

/**
 * 追加一条真实发出的评论。
 * 调用点在发评论**成功之后** —— 失败的不记，否则统计里会混进从未给人看过的话。
 */
export async function appendVoice(home: string, entry: VoiceEntry): Promise<void> {
  await mkdir(dirname(voicePath(home)), { recursive: true });
  await appendFile(voicePath(home), JSON.stringify(entry) + "\n", "utf8");
}

const stripPunct = (text: string): string => text.replace(/[\s\p{P}\p{S}]/gu, "");

/** 取开头两个字做"复读"检测。太短的不算（"1"这种开头没有信息）。 */
function openingOf(text: string): string | null {
  const cleaned = stripPunct(text);
  return cleaned.length >= 4 ? cleaned.slice(0, 2) : null;
}

function sentenceCountOf(text: string): number {
  const parts = text.split(/[。！？!?；;\n]+/).filter((p) => p.trim().length > 0);
  return Math.max(1, parts.length);
}

/** 含数字 / 时间点 / 年份 —— “我真的看了”最硬的证据。 */
const isConcrete = (text: string): boolean =>
  /\d|[零一二三四五六七八九十百千]{1,4}(分钟|集|年|月|天|秒)/.test(text);

/** 含口语词 —— 全没有就像在写通知。 */
const isColloquial = (text: string): boolean => COLLOQUIAL_MARKS.some((mark) => text.includes(mark));

export function computeVoiceStats(entries: VoiceEntry[], window = 10): VoiceStats {
  const recent = entries.slice(-window);
  const counts = recent.map((entry) => [...entry.text].length);
  const empty: VoiceStats = {
    total: entries.length,
    window: 0,
    avgChars: 0,
    minChars: 0,
    maxChars: 0,
    spread: 0,
    repeatedOpenings: [],
    concreteRate: 0,
    colloquialRate: 0,
    questionRate: 0,
    semicolons: 0,
    avgSemicolons: 0,
    bannedHits: [],
    avgSentences: 0,
  };
  if (recent.length === 0) return empty;

  const avg = counts.reduce((sum, n) => sum + n, 0) / counts.length;
  const variance = counts.reduce((sum, n) => sum + (n - avg) ** 2, 0) / counts.length;

  const openingCounts = new Map<string, number>();
  for (const entry of recent) {
    const opening = openingOf(entry.text);
    if (opening) openingCounts.set(opening, (openingCounts.get(opening) ?? 0) + 1);
  }

  const bannedCounts = new Map<string, number>();
  for (const entry of recent) {
    const lower = entry.text.toLowerCase();
    for (const phrase of BANNED_PHRASES) {
      if (lower.includes(phrase.toLowerCase())) {
        bannedCounts.set(phrase, (bannedCounts.get(phrase) ?? 0) + 1);
      }
    }
  }

  const concrete = recent.filter((entry) => isConcrete(entry.text)).length;
  const colloquial = recent.filter((entry) => isColloquial(entry.text)).length;
  const questions = recent.filter((entry) => /[?？]/.test(entry.text)).length;
  // 分号 = 一句话里塞两个及以上判断，是书面/汇报体最稳定的信号。
  // 口语里几乎不会这么断句 —— 人说话是短句接短句，不是分号对偻。
  const semicolons = recent.reduce(
    (sum, entry) => sum + (entry.text.match(/[\uFF1B;]/g)?.length ?? 0),
    0,
  );
  const sentences = recent.reduce((sum, entry) => sum + sentenceCountOf(entry.text), 0);

  return {
    total: entries.length,
    window: recent.length,
    avgChars: Math.round(avg),
    minChars: Math.min(...counts),
    maxChars: Math.max(...counts),
    spread: Math.round(Math.sqrt(variance)),
    repeatedOpenings: [...openingCounts.entries()]
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .map(([opening, count]) => ({ opening, count })),
    concreteRate: concrete / recent.length,
    colloquialRate: colloquial / recent.length,
    questionRate: questions / recent.length,
    semicolons,
    avgSemicolons: Number((semicolons / recent.length).toFixed(2)),
    bannedHits: [...bannedCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([phrase, count]) => ({ phrase, count })),
    avgSentences: Number((sentences / recent.length).toFixed(1)),
  };
}

/**
 * 从真实评论**推导**说话方式数值（不是让模型自己声明“我变好了”）。
 *
 * 和 taste.deriveTraits 完全同一套原则：
 * - 样本不足一律回默认值（两条评论就定型是最典型的过拟合）；
 * - 时间衰减，不让一个月前的写法永远压着现在；
 * - 每一项都是可复算的比值，不是感觉分。
 */
export function deriveVoiceTraits(
  entries: readonly VoiceEntry[],
  options: { window?: number; minSample?: number; now?: Date; halfLifeDays?: number } = {},
): VoiceTraits {
  const windowSize = options.window ?? 10;
  const minSample = options.minSample ?? 5;
  const now = options.now ?? new Date();
  const halfLifeDays = options.halfLifeDays ?? 21;
  const recent = entries.slice(-windowSize);
  if (recent.length < minSample) return { ...DEFAULT_VOICE_TRAITS };

  const weights = recent.map((entry) => decayWeight(entry.at, now, halfLifeDays));
  const totalWeight = weights.reduce((sum, w) => sum + w, 0) || 1;
  const rate = (predicate: (text: string) => boolean): number =>
    recent.reduce((sum, entry, index) => sum + (predicate(entry.text) ? weights[index] : 0), 0) / totalWeight;

  const concreteness = scale(rate(isConcrete), 20, 90);
  const conversationality = scale(rate(isColloquial), 15, 90);

  // 变化度 = 长度起伏 + 开头不重复。
  // ⚠️ 只看其中一个都会被骗：每条都写 15 字但开头各不相同，或者长短交错但全是“这条…”，
  // 两个极端都会算出虚高的变化度。
  const counts = recent.map((entry) => [...entry.text].length);
  const avg = counts.reduce((sum, n) => sum + n, 0) / counts.length;
  const spread = Math.sqrt(counts.reduce((sum, n) => sum + (n - avg) ** 2, 0) / counts.length);
  const lengthVariety = Math.min(1, spread / Math.max(4, avg * 0.45));
  const openings = new Set(recent.map((entry) => openingOf(entry.text)).filter((item) => item !== null));
  const openingVariety = openings.size / recent.length;
  const variety = scale(0.5 * lengthVariety + 0.5 * openingVariety, 15, 90);

  // 精炼度：超过 50 字开始扣，超到 150 字扣完。
  // 不是“越短越好”—— 短到只剩结论同样没信息，所以这只是不鼓励硬凑。
  const brevity = scale(1 - Math.min(1, Math.max(0, avg - 50) / 100), 20, 90);

  return { concreteness, conversationality, variety, brevity };
}

export async function saveVoiceProfile(
  home: string,
  traits: VoiceTraits,
  derivedFrom: VoiceProfileEntry["derivedFrom"],
): Promise<VoiceProfileEntry> {
  const paths = voicePaths(home);
  await mkdir(paths.dir, { recursive: true });
  const previous = await loadVoiceProfile(home);
  const entry: VoiceProfileEntry = {
    version: (previous?.version ?? 0) + 1,
    at: new Date().toISOString(),
    traits,
    derivedFrom,
  };
  await appendFile(paths.history, JSON.stringify(entry) + "\n", "utf8");
  await writeFile(paths.profile, JSON.stringify(entry, null, 2) + "\n", "utf8");
  return entry;
}

export async function loadVoiceProfile(home: string): Promise<VoiceProfileEntry | null> {
  try {
    const parsed = JSON.parse(await readFile(voicePaths(home).profile, "utf8")) as VoiceProfileEntry;
    if (!parsed || typeof parsed.version !== "number" || !parsed.traits) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 模型写的自述（每几笔一次）。
 * 与统计并列，但**不能反过来改数值** —— 它只是数字旁边的一句人话。
 */
export async function appendVoiceReflection(home: string, text: string): Promise<void> {
  const paths = voicePaths(home);
  await mkdir(paths.dir, { recursive: true });
  await appendFile(
    paths.reflections,
    JSON.stringify({ at: new Date().toISOString(), text: text.slice(0, 500) }) + "\n",
    "utf8",
  );
}

export async function readVoiceReflections(home: string): Promise<VoiceReflection[]> {
  try {
    const raw = await readFile(voicePaths(home).reflections, "utf8");
    const rows: VoiceReflection[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Partial<VoiceReflection>;
        if (typeof parsed.text === "string" && typeof parsed.at === "string") {
          rows.push({ at: parsed.at, text: parsed.text });
        }
      } catch {
        // 坏行跳过
      }
    }
    return rows;
  } catch {
    return [];
  }
}

/**
 * 用户直接给出的语气要求（`/bili-voice note ...`）。
 * 与自动统计分开存：一边是"你写出来是什么样"，一边是"我要你写成什么样"。
 */
export async function readVoiceNotes(home: string): Promise<string[]> {
  try {
    const raw = await readFile(voiceNotesPath(home), "utf8");
    const notes: string[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as { text?: unknown };
        if (typeof parsed.text === "string" && parsed.text.trim()) notes.push(parsed.text.trim());
      } catch {
        // 同上：坏行跳过
      }
    }
    return notes;
  } catch {
    return [];
  }
}

export async function appendVoiceNote(home: string, text: string): Promise<void> {
  await mkdir(dirname(voiceNotesPath(home)), { recursive: true });
  await appendFile(
    voiceNotesPath(home),
    JSON.stringify({ at: new Date().toISOString(), text }) + "\n",
    "utf8",
  );
}

/**
 * 把统计翻译成"这一轮该怎么写"。
 *
 * 刻意做成**指出问题 + 给具体数值**，而不是笼统的"写得更生动些"：
 * 后者对模型几乎无约束力，前者能在下一轮被同样的代码验证有没有改善。
 * 数据不足时返回 null —— 一条评论都没发过就先别谈风格，先写出一条真的。
 */
export interface VoiceBlockOptions {
  /** 风格数值（代码推导的快照）；给了且在样本门槛内才会展示 */
  traits?: VoiceTraits | null;
  /** 数值是“快照 vN”还是“现场推导”，写清楚才不会被当成永恒结论 */
  traitsSource?: string;
  /** 历史自述，只带最近几条 */
  reflections?: readonly VoiceReflection[];
  /** 用户直接写的语气要求（可选，优先于统计） */
  notes?: readonly string[];
  minSample?: number;
  maxNotes?: number;
  maxReflections?: number;
}

/**
 * 把统计翻译成“这一轮该怎么写”。
 *
 * 刻意做成**指出问题 + 给具体数值**，而不是笼统的“写得更生动些”：
 * 后者对模型几乎无约束力，前者能在下一轮被同样的代码验证有没有改善。
 * 一条评论都没发过时返回 null —— 先写出一条真的，再谈风格。
 */
export function buildVoiceBlock(
  stats: VoiceStats,
  options: VoiceBlockOptions = {},
): string | null {
  if (stats.window === 0) return null;
  const minSample = options.minSample ?? 5;
  const maxNotes = options.maxNotes ?? 8;
  const maxReflections = options.maxReflections ?? 2;
  const lines: string[] = [
    `## 你最近 ${stats.window} 条真实评论的写法（代码统计，不是自我评价）`,
    "",
    `- 长度：平均 ${stats.avgChars} 字，最短 ${stats.minChars}、最长 ${stats.maxChars}，起伏 ${stats.spread || "0"}`,
    `- 平均 ${stats.avgSentences} 句`,
  ];

  if (options.traits && stats.window >= minSample) {
    const t = options.traits;
    const weak = (
      [
        ["具体度", t.concreteness, "少写虚的判断，多给能核对的东西：第几分钟、哪个数字、哪句原文"],
        ["口语度", t.conversationality, "像跟人说话。答一句“其实…”“不过…”“说白了…”，比排比句自然"],
        ["变化度", t.variety, "别每条一个模子：有话就多写两句，没话就两三句收住"],
        ["精炼度", t.brevity, "你在硬凑长度。删掉“也让…更清楚”这类总结句，只留你真正想说的"],
      ] as const
    )
      .filter(([, value]) => value < 45)
      .map(([name, value, advice]) => `- ${name} ${value}（偏低）—— ${advice}`);

    lines.push(
      "",
      `## 你的说话风格：具体度 ${t.concreteness} / 口语度 ${t.conversationality} / 变化度 ${t.variety} / 精炼度 ${t.brevity}`,
      `（${options.traitsSource ?? "代码从上面的评论推导"}；样本够多才会变，不是感觉分）`,
    );
    if (weak.length > 0) lines.push("", "短板在哪：", ...weak);
  }

  const problems: string[] = [];
  // ⚠️ 长度规则必须独立于最小样本门槛。验收时擒过：两条评论 87 字、153 字，
  //    而其它指标都刚好达标，于是块里输出了“这几项都还行，保持”——
  //    系统在给明显的问题背书。长度不需要样本量就能判断。
  if (stats.avgChars > 60) {
    problems.push(
      `平均 ${stats.avgChars} 字太长：目标 30–60 字。超过 60 字的部分往往是在把日报搬进评论区`,
    );
  }
  if (stats.window >= 2 && stats.avgSemicolons >= 0.5) {
    problems.push(
      `平均每条 ${stats.avgSemicolons} 个分号：分号是在一句话里塞两个判断，口头上不会这么说话。拆成两句。`,
    );
  }
  if (stats.spread < 8 && stats.window >= 3) {
    problems.push(
      `长度几乎不变（起伏只有 ${stats.spread}）：每条都一个模子会显得是套模板，该长就长、该短就短`,
    );
  }
  if (stats.repeatedOpenings.length > 0) {
    const detail = stats.repeatedOpenings
      .slice(0, 3)
      .map((item) => `「${item.opening}」×${item.count}`)
      .join("、");
    problems.push(`开头在复读（${detail}）：换个切入角度，别每条都从同一个词起手`);
  }
  if (stats.concreteRate < 0.5) {
    problems.push(
      `只有 ${Math.round(stats.concreteRate * 100)}% 提到数字、时间点或年份：具体信息是“我真的看了”最硬的证据`,
    );
  }
  if (stats.colloquialRate < 0.5) {
    problems.push(
      `只有 ${Math.round(stats.colloquialRate * 100)}% 出现口语词（其实/不过/说实话/反而）：全没有会像在写通知`,
    );
  }
  if (stats.questionRate === 0 && stats.window >= 5) {
    problems.push("一条提问都没有：偶尔把话头递出去，比单方面下结论更像聊天");
  }
  if (stats.bannedHits.length > 0) {
    const detail = stats.bannedHits.map((item) => `「${item.phrase}」×${item.count}`).join("、");
    problems.push(`出现过放之四海皆准的套话（${detail}）：不要再写这类词`);
  }

  if (problems.length > 0) {
    lines.push("", "这一轮要改的：", ...problems.map((item) => `- ${item}`));
  } else {
    lines.push("", "这几项都还行，保持：长度有起伏、有具体信息、有口语词。别为了「更丰富」而拉长。");
  }
  const reflections = (options.reflections ?? []).slice(-maxReflections);
  if (reflections.length > 0) {
    lines.push("", "## 你之前的反思（你自己写的，对照着看有没有做到）", "");
    for (const item of reflections) lines.push(`- ${item.text}`);
  }

  const notes = options.notes ?? [];
  if (notes.length > 0) {
    lines.push("", "## 用户对语气的直接要求（优先级高于上面的统计）", "");
    for (const note of notes.slice(-maxNotes)) lines.push(`- ${note}`);
  }

  return lines.join("\n");
}
