import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BANNED_PHRASES,
  appendVoice,
  appendVoiceNote,
  buildVoiceBlock,
  computeVoiceStats,
  readVoice,
  readVoiceNotes,
  voiceNotesPath,
  type VoiceEntry,
} from "../../src/voice.js";

const entry = (text: string, at = "2026-10-20T00:00:00.000Z"): VoiceEntry => ({
  at,
  bvid: "BV1",
  text,
});

test("没发过评论时统计为空，且不注入风格块", () => {
  const stats = computeVoiceStats([]);
  assert.equal(stats.total, 0);
  assert.equal(stats.window, 0);
  assert.equal(buildVoiceBlock(stats), null, "没有语料就不该谈风格，先写出一条真的");
});

test("开头复读能被数出来", () => {
  const stats = computeVoiceStats([
    entry("这条说的那个数值我核对过。"),
    entry("这条里第二点其实站不住。"),
    entry("这条引的那本书我查了。"),
  ]);
  assert.equal(stats.repeatedOpenings[0]?.opening, "这条");
  assert.equal(stats.repeatedOpenings[0]?.count, 3);
});

test("只出现一次的开头不算复读", () => {
  const stats = computeVoiceStats([entry("第一点站得住。"), entry("另外那个数字是错的。")]);
  assert.deepEqual(stats.repeatedOpenings, []);
});

test("套话会被点名，且大小写不敏感", () => {
  const stats = computeVoiceStats([entry("UP主辛苦"), entry("学到了，感谢分享")]);
  const phrases = stats.bannedHits.map((item) => item.phrase);
  assert.ok(phrases.includes("up主辛苦"), "大写 UP 也要能命中");
  assert.ok(phrases.includes("学到了"));
  assert.ok(phrases.includes("感谢分享"));

  const block = buildVoiceBlock(stats) ?? "";
  assert.ok(block.includes("不要再写这类词"));
  assert.ok(block.includes("up主辛苦"), "要指出具体是哪个词");
});

test("具体信息率与口语词率按真数据算", () => {
  const stats = computeVoiceStats([
    entry("第 12 分钟那个 3800 毫米的参数其实是错的。"), // 具体 + 口语
    entry("讲得真好，学到了。"), // 都不沾
    entry("讲得真好。"), // 都不沾
    entry("讲得真好。"), // 都不沾
  ]);
  assert.equal(stats.concreteRate, 0.25);
  assert.equal(stats.colloquialRate, 0.25);
  // 低于阈值就该在块里被提出来，并给出真实百分比
  const block = buildVoiceBlock(stats) ?? "";
  assert.ok(block.includes("25%"), "阈值未达标时要给出真实百分比");
});

test("长度几乎不变时提示像套模板", () => {
  const same = computeVoiceStats([entry("这个说法有点问题"), entry("这个说法有点不对"), entry("这个说法有点勉强")]);
  assert.ok(same.spread <= 2);
  assert.ok((buildVoiceBlock(same) ?? "").includes("长度几乎不变"));

  const varied = computeVoiceStats([
    entry("短。"),
    entry("这条视频里第 8 分钟那个关于内存带宽的解释其实说反了，32KB 的时代根本堆不起这个量级，作者自己后面也提到了这一点，但他没回头改前面的结论。"),
  ]);
  const block = buildVoiceBlock(varied) ?? "";
  assert.ok(!block.includes("长度几乎不变"), "长度差很大时不该误报");
});

test("一条提问都没有、且样本够多时才提示", () => {
  const flat = computeVoiceStats(Array.from({ length: 5 }, () => entry("这里有个数字对不上。")));
  assert.ok((buildVoiceBlock(flat) ?? "").includes("一条提问都没有"));

  const few = computeVoiceStats([entry("这里有个数字对不上。")]);
  assert.ok(!(buildVoiceBlock(few) ?? "").includes("一条提问都没有"), "样本不足不该下结论");
});

test("用户语气要求进块且优先于统计", () => {
  const stats = computeVoiceStats([entry("讲得真好")]);
  const block = buildVoiceBlock(stats, { notes: ["别用我觉得开头", "意见先说结论"] }) ?? "";
  assert.ok(block.includes("用户对语气的直接要求"));
  assert.ok(block.includes("别用我觉得开头"));
  assert.ok(block.includes("意见先说结论"));
  assert.ok(block.indexOf("用户对语气的直接要求") > block.indexOf("这一轮要改的"), "用户要求排在统计之后、作为更高优先级出现");
});

