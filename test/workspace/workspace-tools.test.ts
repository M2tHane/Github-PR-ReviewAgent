import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceTools } from "../../src/review/agent.js";

async function call(root: string, name: string, args: Record<string, string>) {
  const tool = workspaceTools(root).find((item) => item.name === name)!;
  const result = await tool.execute("id", args as never, undefined, undefined, undefined as never);
  return (result.content[0] as { text: string }).text;
}

test("search_text 只搜 Workspace 内文本文件，read_file 大文件只返回开头", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tools-test-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-tools-outside-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/a.ts"), "const needle = 1;\n");
    await writeFile(join(root, "image.bin"), Buffer.from("needle\0binary"));
    await writeFile(join(outside, "secret.txt"), "needle outside\n");
    await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
    await writeFile(join(root, "zz-many.txt"), "needle\n".repeat(80));
    await writeFile(join(root, "big.txt"), "x".repeat(70_000));

    const found = (await call(root, "search_text", { query: "needle" })).split("\n");
    assert.equal(found.length, 50, "最多 50 行");
    assert(found.some((line) => line === "src/a.ts:1:const needle = 1;"));
    assert(!found.some((line) => line.includes("image.bin") || line.includes("outside")), "跳过二进制和越界符号链接");
    assert.equal(await call(root, "search_text", { query: "-n" }), "未找到", "查询词不会被当成参数");

    const big = await call(root, "read_file", { path: "big.txt" });
    assert(big.startsWith("x".repeat(64_000) + "\n\n[文件共 70000 字节"));
    assert.equal(await call(root, "read_file", { path: "src/a.ts" }), "const needle = 1;\n");
    assert.match(await call(root, "read_file", { path: "link.txt" }), /符号链接超出/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
