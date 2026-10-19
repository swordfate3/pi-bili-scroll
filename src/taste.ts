/**
 * taste.ts —— 插件自己的偏好与性格（只在 /bili-scroll 轮次生效）。
 *
 * ## 定位：L2「脚手架级」自我进化
 * 参照《Diving into Reliable Self-Evolving Agents》的分级，这里做的是 **L2**：
 * 改的是 prompt / 记忆这一层，不改模型权重（L1），也不改评判标准（L4）。
 *
 * ## 一条硬边界：口味可变，判据不可变
 * - **可写**：偏好统计、性格数值 —— 从经验里长出来
 * - **只读**：`SKILL.md` 里那套「值不值得占用注意力」的判据 —— 人工写的，永远不参与自更新
 * 让偏好反向改判据就是 **criterion drift**：人格会滑成"只挑自己爱看的"，编辑的判断力就没了。
 *
 * ## 谁在算什么（外部审计原则）
 * - **模型**只负责**记录事实**：看到了什么、挑没挑、为什么（`bili_taste_record`）
 * - **代码**负责**统计与推导**：命中率、衰减、traits 数值
 * 也就是说，性格是被算出来的，不是模型自我声明的 —— 这正是该 survey 强调的
 * "验收必须留在更新边界之外"。
 *
 * ## 三层文件（都在插件目录，不外泄）
 * `observations.jsonl` 流水（只增）· `reflections.jsonl` 反思（只增）
 * `traits.json` 当前快照（带版本号，旧版留在 `traits-history.jsonl`）
 */
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** 一条观察：模型看到并判断过的一条视频。 */
export interface Observation {
  at: string;
  bvid: string;
  tags: string[];
  picked: boolean;
  /** 0-5，模型自己的打分（可选） */
  score?: number;
  /** 一手 / 二手 / 不明 */
  source?: "一手" | "二手" | "不明";
  kind?: "教程" | "访谈" | "课程" | "MV" | "杂谈" | "其他";
  /** 时长（分钟），用于 patience 推导 */
  durationMin?: number;
  /** 播放量，用于 contrarian 推导 */
  views?: number;
  reason?: string;
}

/** 性格：数值而非形容词，才能被审计与画曲线。 */
export interface Traits {
  /** 愿不愿意点陌生领域（20-90） */
  curiosity: number;
  /** 愿不愿意看长内容（20-90） */
  patience: number;
  /** 是否偏爱小众（10-90） */
  contrarian: number;
}

export const DEFAULT_TRAITS: Traits = { curiosity: 50, patience: 50, contrarian: 30 };

export interface TraitEntry {
  version: number;
  at: string;
  traits: Traits;
  derivedFrom: { total: number; picked: number };
}

export interface TagStat {
  tag: string;
  /** 加权后"看到"的量 */
  seen: number;
  /** 加权后"挑中"的量 */
  picked: number;
  /** 命中率 0-1 */
  rate: number;
  /** 原始计数（未加权），用于展示与门槛判断 */
  rawSeen: number;
}

export interface TasteStats {
  total: number;
  picked: number;
  byTag: TagStat[];
  /** 原始（未加权）按 source 的命中率 */
  bySource: Array<{ source: string; rawSeen: number; picked: number; rate: number }>;
}

/** 标签归一化：去空、去重、小写、截断。 */
export function normalizeTags(tags: readonly unknown[] | undefined): string[] {
  const out = new Set<string>();
  for (const raw of tags ?? []) {
    if (typeof raw !== "string") continue;
    const t = raw.trim().toLowerCase();
    if (!t) continue;
    out.add(t.slice(0, 32));
    if (out.size >= 12) break; // 单条视频最多记 12 个标签，避免标签爆炸把统计冲淡
  }
  return [...out];
}

/** 解析一行 jsonl，坏行直接跳过（日志只增，不能因为一行坏了整份读不出）。 */
export function parseObservations(text: string): Observation[] {
  const out: Observation[] = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s) as Partial<Observation>;
      if (typeof o.bvid !== "string" || !o.bvid) continue;
      if (typeof o.picked !== "boolean") continue;
      out.push({
        at: typeof o.at === "string" ? o.at : new Date(0).toISOString(),
        bvid: o.bvid,
        tags: normalizeTags(o.tags),
        picked: o.picked,
        score: typeof o.score === "number" ? o.score : undefined,
        source: o.source === "一手" || o.source === "二手" ? o.source : o.source === "不明" ? "不明" : undefined,
        kind: o.kind,
        durationMin: typeof o.durationMin === "number" ? o.durationMin : undefined,
        views: typeof o.views === "number" ? o.views : undefined,
        reason: typeof o.reason === "string" ? o.reason.slice(0, 200) : undefined,
      });
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * 时间衰减权重：半衰期越长，旧观察越"耐用"。
 * 目的：防止"最近恰好看了一堆某类"被固化成长期偏好（scaffold overfitting）。
 */
