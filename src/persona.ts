/**
 * persona.ts —— 读「人设」。
 *
 * 约定：`workdir/AGENTS.md` 就是要内联进提示词的人设文件。
 *
 * 为什么必须**读进来内联**，而不是只把路径写进提示词：
 * 只给路径等于赌模型会不会自己去看一眼。实测这种"软提示"经常被忽略，
 * 表现出来的现象就是"设了人设但语气没变"。读进来就变成硬输入，模型躲不掉。
 */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/** 人设文件上限：再长就不是人设，而是文档 —— 截断并如实告知。 */
export const PERSONA_MAX_CHARS = 16_000;

export interface Persona {
  /** 实际读到的文件路径 */
  path: string;
  /** 文件内容（可能被截断） */
  content: string;
  /** 是否因为超长被截断 */
  truncated: boolean;
}

/** 从 workdir 读 AGENTS.md；读不到返回 null（不是错误）。 */
export async function readPersona(workdir: string | null): Promise<Persona | null> {
  if (!workdir) return null;
  const path = join(workdir, "AGENTS.md");
  let raw: string;
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > PERSONA_MAX_CHARS) {
    return { path, content: `${trimmed.slice(0, PERSONA_MAX_CHARS)}\n\n…（人设文件过长，已截断）`, truncated: true };
  }
  return { path, content: trimmed, truncated: false };
}
