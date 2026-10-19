import assert from "node:assert/strict";
import test from "node:test";
import { CHARTER_PATH, loadCharter, stripFrontmatter } from "../../src/charter.js";

test("stripFrontmatter 去掉 frontmatter，保留正文", () => {
  const text = "---\nname: x\ndescription: y\n---\n\n# 标题\n\n正文";
  assert.equal(stripFrontmatter(text).trim(), "# 标题\n\n正文");
});

test("stripFrontmatter 对没有 frontmatter 的文本原样返回", () => {
  const text = "# 标题\n正文";
  assert.equal(stripFrontmatter(text), text);
});

test("章程文件存在、无 frontmatter 残留、含关键判据", async () => {
  assert.ok(CHARTER_PATH.endsWith("resources/skills/bili-scroll/SKILL.md"));
  const charter = await loadCharter();
  assert.ok(charter.length > 200);
  assert.ok(!charter.startsWith("---"));
  assert.ok(!charter.includes("name: bili-scroll"));
  // 判据、只读边界、日报格式这三样是这个 skill 的实质内容，缺任一就说明章程被改坏了。
  assert.ok(charter.includes("值不值得占用用户一次注意力"));
  assert.ok(charter.includes("只读"));
  assert.ok(charter.includes("### BV"));
});