export function decayWeight(at: string, now: Date, halfLifeDays: number): number {
  const t = new Date(at).getTime();
  if (!Number.isFinite(t)) return 0;
  const ageDays = Math.max(0, (now.getTime() - t) / 86_400_000);
  if (halfLifeDays <= 0) return 1;
  return 0.5 ** (ageDays / halfLifeDays);
}

/** 频次统计。**用命中率而不是次数** —— 看过 100 条挑 3 条不等于喜欢。 */
export function computeStats(
  observations: readonly Observation[],
  now: Date = new Date(),
  halfLifeDays = 14,
): TasteStats {
  const tagSeen = new Map<string, { w: number; pw: number; raw: number }>();
  const sourceAgg = new Map<string, { raw: number; picked: number }>();
  let picked = 0;

  for (const o of observations) {
    const w = decayWeight(o.at, now, halfLifeDays);
    if (o.picked) picked += 1;
    for (const tag of o.tags) {
      const cur = tagSeen.get(tag) ?? { w: 0, pw: 0, raw: 0 };
      cur.w += w;
      cur.raw += 1;
      if (o.picked) cur.pw += w;
      tagSeen.set(tag, cur);
    }
    const src = o.source ?? "不明";
    // 源统计用原始计数：样本量本来就不大，再加权会失真
    const s = sourceAgg.get(src) ?? { raw: 0, picked: 0 };
    s.raw += 1;
    if (o.picked) s.picked += 1;
    sourceAgg.set(src, s);
  }

  const byTag: TagStat[] = [...tagSeen.entries()]
    .map(([tag, v]) => ({
      tag,
      seen: Number(v.w.toFixed(3)),
      picked: Number(v.pw.toFixed(3)),
      rate: v.w > 0 ? v.pw / v.w : 0,
      rawSeen: v.raw,
    }))
    .sort((a, b) => b.picked - a.picked || b.rate - a.rate);

  const bySource = [...sourceAgg.entries()].map(([source, v]) => ({
    source,
    rawSeen: v.raw,
    picked: v.picked,
    rate: v.raw > 0 ? v.picked / v.raw : 0,
  }));

  return { total: observations.length, picked, byTag, bySource };
}

/** 把比例映射到区间并取整，夹在 [lo, hi]。 */
export function scale(value: number, lo: number, hi: number): number {
  const v = Math.round(hi * value + lo * (1 - value));
  return Math.max(lo - 10, Math.min(hi + 10, v));
}

/**
 * 从统计**推导**性格（不是让模型自己声明）。
 * 样本不足时一律返回默认值 —— 三条样本就定型是最典型的过拟合。
 */
export function deriveTraits(
  stats: TasteStats,
  observations: readonly Observation[],
  minSample = 8,
): Traits {
  if (stats.total < minSample || stats.picked === 0) return { ...DEFAULT_TRAITS };

  const pickedObs = observations.filter((o) => o.picked);

  // curiosity = 覆盖面 × 广度。
  // ⚠️ 只算"挑中种类 / 看到种类"是不够的：只看到一个 tag 且全挑时，覆盖率是 1，
  // 会被算成"极好奇"（实测踩过，算出 90）。所以再乘一个绝对广度因子，
  // 挑中过 5 个不同 tag 才算"够广"。
  const seenTags = new Set(observations.flatMap((o) => o.tags));
  const pickedTags = new Set(pickedObs.flatMap((o) => o.tags));
  const coverage = seenTags.size > 0 ? pickedTags.size / seenTags.size : 0;
  const breadth = Math.min(1, pickedTags.size / 5);
  const curiosity = scale(coverage * breadth, 25, 90);

  // patience：挑中的视频里 ≥15 分钟的占比
  const withDuration = pickedObs.filter((o) => typeof o.durationMin === "number");
  const longRatio =
    withDuration.length > 0 ? withDuration.filter((o) => (o.durationMin ?? 0) >= 15).length / withDuration.length : 0.3;
  const patience = scale(longRatio, 20, 90);

  // contrarian：挑中的视频里播放量 <5 万的占比
  const withViews = pickedObs.filter((o) => typeof o.views === "number");
  const smallRatio =
    withViews.length > 0 ? withViews.filter((o) => (o.views ?? 0) < 50_000).length / withViews.length : 0.3;
  const contrarian = scale(smallRatio, 10, 90);

  return { curiosity, patience, contrarian };
}

export interface TasteConfig {
  tasteEnabled: boolean;
  /** 某类至少被看到几次才允许进入偏好（默认 8） */
  tasteMinSample: number;
  /** 时间衰减半衰期（天） */
  tasteHalfLifeDays: number;
  /** 攒够多少条观察触发一次反思 */
  tasteReflectEvery: number;
}

export const DEFAULT_TASTE_CONFIG: TasteConfig = {
  tasteEnabled: true,
  tasteMinSample: 8,
  tasteHalfLifeDays: 14,
  tasteReflectEvery: 10,
};

/**
 * 生成注入提示词的「口味块」。
 * 注意：这里只描述**倾向**，不写"必须选什么" —— 否则就从偏好退化成硬规则。
 */
