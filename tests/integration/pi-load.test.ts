import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

test("Pi 实际资源加载器能在隔离 agent 目录里加载本包，且不产生副作用", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-bili-scroll-load-"));
  try {
    const packagePath = join(dirname(fileURLToPath(import.meta.url)), "../..");
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager: SettingsManager.inMemory({ packages: [] }),
      additionalExtensionPaths: [packagePath],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();

    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);

    const extension = loaded.extensions[0];
    assert.ok(extension.commands.has("bili-scroll"));
    assert.ok(extension.tools.has("bili_scroll_status"));
    // 状态工具必须声明为只读 —— 它是被模型调用的，不能有写副作用。
    assert.equal(
      extension.tools.get("bili_scroll_status")?.definition.annotations?.readOnlyHint,
      true,
    );

    // 加载期不得写出配置、日报或家目录（家目录只在真正跑一轮时才用到）。
    const files = await readdir(dir);
    for (const forbidden of ["config.json", "out", "bili-scroll.log", "state.json"]) {
      assert.ok(!files.includes(forbidden), `加载期不应创建 ${forbidden}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("包清单把命令、skill 与自带 MCP 声明都指向真实文件", async () => {
  const packagePath = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const manifest: unknown = JSON.parse(
    await (await import("node:fs/promises")).readFile(join(packagePath, "package.json"), "utf8"),
  );
  const pi = (manifest as { pi?: Record<string, unknown> }).pi;
  assert.ok(pi, "package.json 必须有 pi 段");
  assert.deepEqual(pi?.extensions, ["./src/extension.ts"]);
  assert.deepEqual(pi?.skills, ["./resources/skills"]);
  assert.equal(pi?.mcp, "./mcp.json");

  const mcp = JSON.parse(
    await (await import("node:fs/promises")).readFile(join(packagePath, "mcp.json"), "utf8"),
  ) as { mcpServers?: Record<string, { command?: string; args?: string[] }> };
  const server = mcp.mcpServers?.bilibili;
  assert.ok(server, "mcp.json 必须声明 bilibili 服务器");

  // ⚠️ 不得用 npx / .bin 启动。该包的 cli.js 用
  //    `fileURLToPath(import.meta.url) === process.argv[1]` 判定主入口，
  //    而 Node 会把 import.meta.url 解析成真实路径、argv[1] 却是符号链接路径，
  //    于是经 .bin 或 npx 启动时主入口不执行、静默退出 0（已实测）。
  //    所以必须是 `node <真实 cli.js 绝对路径>`。
  assert.equal(server?.command, "node", "必须用 node 直跑，不能用 npx/.bin");
  const entry = server?.args?.[0] ?? "";
  assert.ok(entry.startsWith("/"), `入口必须是绝对路径，实际：${entry}`);
  assert.ok(entry.endsWith("/@xzxzzx/bilibili-mcp/dist/cli.js"), `入口应指向 dist/cli.js，实际：${entry}`);
  assert.ok(!JSON.stringify(server).includes("npx"), "不得出现 npx");
  // 版本钉死在安装路径里，且安装目录在持久卷上。
  assert.ok(entry.includes("/.local/share/bili-scroll/mcp/"), `入口应在持久卷的家目录下，实际：${entry}`);
});

test("走包清单发现路径（packages）时，扩展与 skill 都被认到", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-bili-scroll-pkg-"));
  try {
    const packagePath = join(dirname(fileURLToPath(import.meta.url)), "../..");
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      // 关键差异：这里不给 additionalExtensionPaths，而是把本包当成已安装包。
      settingsManager: SettingsManager.inMemory({ packages: [packagePath] }),
    });
    await loader.reload();

    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    assert.ok(loaded.extensions[0].commands.has("bili-scroll"));
    assert.ok(loaded.extensions[0].tools.has("bili_scroll_status"));

    // pi.skills 指向的目录里必须真的有一个可发现的 bili-scroll skill。
    const skills = loader.getSkills();
    assert.deepEqual(skills.diagnostics, []);
    assert.ok(
      skills.skills.some((skill) => skill.name === "bili-scroll"),
      `未发现 bili-scroll skill，实际发现：${skills.skills.map((skill) => skill.name).join(", ")}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("真实执行工具：bili_scroll_status 能跑通并返回结构化结果", async () => {
  // 这一类回归是 typecheck 与纯单测都抓不到的：v1.0.0 曾把 jsonResult 的函数体
  // 误改成 `return jsonResult(details)`（自递归），静态检查与单测全过，
  // 但工具一调用就 RangeError: Maximum call stack size exceeded。
  // 所以这里必须真的调一次 execute()。
  const dir = await mkdtemp(join(tmpdir(), "pi-bili-scroll-exec-"));
  const savedHome = process.env.BILI_SCROLL_HOME;
  try {
    process.env.BILI_SCROLL_HOME = dir; // 隔离：不碰真实家目录
    const packagePath = join(dirname(fileURLToPath(import.meta.url)), "../..");
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager: SettingsManager.inMemory({ packages: [packagePath] }),
    });
    await loader.reload();

    const extension = loader.getExtensions().extensions[0];
    assert.ok(extension, "扩展应已加载");
    const tool = extension.tools.get("bili_scroll_status")?.definition;
    assert.ok(tool, "bili_scroll_status 应已注册");

    const execute = tool.execute as unknown as (
      id: string,
      params: Record<string, unknown>,
      signal?: unknown,
      onUpdate?: unknown,
      ctx?: unknown,
    ) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;

    const result = await execute("test-call", {});
    // 形状
    assert.equal(result.content[0]?.type, "text");
    const parsed = JSON.parse(result.content[0].text) as Record<string, unknown>;
    // 内容
    assert.equal(parsed.home, dir);
    assert.equal(typeof parsed.day, "string");
    assert.match(String(parsed.day), /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(parsed.ranToday, false);
    assert.equal(typeof parsed.report, "string");
    assert.ok(Array.isArray(parsed.notices));
    // details 与 content 必须一致（jsonResult 的契约）
    assert.deepEqual(result.details, parsed);
  } finally {
    if (savedHome === undefined) delete process.env.BILI_SCROLL_HOME;
    else process.env.BILI_SCROLL_HOME = savedHome;
    await rm(dir, { recursive: true, force: true });
  }
});
