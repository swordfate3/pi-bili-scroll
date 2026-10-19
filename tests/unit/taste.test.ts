import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_TRAITS,
  appendObservation,
  appendReflection,
  buildTasteBlock,
  computeStats,
  decayWeight,
  deriveTraits,
  loadTraits,
  normalizeTags,
  parseObservations,
  readObservations,
  saveTraits,
  tastePaths,
  type Observation,
} from "../../src/taste.js";

const now = new Date("2026-10-19T12:00:00Z");
const mk = (over: Partial<Observation>): Observation => ({
  at: "2026-10-19T00:00:00Z",
  bvid: "BV1x",
  tags: [],
  picked: false,
  ...over,
});

test("normalizeTags 去空去重小写并封顶", () => {
  assert.deepEqual(normalizeTags([" AI ", "ai", "", "幕后"]), ["ai", "幕后"]);
  assert.deepEqual(normalizeTags(undefined), []);
  const many = normalizeTags(Array.from({ length: 30 }, (_, i) => `t${i}`));
  assert.equal(many.length, 12, "单条最多 12 个标签，防标签爆炸");
});

test("parseObservations 跳过坏行而不是整份失败", () => {
  const text = [
    '{"at":"2026-10-19T00:00:00Z","bvid":"BV1a","tags":["ai"],"picked":true}',
    "not json",
    "",
    '{"bvid":"BV1b","picked":false}',
    '{"bvid":"","picked":true}',
  ].join("\n");
  const got = parseObservations(text);
  assert.equal(got.length, 2);
  assert.equal(got[0].bvid, "BV1a");
  assert.equal(got[1].bvid, "BV1b");
});

test("decayWeight 半衰期 14 天，越旧越轻", () => {
  assert.ok(Math.abs(decayWeight("2026-10-19T12:00:00Z", now, 14) - 1) < 1e-9);
  assert.ok(Math.abs(decayWeight("2026-10-05T12:00:00Z", now, 14) - 0.5) < 1e-6);
  assert.ok(decayWeight("2026-01-01T00:00:00Z", now, 14) < 0.01);
});

test("命中率而非次数：看过 10 条挑 1 条 ≠ 喜欢", () => {
  const obs: Observation[] = [
    ...Array.from({ length: 9 }, (_, i) => mk({ bvid: `BV${i}`, tags: ["长课"], picked: false })),
    mk({ bvid: "BVp", tags: ["长课"], picked: true }),
    mk({ bvid: "BVq", tags: ["幕后"], picked: true }),
  ];
  const stats = computeStats(obs, now);
  const long = stats.byTag.find((t) => t.tag === "长课")!;
  const behind = stats.byTag.find((t) => t.tag === "幕后")!;
  assert.ok(Math.abs(long.rate - 0.1) < 1e-9);
  assert.equal(behind.rate, 1);
  // 排序：命中率高的在前
  assert.equal(stats.byTag[0].tag, "幕后");
});

test("样本不足时性格保持默认（三条样本不许定型）", () => {
  const obs = Array.from({ length: 3 }, (_, i) => mk({ bvid: `BV${i}`, tags: ["ai"], picked: true, durationMin: 60 }));
  const stats = computeStats(obs, now);
  assert.deepEqual(deriveTraits(stats, obs, 8), DEFAULT_TRAITS);
});

test("样本够了才推导性格：长内容多→patience 高；小众多→contrarian 高；tag 集中→curiosity 低", () => {
  const obs: Observation[] = Array.from({ length: 10 }, (_, i) =>
    mk({ bvid: `BV${i}`, tags: ["ai"], picked: true, durationMin: 60, views: 1000 }),
  );
  const stats = computeStats(obs, now);
  const t = deriveTraits(stats, obs, 8);
  assert.ok(t.patience > 50, `长内容占比 100% → patience 应偏高，实际 ${t.patience}`);
  assert.ok(t.contrarian > 30, `小众占比 100% → contrarian 应偏高，实际 ${t.contrarian}`);
  assert.ok(t.curiosity < 60, `只挑一个 tag → curiosity 应偏低，实际 ${t.curiosity}`);
});