test("语气要求条数封顶，只带最近的（防提示词无限长）", () => {
  const notes = Array.from({ length: 20 }, (_, i) => `要求${i}`);
  const block = buildVoiceBlock(computeVoiceStats([entry("短句")]), { notes, maxNotes: 3 }) ?? "";
  assert.ok(block.includes("要求17") && block.includes("要求19"));
  assert.ok(!block.includes("要求0\n"), "超出的旧要求不该再带");
});

test("appendVoice/readVoice 往返，坏行不影响其它行", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bili-voice-"));
  try {
    await appendVoice(dir, entry("第一条真实评论"));
    await appendVoice(dir, entry("第二条真实评论"));
    // 手工塞一行脏数据：读的时候必须跳过而不是整份报废
    const { appendFile } = await import("node:fs/promises");
    await appendFile(join(dir, "taste", "voice.jsonl"), "{不是 JSON}\n", "utf8");
    const rows = await readVoice(dir);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.text), ["第一条真实评论", "第二条真实评论"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("没有文件时读出来是空数组而不是抛错", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bili-voice2-"));
  try {
    assert.deepEqual(await readVoice(dir), []);
    assert.deepEqual(await readVoiceNotes(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("语气要求能追加并读回；reset 只是删文件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bili-voice3-"));
  try {
    await appendVoiceNote(dir, "第一条要求");
    await appendVoiceNote(dir, "第二条要求");
    assert.deepEqual(await readVoiceNotes(dir), ["第一条要求", "第二条要求"]);
    assert.ok(voiceNotesPath(dir).endsWith("voice-notes.jsonl"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("套话表里没有重复项（否则计数会翻倍）", () => {
  assert.equal(new Set(BANNED_PHRASES).size, BANNED_PHRASES.length);
});

test("统计只看最近窗口，不让早期风格一直压着现在", () => {
  const old = Array.from({ length: 5 }, () => entry("讲得真好", "2026-01-01T00:00:00.000Z"));
  const fresh = Array.from({ length: 5 }, (_, i) => entry(`第 ${i + 1} 分钟那个数其实对不上。`, "2026-10-20T00:00:00.000Z"));
  const stats = computeVoiceStats([...old, ...fresh], 5);
  assert.equal(stats.total, 10);
  assert.equal(stats.window, 5);
  assert.deepEqual(stats.bannedHits, [], "窗口外的旧套话不该继续算账");
});

// ── 自进化：数值由代码推导 ──────────────────────────────────────────────────
// 和口味完全同一套原则。关键断言是"数值会随真实写法变"和"样本不足不定型"，
// 而不是某个具体分数好看 —— 分数会变，机制不能变。

import { DEFAULT_VOICE_TRAITS, deriveVoiceTraits, loadVoiceProfile, saveVoiceProfile, appendVoiceReflection, readVoiceReflections } from "../../src/voice.js";

const now = new Date("2026-10-20T00:00:00.000Z");
const many = (texts: string[]): VoiceEntry[] =>
  texts.map((text) => ({ at: "2026-10-20T00:00:00.000Z", bvid: "BV1", text }));

test("样本不足时一律回默认值，不从小样本定型", () => {
  const few = many(["这条说法有问题。"]);
  assert.deepEqual(deriveVoiceTraits(few, { minSample: 5, now }), DEFAULT_VOICE_TRAITS);
  // 4 条同样不够
  assert.deepEqual(deriveVoiceTraits(many(["a内容", "b内容", "c内容", "d内容"]), { minSample: 5, now }), DEFAULT_VOICE_TRAITS);
});

test("写得具体且有口语词时，具体度/口语度明显高于全是套话时", () => {
  const good = deriveVoiceTraits(
    many([
      "第 8 分钟那个 3800 毫米的参数其实说反了。",
      "不过他说 26 个插件这块我核对过，数字对得上。",
      "说白了就是把启动和冷加载混着算，其实该分开。",
      "我倒回去看了，第 3 分 20 秒的字幕和简介确实不一样。",
      "确实，2023 年那版只有 675 个，现在 4300 多。",
    ]),
    { minSample: 5, now },
  );
  const bad = deriveVoiceTraits(
    many(["讲得真好", "学到了", "UP主辛苦", "受益匪浅", "感谢分享"]),
    { minSample: 5, now },
  );
  assert.ok(good.concreteness > bad.concreteness, `具体度应更高：${good.concreteness} vs ${bad.concreteness}`);
  assert.ok(good.conversationality > bad.conversationality, `口语度应更高：${good.conversationality} vs ${bad.conversationality}`);
  assert.ok(good.concreteness > 60, "有明显具体信息的样本不该被判成低具体度");
});

test("每条都一个模子时变化度低，长短交错时变化度高", () => {
  const flat = deriveVoiceTraits(
    many(Array.from({ length: 5 }, (_, i) => `这条视频的第${i}点其实有问题。`)),
    { minSample: 5, now },
  );
  const varied = deriveVoiceTraits(
    many([
      "短。",
      "这条里第 8 分钟讲的 32KB 上限其实站不住，1971 年的 PDP-11 最多 64KB，作者自己后面也提到过，但前面那个结论没回头改。说白了是剪辑顺序的问题。",
      "嗯。",
      "2023 年那个数字我核过，对的。",
      "不过第三点我保留意见，他说得太满。",
    ]),
    { minSample: 5, now },
  );
  assert.ok(varied.variety > flat.variety, `变化度应更高：${varied.variety} vs ${flat.variety}`);
});

test("越写越长时精炼度下降（不鼓励硬凑长度）", () => {
  const longText = "这条视频里关于启动速度的那部分其实有个问题，就是他说三类数据各测各的，但是后面又把它们放在一起比较，这个口径前后不一致，而且第三方的 26 个条目里有两个是重复统计的，他自己在评论区也承认了这一点，所以结论要打折看。";
  const short = deriveVoiceTraits(many(["第 8 分钟那个数对不上。", "这句其实说反了。", "26 个条目里有两个重复。", "不过结论还行。", "确实，口径要分开。"]), { minSample: 5, now });
  const long = deriveVoiceTraits(many(Array.from({ length: 5 }, () => longText)), { minSample: 5, now });
  assert.ok(short.brevity > long.brevity, `短句的精炼度应更高：${short.brevity} vs ${long.brevity}`);
});

test("时间衰减：很久以前的写法不该继续压着现在", () => {
  const oldBad = Array.from({ length: 5 }, () => ({ at: "2026-01-01T00:00:00.000Z", bvid: "BV", text: "讲得真好" }));
  const newGood = Array.from({ length: 5 }, (_, i) => ({
    at: "2026-10-20T00:00:00.000Z",
    bvid: "BV",
    text: `第 ${i + 1} 分钟那个数其实对不上。`,
  }));
  const decayed = deriveVoiceTraits([...oldBad, ...newGood], { minSample: 5, now, halfLifeDays: 21, window: 10 });
  // 半衰期 21 天、间隔近 10 个月 ⇒ 旧样本权重近乎 0
  assert.ok(decayed.concreteness > 70, `旧样本应基本不影响：得到 ${decayed.concreteness}`);
});

test("profile 快照逐版递增，历史留档，可回滚", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bili-vp-"));
  try {
    assert.equal(await loadVoiceProfile(dir), null);
    const first = await saveVoiceProfile(dir, { concreteness: 40, conversationality: 30, variety: 20, brevity: 70 }, { total: 5, window: 5 });
    const second = await saveVoiceProfile(dir, { concreteness: 60, conversationality: 55, variety: 50, brevity: 65 }, { total: 10, window: 10 });
    assert.equal(first.version, 1);
    assert.equal(second.version, 2);
    assert.equal((await loadVoiceProfile(dir))?.traits.conversationality, 55, "当前应是最新一版");
    const history = (await readFile(join(dir, "taste", "voice-profile-history.jsonl"), "utf8")).trim().split("\n");
    assert.equal(history.length, 2, "历次快照都要留档");
    assert.equal(JSON.parse(history[0]).traits.conversationality, 30, "旧版仍可回溯");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("反思文字能存档并按时间读出；不参与数值计算", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bili-vr-"));
  try {
    await appendVoiceReflection(dir, "这几条都太像工作汇报，爱用分号");
    await appendVoiceReflection(dir, "还是在硬凑长度");
    const rows = await readVoiceReflections(dir);
    assert.equal(rows.length, 2);
    assert.ok(rows[0].text.includes("工作汇报"));
    // 关键：写再多反思，数值也只由真实评论决定
    const traits = deriveVoiceTraits([], { minSample: 1, now });
    assert.deepEqual(traits, DEFAULT_VOICE_TRAITS, "没有真实评论时反思不能造出数值");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("风格数值与反思都会进提示词块，且标明来源", () => {
  const stats = computeVoiceStats(many(["讲得真好", "学到了", "UP主辛苦", "受益匪浅", "感谢分享"]));
  const block = buildVoiceBlock(stats, {
    traits: { concreteness: 25, conversationality: 18, variety: 20, brevity: 88 },
    traitsSource: "快照 v3，代码从真实评论推导",
    reflections: [{ at: "2026-10-20T00:00:00.000Z", text: "全在说套话" }],
  }) ?? "";
  assert.ok(block.includes("具体度 25"));
  assert.ok(block.includes("快照 v3"));
  assert.ok(block.includes("短板在哪"));
  assert.ok(block.includes("口语度 18（偏低）"), "短板要单独点出来并给做法");
  assert.ok(block.includes("全在说套话"), "自己写过的反思要带上，对照有没有做到");
});

test("样本不足时即使有数值也不展示（避免两条评论就定型）", () => {
  const stats = computeVoiceStats(many(["讲得真好", "学到了"]));
  const block = buildVoiceBlock(stats, {
    traits: { concreteness: 20, conversationality: 16, variety: 30, brevity: 80 },
    minSample: 5,
  }) ?? "";
  assert.ok(!block.includes("你的说话风格"), "2 条 < 门槛 5，不该给出风格分数");
  assert.ok(block.includes("这一轮要改的"), "但具体问题仍应指出");
});

// ── 验收回归：系统不能替问题背书 ─────────────────────────────────────────────
// 真实验收时两条评论 87 字、153 字、还在用分号塞判断，而统计块却输出
// "这几项都还行，保持" —— 因为长度根本没有规则，其它指标又刚好过线。
// 这两条测试就是钉住那个洞。

test("平均超过 60 字必须报太长，并给出目标区间", () => {
  const long = computeVoiceStats(many([
    "同一 DeepSeek V4 Pro 做 3D 看房，字幕里报了 DeepSeek Harness 2.0 元、Codex 7.26 元，也对照了成品差异；这个成本与效果并列的比较挺具体。不过前面又采用各家自家最强模型，评论里也有人指出模型不统一，横向结论更适合看成这组任务的体验记录，不宜直接当产品排名。",
    "字幕里把启动、冷加载和界面资源三类数据分开统计，还特别注明“三种数各测各的，不相加”；这个口径说明很关键。第三方 26 个条目逐项列出、官方组件折成一行，也让清理范围更清楚。",
  ]));
  const block = buildVoiceBlock(long) ?? "";
  assert.ok(long.avgChars > 60);
  assert.ok(block.includes("字太长"), "超长必须报，不能因为其它指标过了就说'都还行'");
  assert.ok(block.includes("30–60 字"), "要给出可执行的目标长度");
  assert.ok(!block.includes("这几项都还行"), "有问题时绝不能输出'都还行'");
});

test("分号密度高时点出书面味（口头上不会这么断句）", () => {
  const stiff = computeVoiceStats(many([
    "这个方法有道理；不过数据来源存疑。",
    "结论可以看；排名不必当真。",
  ]));
  assert.equal(stiff.semicolons, 2);
  assert.equal(stiff.avgSemicolons, 1);
  const block = buildVoiceBlock(stiff) ?? "";
  assert.ok(block.includes("分号"), "分号是书面体最稳定的信号，要点出来");
});

test("真正短而具体时才允许说'保持'", () => {
  const good = computeVoiceStats(many([
    "第 8 分钟说反了，其实 32KB 那个上限是 64KB。",
    "26 个条目里有两个重复算了两遍。",
  ]));
  const block = buildVoiceBlock(good) ?? "";
  assert.ok(good.avgChars <= 60);
  assert.ok(good.avgSemicolons < 0.5);
  assert.ok(block.includes("这几项都还行"), "确实达标才说保持");
});
