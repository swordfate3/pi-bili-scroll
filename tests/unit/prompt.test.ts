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
  assert.ok(withoutWorkdir.includes("人设工作区：未设置（按中性语气说话）"));
  const withWorkdir = buildRunPrompt({ ...base, reportDetail: "brief", workdir: "/workspace" });
  assert.ok(withWorkdir.includes("人设工作区：/workspace"));
  assert.ok(!withWorkdir.includes("未设置（按中性语气说话）"));
});

test("perDay=0 也照实传达（0 表示只手动跑）", () => {
  const prompt = buildRunPrompt({ ...base, perDay: 0, reportDetail: "brief" });
  assert.ok(prompt.includes("- 每天最多挑：0 条"));
});
