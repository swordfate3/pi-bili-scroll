/**
 * comment.ts —— 发 B 站评论，支持**真 @**。
 *
 * ## 为什么自己写
 * 上游的两个实现（`bilibili-api-python` 的 `send_comment`、whale 的 `comment.mjs`）都**不带 `at` 字段**，
 * 所以它们的 "@某人" 只是字面文本，对方收不到通知。
 *
 * ## 实测结论（2026-10-19，同一条视频两次对照）
 * - 不传 `at`：响应 `reply.content.members` 为 `[]`
 * - 传 `at={"uid":<mid>,"name":"<昵称>"}`：`members` 变成 `[{mid, uname, ...}]` ✅
 * 也就是说 `at` 是**未写进官方文档但服务端认**的字段。
 * 注意：传数组格式 `[{...}]` 实测**无效**（members 仍为空），只认单个对象。
 *
 * ## 代理
 * 容器里有 HTTP_PROXY，而 Node 的 fetch 不读它；这里沿用「fetch 失败降级 curl」的做法。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const REFERER = "https://www.bilibili.com/";

export interface MentionTarget {
  mid: string;
  name: string;
}

/** 评论需要的凭证（来自 ~/.bilibili-mcp/config.json）。 */
export interface CommentCredential {
  sessdata: string;
  bili_jct: string;
  dedeuserid: string;
  buvid3?: string;
}

/** `at` 字段：单对象 JSON 字符串（数组格式实测无效）。 */
export function buildAtField(target: MentionTarget): string {
  return JSON.stringify({ uid: Number(target.mid), name: target.name });
}

export function buildCookie(credential: CommentCredential): string {
  const parts = [
    `SESSDATA=${credential.sessdata}`,
    `bili_jct=${credential.bili_jct}`,
    `DedeUserID=${credential.dedeuserid}`,
  ];
  if (credential.buvid3) parts.push(`buvid3=${credential.buvid3}`);
  return parts.join("; ");
}

/** 评论请求体（导出便于测试与 dry 展示）。 */
export function buildCommentBody(input: {
  aid: number;
  text: string;
  csrf: string;
  at?: MentionTarget | null;
}): URLSearchParams {
  const body = new URLSearchParams();
  body.set("oid", String(input.aid));
  body.set("type", "1");
  body.set("plat", "1");
  body.set("csrf", input.csrf);
  body.set("message", input.text);
  if (input.at?.mid && input.at.name) body.set("at", buildAtField(input.at));
  return body;
}

interface PostResult {
  status: number;
  json: unknown;
}

/** POST 表单：先 fetch，失败降级 curl（fetch 不读代理变量）。 */
async function postForm(url: string, body: URLSearchParams, cookie: string): Promise<PostResult> {
  const payload = body.toString();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": UA,
        referer: REFERER,
        cookie,
      },
      body: payload,
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  } catch {
    const { stdout } = await run("curl", [
      "-sS", "-m", "30",
      "-A", UA, "-H", `Referer: ${REFERER}`, "-H", `Cookie: ${cookie}`,
      "-H", "content-type: application/x-www-form-urlencoded",
      "-X", "POST", "--data", payload, url,
    ]);
    return { status: 200, json: JSON.parse(stdout) };
  }
}

