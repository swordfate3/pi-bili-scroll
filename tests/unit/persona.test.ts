import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PERSONA_MAX_CHARS, readPersona } from "../../src/persona.js";

test("workdir 为 null 或空时不读任何文件", async () => {
  assert.equal(await readPersona(null), null);
  assert.equal(await readPersona(""), null);
});

test("读不到 / 是目录 / 空文件都返回 null，不抛错", async () => {
  const dir = await mkdtemp(join(tmpdir(), "persona-"));
  try {
    assert.equal(await readPersona(join(dir, "nope")), null);
    // 目录而不是文件
    await mkdir(join(dir, "d", "AGENTS.md"), { recursive: true });
    assert.equal(await readPersona(join(dir, "d")), null);
    // 空文件
    await writeFile(join(dir, "empty", "AGENTS.md"), "   \n\n", { encoding: "utf8", flag: "w" }).catch(
      async () => {
        await mkdir(join(dir, "empty"), { recursive: true });
        await writeFile(join(dir, "empty", "AGENTS.md"), "   \n\n");
      },
    );
    assert.equal(await readPersona(join(dir, "empty")), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("读到正常人设：路径正确、内容去首尾空白", async () => {
  const dir = await mkdtemp(join(tmpdir(), "persona-"));
  try {
    await writeFile(join(dir, "AGENTS.md"), "\n\n# 角色\n\n语气中性。\n\n");
    const persona = await readPersona(dir);
    assert.ok(persona);
    assert.equal(persona?.path, join(dir, "AGENTS.md"));
    assert.equal(persona?.content, "# 角色\n\n语气中性。");
    assert.equal(persona?.truncated, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("超长人设被截断并标记，避免把提示词撑爆", async () => {
  const dir = await mkdtemp(join(tmpdir(), "persona-"));
  try {
    await writeFile(join(dir, "AGENTS.md"), "x".repeat(PERSONA_MAX_CHARS + 500));
    const persona = await readPersona(dir);
    assert.equal(persona?.truncated, true);
    assert.ok((persona?.content.length ?? 0) < PERSONA_MAX_CHARS + 100);
    assert.ok(persona?.content.includes("已截断"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
