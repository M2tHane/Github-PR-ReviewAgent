import assert from "node:assert/strict";
import test from "node:test";
import { parseModelJson, requiredText, strictObject } from "../../src/shared/model-json.js";

test("模型 JSON：去掉代码块包裹；报错只带位置，不带原文", () => {
  assert.deepEqual(parseModelJson('```json\n{"a":1}\n```', "X"), { a: 1 });
  assert.throws(() => parseModelJson("x".repeat(11), "X", 10), /^Error: X过长（11 字符，上限 10）$/);
  try {
    parseModelJson('{"summary": "SECRET_SOURCE_LINE", oops}', "Main 输出");
    assert.fail("应当报错");
  } catch (error) {
    const message = (error as Error).message;
    assert.match(message, /^Main 输出不是合法 JSON（共 \d+ 字符，第 \d+ 个字符处出错）$/);
    assert.doesNotMatch(message, /SECRET_SOURCE_LINE/);
  }
});

test("结构校验：多出字段或空文本都拒绝", () => {
  assert.deepEqual(strictObject({ a: 1 }, ["a", "b"], "R"), { a: 1 });
  assert.throws(() => strictObject({ a: 1, id: "x" }, ["a"], "R"), /R 结构无效/);
  assert.throws(() => strictObject([], ["a"], "R"), /R 结构无效/);
  assert.equal(requiredText("  t ", "T", 10), "t");
  assert.throws(() => requiredText(" ", "T", 10), /T 文本无效/);
  assert.throws(() => requiredText("x".repeat(11), "T", 10), /T 文本无效/);
});
