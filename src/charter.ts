/**
 * charter.ts —— 值班章程（判据）。
 *
 * 章程的**唯一真源**是 `resources/skills/bili-scroll/SKILL.md`：
 *  - 作为 skill 分发时，模型可以自己按需加载它；
 *  - `/bili-scroll` 命令则把它整段注入当轮请求。
 * 两处共用同一个文件，避免"命令里写一份、skill 里又抄一份"然后两边说法不一致。
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const CHARTER_PATH = join(PACKAGE_ROOT, "resources", "skills", "bili-scroll", "SKILL.md");

/** 去掉 YAML frontmatter（skill 的 name/description 对模型没用，注入了只是噪音）。 */
export function stripFrontmatter(text: string): string {
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("\n---", 3);
  return end === -1 ? text : text.slice(end + 4);
}

export async function loadCharter(): Promise<string> {
  const raw = await readFile(CHARTER_PATH, "utf8");
  return stripFrontmatter(raw).trim();
}