test("curiosity 看绝对广度：只见过一个 tag 时不该算高（覆盖率 1 的陷阱）", () => {
  const narrow: Observation[] = Array.from({ length: 10 }, (_, i) => mk({ bvid: `N${i}`, tags: ["ai"], picked: true }));
  const wide: Observation[] = Array.from({ length: 10 }, (_, i) =>
    mk({ bvid: `W${i}`, tags: [`topic${i}`], picked: true }),
  );
  const narrowTraits = deriveTraits(computeStats(narrow, now), narrow, 8);
  const wideTraits = deriveTraits(computeStats(wide, now), wide, 8);
  assert.ok(narrowTraits.curiosity < 50, `只看一个 tag，curiosity 应偏低，实际 ${narrowTraits.curiosity}`);
  assert.ok(wideTraits.curiosity > narrowTraits.curiosity, "十个不同 tag 应比一个 tag 更偏好奇");
});

test("口味块：成熟/不成熟/反复不选三类分开写，且声明不改判据", () => {
  const obs: Observation[] = [
    ...Array.from({ length: 8 }, (_, i) => mk({ bvid: `A${i}`, tags: ["实测"], picked: true })),
    ...Array.from({ length: 8 }, (_, i) => mk({ bvid: `B${i}`, tags: ["长课"], picked: false })),
    mk({ bvid: "C1", tags: ["新领域"], picked: false }),
  ];
  const stats = computeStats(obs, now);
  const block = buildTasteBlock(stats, DEFAULT_TRAITS, { minSample: 8 });
  assert.match(block, /已经站得住的偏好/);
  assert.match(block, /实测/);
  assert.match(block, /反复看到但一条没挑的/);
  assert.match(block, /长课/);
  assert.match(block, /样本还不够/);
  assert.match(block, /不改变判据本身/, "必须写明口味不改判据");
  assert.match(block, /探索配额/);
});

test("口味块只描述倾向，不写硬性指令", () => {
  const obs: Array<Observation> = Array.from({ length: 9 }, (_, i) => mk({ bvid: `A${i}`, tags: ["ai"], picked: true }));
  const stats = computeStats(obs, now);
  const block = buildTasteBlock(stats, DEFAULT_TRAITS, { minSample: 8 });
  assert.doesNotMatch(block, /必须选/);
  assert.doesNotMatch(block, /只能选/);
});

test("观察与反思都是 append-only；traits 快照带版本并可回滚", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taste-"));
  try {
    await appendObservation(dir, mk({ bvid: "BV1a", tags: ["ai"], picked: true }));
    await appendObservation(dir, mk({ bvid: "BV1b", tags: ["ai"], picked: false }));
    assert.equal((await readObservations(dir)).length, 2);

    await appendReflection(dir, "我好像更吃得下实测类");
    const refl = await readFile(tastePaths(dir).reflections, "utf8");
    assert.match(refl, /实测类/);

    const e1 = await saveTraits(dir, { curiosity: 60, patience: 55, contrarian: 40 }, { total: 2, picked: 1 });
    assert.equal(e1.version, 1);
    const e2 = await saveTraits(dir, { curiosity: 62, patience: 58, contrarian: 42 }, { total: 4, picked: 2 });
    assert.equal(e2.version, 2);

    const current = await loadTraits(dir);
    assert.deepEqual(current?.traits, { curiosity: 62, patience: 58, contrarian: 42 });
    // 旧版进历史，可回滚
    const history = await readFile(tastePaths(dir).traitsHistory, "utf8");
    assert.match(history, /"version":1/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readObservations 对不存在的文件返回空数组", async () => {
  const dir = await mkdtemp(join(tmpdir(), "taste-"));
  try {
    assert.deepEqual(await readObservations(join(dir, "nope")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
