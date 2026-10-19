import assert from "node:assert/strict";
import test from "node:test";
import { jsonResult } from "../../src/extension.js";

test("jsonResult 返回 content + details 的规范形状", () => {
  const result = jsonResult({ status: "ok", n: 2 });
  assert.equal(result.details.status, "ok");
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  assert.equal(result.content[0].text, JSON.stringify({ status: "ok", n: 2 }, null, 2));
});

test("jsonResult 不能自我递归（曾经的回归：函数体被误改成 return jsonResult(details)）", () => {
  // 若实现退化成自递归，这里会抛 RangeError: Maximum call stack size exceeded。
  assert.doesNotThrow(() => jsonResult({ a: 1 }));
  const result = jsonResult({ a: 1 });
  assert.deepEqual(result.details, { a: 1 });
});