/** BV → aid（发评论要用 oid=aid）。 */
export async function resolveAid(bvid: string, cookie: string): Promise<number> {
  try {
    const res = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, {
      headers: { "user-agent": UA, referer: REFERER, cookie },
    });
    const json = (await res.json()) as { code?: number; data?: { aid?: number } };
    if (json.code === 0 && json.data?.aid) return json.data.aid;
  } catch {
    // 落到 curl
  }
  const { stdout } = await run("curl", [
    "-sS", "-m", "30", "-A", UA, "-H", `Referer: ${REFERER}`, "-H", `Cookie: ${cookie}`,
    `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
  ]);
  const json = JSON.parse(stdout) as { code?: number; data?: { aid?: number } };
  if (json.code === 0 && json.data?.aid) return json.data.aid;
  throw new Error(`拿不到 ${bvid} 的 aid（code=${json.code ?? "?"}）`);
}

export interface SendCommentResult {
  ok: boolean;
  rpid?: number;
  /** 评论所属的 aid（复核公开可见性时要用） */
  aid?: number;
  /** 服务端记录下来的被提及用户（真 @ 生效时非空） */
  members?: Array<{ mid?: string; uname?: string }>;
  error?: string;
}

/** 发一条评论；给了 at 就是真 @。 */
export async function sendComment(input: {
  credential: CommentCredential;
  bvid: string;
  text: string;
  at?: MentionTarget | null;
}): Promise<SendCommentResult> {
  const trimmed = input.text.trim();
  if (!trimmed) return { ok: false, error: "评论内容为空" };
  if (trimmed.length > 1000) return { ok: false, error: `评论超长（${trimmed.length} > 1000）` };
  if (input.at && (!input.at.mid || !input.at.name)) {
    return { ok: false, error: "@ 需要同时给 mid 和昵称" };
  }

  const cookie = buildCookie(input.credential);
  let aid: number;
  try {
    aid = await resolveAid(input.bvid, cookie);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const body = buildCommentBody({ aid, text: trimmed, csrf: input.credential.bili_jct, at: input.at });
  const { json } = await postForm("https://api.bilibili.com/x/v2/reply/add", body, cookie);
  const parsed = json as {
    code?: number;
    message?: string;
    data?: {
      rpid?: number;
      reply?: { content?: { members?: Array<{ mid?: string; uname?: string }> } };
    };
  };
  if (parsed.code !== 0) {
    return { ok: false, error: `${parsed.code}: ${parsed.message ?? "发送失败"}` };
  }
  return {
    ok: true,
    rpid: parsed.data?.rpid,
    aid,
    members: parsed.data?.reply?.content?.members ?? [],
  };
}

/**
 * 复核一条评论到底有没有**公开**出去。
 *
 * 为什么必须复核：B站 会“假成功”——`reply/add` 回 `code=0`、评论真的入库、
 * 登录态也能看到，但匿名视角查不到，`state` 不是 0（实测 17）。
 * 只看接口返回就宣布“已评论”，等于报了一个没发生的事。
 *
 * 两个视角一起看才有结论：
 *   匿名✓ + 登录态✓ → 真公开
 *   匿名✗ + 登录态✓ → 仅自己可见 / 审核中
 *   匿名✗ + 登录态✗ → 真的不存在
 */
export interface CommentVisibility {
  /** 匿名（不持任何 Cookie）能不能查到 */
  anonymousVisible: boolean;
  /** 带上自己的登录态能不能查到 */
  loggedInVisible: boolean;
  /** B站 的 state：0=公开；17=仅自己可见/审核中 */
  state: number | null;
  /** 结论：真的对外公开了吗 */
  public: boolean;
}

export async function checkCommentVisibility(input: {
  aid: number;
  rpid: number;
  cookie: string;
}): Promise<CommentVisibility> {
  const url = `https://api.bilibili.com/x/v2/reply/reply?type=1&oid=${input.aid}&root=${input.rpid}&pn=1&ps=20`;
  const fetchJson = async (cookie?: string) => {
    const headers: Record<string, string> = { "user-agent": UA, referer: REFERER };
    if (cookie) headers.cookie = cookie;
    try {
      const res = await fetch(url, { headers });
      return (await res.json().catch(() => ({}))) as { code?: number; data?: { root?: { state?: number } } };
    } catch {
      try {
        const args = ["-sS", "-m", "20", "-A", UA, "-H", `Referer: ${REFERER}`];
        if (cookie) args.push("-H", `Cookie: ${cookie}`);
        const { stdout } = await run("curl", [...args, url]);
        return JSON.parse(stdout) as { code?: number; data?: { root?: { state?: number } } };
      } catch {
        return {};
      }
    }
  };

  const anon = await fetchJson();
  const mine = await fetchJson(input.cookie);
  const anonymousVisible = anon.code === 0 && Boolean(anon.data?.root);
  const loggedInVisible = mine.code === 0 && Boolean(mine.data?.root);
  const state = typeof mine.data?.root?.state === "number" ? mine.data.root.state : null;
  return {
    anonymousVisible,
    loggedInVisible,
    state,
    public: anonymousVisible && loggedInVisible,
  };
}
