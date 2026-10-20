import assert from "node:assert/strict";
import test from "node:test";
import { buildRunPrompt, effectiveKeywords } from "../../src/prompt.js";

const base = {
  charter: "# 章程正文\n判据是值不值得占用用户一次注意力。",
  day: "2026-05-04",
  report: "/home/node/.local/share/bili-scroll/out/2026-05-04.md",
  keywords: ["AI Agent"],
  perDay: 3,
  workdir: null as string | null,
  home: "/home/node/.local/share/bili-scroll",
};

test("reportDetail=full/brief 时注入明确的写日报指令与路径", () => {
  for (const detail of ["full", "brief"] as const) {
    const prompt = buildRunPrompt({ ...base, reportDetail: detail });
    assert.ok(prompt.includes(`- 日报写到：${base.report}`), `${detail} 应给出日报路径`);
    assert.ok(prompt.includes("写日报用 write 工具写到上面那个路径"), `${detail} 应要求写日报`);
    assert.ok(!prompt.includes("本轮不写任何日报文件"), `${detail} 不应说不写日报`);
    assert.ok(prompt.includes(`- 日报详细程度：${detail}`));
  }
});

test("reportDetail=none 时不得出现任何写日报指令或路径", () => {
  const prompt = buildRunPrompt({ ...base, reportDetail: "none" });
  // 这条是复审发现的真缺陷：同一段请求里既说"不写日报"又要求"写到某路径"，模型收到矛盾指令。
  assert.ok(!prompt.includes("写日报用 write 工具写到上面那个路径"));
  assert.ok(!prompt.includes(`- 日报写到：${base.report}`));
  assert.ok(!prompt.includes(base.report), "none 时连路径都不该出现");
  assert.ok(prompt.includes("本轮不写任何日报文件"));
  assert.ok(prompt.includes("- 日报详细程度：none（本轮不写日报文件）"));
});

test("章程原文被整段带上，且不依赖模型自己去加载 skill", () => {
  const prompt = buildRunPrompt({ ...base, reportDetail: "brief" });
  assert.ok(prompt.includes(base.charter));
  assert.ok(prompt.startsWith("请按下面的值班章程跑一轮 B 站巡检。"));
});

test("关键词为空时回退到内置几组", () => {
  assert.deepEqual(effectiveKeywords([]), ["AI Agent", "编程", "技术分享"]);
  assert.deepEqual(effectiveKeywords(["量子计算"]), ["量子计算"]);
  const prompt = buildRunPrompt({ ...base, keywords: [], reportDetail: "brief" });
  assert.ok(prompt.includes("「AI Agent」"));
  assert.ok(prompt.includes("「技术分享」"));
});

test("workdir 未设置时明确说按中性语气，不留白让模型去猜", () => {
  const withoutWorkdir = buildRunPrompt({ ...base, reportDetail: "brief" });
  assert.ok(withoutWorkdir.includes("人设：未设置（按中性语气说话）"));
  const withWorkdir = buildRunPrompt({ ...base, reportDetail: "brief", workdir: "/workspace" });
  assert.ok(withWorkdir.includes("人设工作区：/workspace"));
  assert.ok(!withWorkdir.includes("人设：未设置"));
});

test("perDay=0 也照实传达（0 表示只手动跑）", () => {
  const prompt = buildRunPrompt({ ...base, perDay: 0, reportDetail: "brief" });
  assert.ok(prompt.includes("- 每天最多挑：0 条"));
});

test("给了人设就把正文内联进请求，而不是只给路径", () => {
  const persona = { path: "/x/AGENTS.md", content: "# 角色：编辑\n宁可少一条，不要凑一条。" };
  const prompt = buildRunPrompt({ ...base, reportDetail: "brief", persona });
  assert.ok(prompt.includes("## 你的人设（来自 /x/AGENTS.md）"));
  assert.ok(prompt.includes("宁可少一条，不要凑一条"));
  assert.ok(prompt.includes("必须按它说话"));
  assert.ok(prompt.includes("- 人设：已加载"));
  // 不应该再出现"按那个路径去看设定"这种软提示
  assert.ok(!prompt.includes("有 AGENTS.md 时按那里的语气说话"));
});

