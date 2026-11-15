import assert from "node:assert/strict";
import test from "node:test";
import { patchTouchesLine } from "../../src/memory/inferred-fixes.js";

test("合并 hunk 以旧侧行计算 ±3，单行、边界、纯新增、多个块和缺失 patch", () => {
  assert.equal(patchTouchesLine("@@ -17 +100 @@", 20), true);
  assert.equal(patchTouchesLine("@@ -23 +1 @@", 20), true);
  assert.equal(patchTouchesLine("@@ -16 +20 @@", 20), false);
  assert.equal(patchTouchesLine("@@ -10,7 +1,9 @@", 20), false);
  assert.equal(patchTouchesLine("@@ -10,8 +1,9 @@", 20), true);
  assert.equal(patchTouchesLine("@@ -20,0 +21,4 @@", 20), false);
  assert.equal(patchTouchesLine("@@ -10,1 +1,9 @@\n@@ -20,2 +1,0 @@", 20), true);
  assert.equal(patchTouchesLine("", 20), false);
});
