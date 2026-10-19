/**
 * login.ts —— B 站扫码登录（把二维码落到文件，登录后自行删除）。
 *
 * 为什么不直接跑 `bilibili-mcp setup`：那个命令是**交互式**的，需要真终端才能画二维码
 * （实测在无 TTY 环境里会拒绝：「二维码需要可交互的输入和输出，并有足够空间」）。
 * 扩展里没有终端，所以这里自己走官方扫码接口，把二维码**渲染成 PNG 存到文件**，
 * 用户用手机 App 扫图片即可。
 *
 * 凭证格式与 `bilibili-mcp` 完全一致（`~/.bilibili-mcp/config.json`，
 * 字段 sessdata / bili_jct / dedeuserid / expiresAt，其中 expiresAt 是**毫秒**），
 * 所以登录完 MCP 服务器能直接用。写完后可用它自己的 `check_bilibili_credentials` 交叉验证。
 */
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

const GENERATE_URL = "https://passport.bilibili.com/x/passport-login/web/qrcode/generate";
const POLL_URL = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll";
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
  Referer: "https://www.bilibili.com/",
};

/** 凭证文件（MCP 服务器读这个位置）。 */
export const CREDENTIAL_PATH = join(homedir(), ".bilibili-mcp", "config.json");

/** 二维码有效期（B站登录码约 180 秒）。 */
export const QR_TTL_SECONDS = 180;

export interface QrSession {
  qrcodeKey: string;
  /** 二维码里编码的登录 URL */
  url: string;
  startedAt: number;
}

/** 三个来自 cookie 的字符串字段（expiresAt 是算出来的，不在此列）。 */
export type CookieFields = Pick<BiliCredential, "sessdata" | "bili_jct" | "dedeuserid">;

export interface BiliCredential {
  sessdata: string;
  bili_jct: string;
  dedeuserid: string;
  /** 毫秒时间戳，与本机既有配置文件一致 */
  expiresAt: number;
}

export type LoginStatus = "pending" | "scanned" | "confirmed" | "expired" | "unavailable";

export interface PollResult {
  status: LoginStatus;
  message: string;
  credential?: BiliCredential;
}

/** 申请一个二维码会话。 */
export async function requestQrSession(): Promise<QrSession> {
  const response = await fetch(GENERATE_URL, { headers: HEADERS });
  if (!response.ok) throw new Error(`申请二维码失败：HTTP ${response.status}`);
  const body = (await response.json()) as {
    code?: number;
    message?: string;
    data?: { url?: string; qrcode_key?: string };
  };
  if (body.code !== 0 || !body.data?.url || !body.data.qrcode_key) {
    throw new Error(`申请二维码失败：${body.message ?? "响应缺字段"}`);
  }
  return { qrcodeKey: body.data.qrcode_key, url: body.data.url, startedAt: Date.now() };
}

/**
 * 把二维码渲染成 PNG 文件。返回文件绝对路径。
 * 先建目录，再以 0600 落盘（图片本身不含秘密，但没必要给别人读）。
 */
export async function renderQrPng(url: string, filePath: string): Promise<string> {
  const { default: QRCode } = await import("qrcode");
  const absolute = resolve(filePath);
  await mkdir(dirname(absolute), { recursive: true });
  const buffer = await QRCode.toBuffer(url, {
    type: "png",
    errorCorrectionLevel: "M",
    margin: 2,
    width: 512,
  });
  await writeFile(absolute, buffer);
  await chmod(absolute, 0o600);
  return absolute;
}

/** B站扫码状态的内部码 → 我们的状态。 */
export function mapQrCode(innerCode: number): { status: LoginStatus; message: string } {
  switch (innerCode) {
    case 0:
      return { status: "confirmed", message: "登录成功" };
    case 86101:
      return { status: "pending", message: "未扫码" };
    case 86090:
      return { status: "scanned", message: "已扫码，等待手机确认" };
    case 86038:
      return { status: "expired", message: "二维码已失效" };
    default:
      return { status: "unavailable", message: `未知状态码 ${innerCode}` };
  }
}