test("workdir 设了但没读到文件时，明确告知按中性语气且不假装有设定", () => {
  const prompt = buildRunPrompt({ ...base, reportDetail: "brief", workdir: "/x", persona: null });
  assert.ok(prompt.includes("里面没有可用的 AGENTS.md，按中性语气说话"));
  assert.ok(!prompt.includes("## 你的人设"));
});

test("都没设置时按中性语气", () => {
  const prompt = buildRunPrompt({ ...base, reportDetail: "brief" });
  assert.ok(prompt.includes("- 人设：未设置（按中性语气说话）"));
});

// ── 评论授权 ────────────────────────────────────────────────────────────────
// `bili_comment` 工具一直在工具列表里，所以"允不允许"只能靠这段文字表达。
// 两条边界都要测死：关着时不能留任何模糊空间，开着时不能把频控写成写死的数字。

test("autoComment 默认（未传/关）时明确禁止评论，且不出现任何授权措辞", () => {
  const omitted = buildRunPrompt({ ...base, reportDetail: "brief" });
  const off = buildRunPrompt({ ...base, reportDetail: "brief", autoComment: false });
  for (const [name, prompt] of [["未传", omitted], ["false", off]] as const) {
    assert.ok(prompt.includes("## 本轮不发评论"), `${name} 应有独立的禁止段落`);
    assert.ok(prompt.includes("`autoComment` 为关"), `${name} 应点明开关名，便于排查`);
    assert.ok(!prompt.includes("本轮允许评论"), `${name} 不得出现任何授权措辞`);
    assert.ok(prompt.includes("- 评论：本轮不发评论"), `${name} 摘要行也要写清`);
  }
});

test("autoComment 开着时给的是真配置的频控数字，而不是写死的默认值", () => {
  const prompt = buildRunPrompt({
    ...base,
    reportDetail: "brief",
    autoComment: true,
    commentLimits: { perDay: 2, minMinutes: 45, cooldownDays: 14 },
  });
  assert.ok(prompt.includes("## 本轮允许评论"));
  assert.ok(prompt.includes("每天最多 2 条"), "每日上限应是配置值 2，不是默认 3");
  assert.ok(prompt.includes("至少隔 45 分钟"), "间隔应是配置值 45，不是默认 30");
  assert.ok(prompt.includes("14 天内只评一次"), "冷却应是配置值 14，不是默认 7");
  assert.ok(!prompt.includes("## 本轮不发评论"), "开着时不得同时出现禁止段落");
});

test("开着时压住数量冲动，但不得把'不评'写成安全默认", () => {
  const prompt = buildRunPrompt({
    ...base,
    reportDetail: "brief",
    autoComment: true,
    commentLimits: { perDay: 4, minMinutes: 30, cooldownDays: 7 },
  });
  // 上限要有，但不发不能变成"更稳妥"的出口 ——
  // 实测教训：只写"宁可不评"，结果是连续几轮一条都不评。
  assert.ok(prompt.includes("本轮至少要评 1 条"), "必须给出下限，否则会退化成永不评论");
  assert.ok(prompt.includes("挑中 4 条不代表要评 4 条"), "上限也要写，防刷屏");
  assert.ok(!prompt.includes("宁可不评"), "不能把不作为写成推荐做法");
  assert.ok(prompt.includes("不发不是“更稳妥”，是这项没做完"), "要点明不发是未完成而非保守");
  assert.ok(prompt.includes("讲得真好"), "必须点名禁止无信息量的套话");
  assert.ok(prompt.includes("撞到限制就**直接停**"), "撞限必须停手，不能重试");
});

test("没评论时必须在日报里交代原因（可审计，不靠猜）", () => {
  const prompt = buildRunPrompt({ ...base, reportDetail: "brief", autoComment: true });
  assert.ok(prompt.includes("日报里要写清本轮评了什么"));
  assert.ok(prompt.includes("确实没评就写明为什么没评"));
});

test("开着时仍然禁止评没读到正文的视频（字幕挂错场景）", () => {
  const prompt = buildRunPrompt({ ...base, reportDetail: "brief", autoComment: true });
  assert.ok(prompt.includes("没字幕、字幕和标题对不上的，一律不评"));
});
