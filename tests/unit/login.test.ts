import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  QR_TTL_SECONDS,
  buildCredential,
  discardPreviousQr,
  mapQrCode,
  parseCookies,
  parseCookiesFromUrl,
  qrFileName,
  readExistingCredential,
  removeQrFile,
  writeCredential,
} from "../../src/login.js";

test("mapQrCode 覆盖 B站四个状态码", () => {
  assert.equal(mapQrCode(0).status, "confirmed");
  assert.equal(mapQrCode(86101).status, "pending");
  assert.equal(mapQrCode(86090).status, "scanned");
  assert.equal(mapQrCode(86038).status, "expired");
  assert.equal(mapQrCode(12345).status, "unavailable");
});

test("parseCookies 只认三个字段，且名字大小写不敏感", () => {
  const setCookies = [
    "SESSDATA=abc123; Path=/; Domain=.bilibili.com; HttpOnly",
    "bili_jct=csrf456; Path=/",
    "DedeUserID=998877; Path=/",
    "buvid3=other; Path=/", // 不认识的不要
  ];
  const parts = parseCookies(setCookies);
  assert.deepEqual(parts, { sessdata: "abc123", bili_jct: "csrf456", dedeuserid: "998877" });
});

test("parseCookies 忽略缺等号或空值的项", () => {
  assert.deepEqual(parseCookies(["broken", "SESSDATA=; Path=/"]), {});
});

test("parseCookiesFromUrl 作为兜底解析 URL 里的参数", () => {
  const url = "https://www.bilibili.com/?sessdata=a%2Bb&bili_jct=c&dedeuserid=42";
  const parts = parseCookiesFromUrl(url);
  assert.equal(parts.sessdata, "a+b"); // URL 解码
  assert.equal(parts.bili_jct, "c");
  assert.equal(parts.dedeuserid, "42");
  assert.deepEqual(parseCookiesFromUrl("not a url"), {});
});

test("buildCredential 三个字段齐才返回，expiresAt 是毫秒且约 30 天后", () => {
  const now = 1_700_000_000_000;
  const built = buildCredential({ sessdata: "s", bili_jct: "j", dedeuserid: "d" }, now);
  assert.ok(built);
  assert.equal(built?.expiresAt, now + 30 * 24 * 60 * 60 * 1000);
  // 缺一个就不算拿到凭证
  assert.equal(buildCredential({ sessdata: "s", bili_jct: "j" }, now), null);
  assert.equal(buildCredential({}, now), null);
});

test("writeCredential 原子写、权限 0600，且能被 readExistingCredential 读回", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bili-login-"));
  try {
    const path = join(dir, "nested", "config.json");
    const credential = buildCredential({ sessdata: "s", bili_jct: "j", dedeuserid: "d" })!;
    await writeCredential(credential, path);

    const info = await stat(path);
    assert.equal(info.mode & 0o777, 0o600);

    const back = await readExistingCredential(path);
    assert.deepEqual(back, credential);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readExistingCredential 对过期/破损/缺字段返回 null", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bili-login-"));
  try {
    const path = join(dir, "config.json");
    // 过期
    await writeFile(path, JSON.stringify({ sessdata: "s", bili_jct: "j", dedeuserid: "d", expiresAt: 1 }));
    assert.equal(await readExistingCredential(path), null);
    // 破损
    await writeFile(path, "{ not json");
    assert.equal(await readExistingCredential(path), null);
    // 缺字段
    await writeFile(path, JSON.stringify({ sessdata: "s", expiresAt: Date.now() + 1e6 }));
    assert.equal(await readExistingCredential(path), null);
    // 不存在
    assert.equal(await readExistingCredential(join(dir, "nope.json")), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeCredential 不把临时文件留在原地", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bili-login-"));
  try {
    const path = join(dir, "config.json");
    await writeCredential(buildCredential({ sessdata: "s", bili_jct: "j", dedeuserid: "d" })!, path);
    const raw = await readFile(path, "utf8");
    assert.ok(raw.endsWith("\n"));
    await assert.rejects(stat(`${path}.tmp`)); // 临时文件应已被 rename 走
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("removeQrFile 删除存在文件返回 true，不存在返回 false 且不抛错", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bili-login-"));
  try {
    const path = join(dir, "qr.png");
    await writeFile(path, "x");
    assert.equal(await removeQrFile(path), true);
    assert.equal(await removeQrFile(path), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("qrFileName 带时间戳且以 .png 结尾", () => {
  const name = qrFileName(new Date(2026, 9, 19, 4, 5, 6));
  assert.equal(name, "bili-login-qr-20261019-040506.png");
  assert.equal(qrFileName(new Date(2026, 0, 2, 3, 4, 5)), "bili-login-qr-20260102-030405.png");
});

test("二维码有效期常量是 180 秒量级", () => {
  assert.equal(QR_TTL_SECONDS, 180);
});

test("重新生成二维码前会清掉上一张（force 重发不留孤儿图片）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bili-login-"));
  try {
    const oldQr = join(dir, "old.png");
    await writeFile(oldQr, "x");
    // 有上一张 → 删掉并返回 true
    assert.equal(await discardPreviousQr(oldQr), true);
    // 再删一次（已不存在）→ false，不抛错
    assert.equal(await discardPreviousQr(oldQr), false);
    // 没有上一张（首次登录）→ false
    assert.equal(await discardPreviousQr(null), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