export function buildTasteBlock(
  stats: TasteStats,
  traits: Traits,
  options: { minSample?: number; exploration?: boolean } = {},
): string {
  const minSample = options.minSample ?? DEFAULT_TASTE_CONFIG.tasteMinSample;
  const exploration = options.exploration ?? true;

  const lines: string[] = ["## 你自己长出来的口味（不是用户的）", ""];
  lines.push(
    `刷了 ${stats.total} 条，挑中 ${stats.picked} 条。性格数值：` +
      `好奇 ${traits.curiosity}/100 · 耐心 ${traits.patience}/100 · 小众倾向 ${traits.contrarian}/100`,
  );

  const mature = stats.byTag.filter((t) => t.rawSeen >= minSample && t.rate > 0);
  if (mature.length > 0) {
    lines.push("", "**已经站得住的偏好**（样本够了，命中率高的）：");
    for (const t of mature.slice(0, 6)) {
      lines.push(`- ${t.tag}：看到 ${t.rawSeen} 条、挑中 ${Math.round(t.picked)} 条（命中率 ${(t.rate * 100).toFixed(0)}%）`);
    }
  }

  const immature = stats.byTag.filter((t) => t.rawSeen < minSample);
  if (immature.length > 0) {
    lines.push("", `**样本还不够的**（少于 ${minSample} 条，别当成偏好）：` + immature.slice(0, 6).map((t) => t.tag).join("、"));
  }

  // 负面信号的门槛比正面低：看到 4 条一条没挑，已经比"看到 8 条挑了 6 条"更有信息量。
  const dislikeThreshold = Math.max(3, Math.floor(minSample / 2));
  const disliked = stats.byTag.filter((t) => t.rawSeen >= dislikeThreshold && t.rate === 0);
  if (disliked.length > 0) {
    lines.push(
      "",
      `**反复看到但一条没挑的**（≥${dislikeThreshold} 条 0 命中，说明你确实不吃这类）：` +
        disliked.slice(0, 6).map((t) => `${t.tag}(${t.rawSeen})`).join("、"),
    );
  }

  lines.push(
    "",
    "⚠️ 这份口味只影响你**优先看什么**，不改变判据本身。判据（值不值得占用用户一次注意力）是人工写的，",
    "永远不参与自我更新 —— 让口味反向改判据，你就会退化成只会挑自己爱看的。",
  );
  if (exploration) {
    lines.push("⭐ **探索配额**：本轮至少留一个位置给上面「样本还不够」或「命中率低」的一类，否则口味会自我封闭。");
  }
  return lines.join("\n");
}

// ── 文件读写 ─────────────────────────────────────────────────────────────────

export function tastePaths(home: string) {
  const dir = join(home, "taste");
  return {
    dir,
    observations: join(dir, "observations.jsonl"),
    reflections: join(dir, "reflections.jsonl"),
    traits: join(dir, "traits.json"),
    traitsHistory: join(dir, "traits-history.jsonl"),
  };
}

export async function appendObservation(home: string, obs: Observation): Promise<void> {
  const p = tastePaths(home).observations;
  await mkdir(dirname(p), { recursive: true });
  await appendFile(p, `${JSON.stringify(obs)}\n`, "utf8");
}

export async function appendReflection(home: string, text: string): Promise<void> {
  const p = tastePaths(home).reflections;
  await mkdir(dirname(p), { recursive: true });
  await appendFile(p, `${JSON.stringify({ at: new Date().toISOString(), text: text.slice(0, 500) })}\n`, "utf8");
}

export async function readObservations(home: string): Promise<Observation[]> {
  try {
    return parseObservations(await readFile(tastePaths(home).observations, "utf8"));
  } catch {
    return [];
  }
}

/** 原子写当前快照，并把旧版追加进历史（可回滚）。 */
export async function saveTraits(home: string, traits: Traits, derivedFrom: TraitEntry["derivedFrom"]): Promise<TraitEntry> {
  const paths = tastePaths(home);
  await mkdir(paths.dir, { recursive: true });
  let previous: TraitEntry | null = null;
  try {
    previous = JSON.parse(await readFile(paths.traits, "utf8")) as TraitEntry;
  } catch {
    previous = null;
  }
  const entry: TraitEntry = {
    version: (previous?.version ?? 0) + 1,
    at: new Date().toISOString(),
    traits,
    derivedFrom,
  };
  if (previous) await appendFile(paths.traitsHistory, `${JSON.stringify(previous)}\n`, "utf8");
  const tmp = `${paths.traits}.tmp`;
  await writeFile(tmp, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, paths.traits);
  return entry;
}

export async function loadTraits(home: string): Promise<TraitEntry | null> {
  try {
    const parsed = JSON.parse(await readFile(tastePaths(home).traits, "utf8")) as TraitEntry;
    if (!parsed || typeof parsed !== "object" || !parsed.traits) return null;
    return parsed;
  } catch {
    return null;
  }
}