/** 从 Set-Cookie 里取三个字段；名字大小写不敏感。 */
export function parseCookies(setCookies: readonly string[]): Partial<CookieFields> {
  const wanted: Record<string, keyof CookieFields> = {
    sessdata: "sessdata",
    bili_jct: "bili_jct",
    dedeuserid: "dedeuserid",
  };
  const found: Partial<CookieFields> = {};
  for (const raw of setCookies) {
    const pair = raw.split(";")[0] ?? "";
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    const key = pair.slice(0, index).trim().toLowerCase();
    const value = pair.slice(index + 1).trim();
    const field = wanted[key];
    if (field && value) found[field] = value;
  }
  return found;
}

/**
 * 登录成功的跳转 URL 里也带着三个参数（URL 编码过）。
 * 有 Set-Cookie 时优先用它，这里作为兜底。
 */
export function parseCookiesFromUrl(rawUrl: string): Partial<CookieFields> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return {};
  }
  const found: Partial<CookieFields> = {};
  const mapping: Array<[string, keyof CookieFields]> = [
    ["sessdata", "sessdata"],
    ["bili_jct", "bili_jct"],
    ["dedeuserid", "dedeuserid"],
  ];
  for (const [param, field] of mapping) {
    const value = url.searchParams.get(param);
    if (value) found[field] = value;
  }
  return found;
}

/** 三个字段齐了才算拿到凭证。 */
export function buildCredential(
  parts: Partial<CookieFields>,
  now: number = Date.now(),
): BiliCredential | null {
  const { sessdata, bili_jct, dedeuserid } = parts;
  if (!sessdata || !bili_jct || !dedeuserid) return null;
  // B站 SESSDATA 默认约 30 天有效；与既有配置文件里的量级一致（毫秒）。
  return { sessdata, bili_jct, dedeuserid, expiresAt: now + 30 * 24 * 60 * 60 * 1000 };
}

/** 轮询一次扫码状态。登录成功时顺带把凭证解析出来。 */
export async function pollQrSession(session: QrSession): Promise<PollResult> {
  const url = `${POLL_URL}?qrcode_key=${encodeURIComponent(session.qrcodeKey)}`;
  const response = await fetch(url, { headers: HEADERS });
  if (!response.ok) return { status: "unavailable", message: `轮询失败：HTTP ${response.status}` };

  const setCookies = response.headers.getSetCookie?.() ?? [];
  const body = (await response.json()) as {
    code?: number;
    message?: string;
    data?: { code?: number; message?: string; url?: string };
  };
  if (body.code !== 0) {
    return { status: "unavailable", message: `轮询失败：${body.message ?? body.code}` };
  }
  const inner = body.data?.code ?? 0;
  const mapped = mapQrCode(inner);
  if (mapped.status !== "confirmed") return mapped;

  const fromCookies = parseCookies(setCookies);
  const merged = { ...parseCookiesFromUrl(body.data?.url ?? ""), ...fromCookies };
  const credential = buildCredential(merged);
  if (!credential) {
    return { status: "unavailable", message: "登录已确认，但没解析到完整凭证（cookie 字段不全）" };
  }
  return { status: "confirmed", message: mapped.message, credential };
}

/** 原子写凭证文件，权限 0600（先写临时文件再 rename）。 */
export async function writeCredential(
  credential: BiliCredential,
  path: string = CREDENTIAL_PATH,
): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
  await chmod(path, 0o600);
  return path;
}

/** 已存在且未过期的凭证。 */
export async function readExistingCredential(
  path: string = CREDENTIAL_PATH,
): Promise<BiliCredential | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    const { sessdata, bili_jct, dedeuserid, expiresAt } = record;
    if (typeof sessdata !== "string" || typeof bili_jct !== "string") return null;
    if (typeof dedeuserid !== "string" || typeof expiresAt !== "number") return null;
    if (expiresAt <= Date.now()) return null;
    return { sessdata, bili_jct, dedeuserid, expiresAt };
  } catch {
    return null;
  }
}

/** 删除二维码图片。返回是否真的删掉了。 */
export async function removeQrFile(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
  } catch {
    return false;
  }
  await rm(filePath, { force: true });
  return true;
}

/** 二维码文件名（带时间戳，避免覆盖上一张）。 */
export function qrFileName(now: Date = new Date()): string {
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  return `bili-login-qr-${stamp}.png`;
}
