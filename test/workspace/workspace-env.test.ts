import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gitEnv, withWorkspace } from "../../src/workspace/workspace.js";

const exec = promisify(execFile);

test("git 子进程拿不到服务密钥，只保留代理等必需变量", () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      MODEL_API_KEY: "model-secret",
      DATABASE_URL: "postgresql://u:p@db/x",
      SESSION_SECRET: "session-secret",
      HTTPS_PROXY: "http://proxy:8080",
    });
    const env = gitEnv();
    assert.equal(env.MODEL_API_KEY, undefined);
    assert.equal(env.DATABASE_URL, undefined);
    assert.equal(env.SESSION_SECRET, undefined);
    assert.equal(env.HTTPS_PROXY, "http://proxy:8080");
    assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
    // 调用方追加的配置排在前面，固定的 hooks / credential 配置接在后面，编号不冲突。
    const extended = gitEnv({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "a.b", GIT_CONFIG_VALUE_0: "c" });
    assert.equal(extended.GIT_CONFIG_COUNT, "3");
    assert.equal(extended.GIT_CONFIG_KEY_0, "a.b");
    assert.equal(extended.GIT_CONFIG_KEY_1, "core.hooksPath");
    assert.equal(extended.GIT_CONFIG_KEY_2, "credential.helper");
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("宿主机全局 git 配置里的 filter 不会作用到待审仓库", async () => {
  const source = await mkdtemp(join(tmpdir(), "pi-env-source-"));
  const home = await mkdtemp(join(tmpdir(), "pi-env-home-"));
  const marker = join(home, "filter-ran");
  const saved = { HOME: process.env.HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL };
  const git = (...args: string[]) =>
    exec("git", ["-C", source, "-c", "core.hooksPath=/dev/null", ...args], { env: gitEnv() });
  try {
    await git("init", "-q");
    await git("config", "user.name", "t");
    await git("config", "user.email", "t@example.invalid");
    await writeFile(join(source, ".gitattributes"), "*.txt filter=evil\n");
    await writeFile(join(source, "a.txt"), "data\n");
    await git("add", ".");
    await git("commit", "-qm", "c");
    const sha = (await git("rev-parse", "HEAD")).stdout.trim();
    // 模拟宿主机上装过某个 filter（例如 git lfs install 写入的 filter.lfs.*）。
    await writeFile(join(home, ".gitconfig"), `[filter "evil"]\n\tsmudge = "touch ${marker} && cat"\n`);
    process.env.HOME = home;
    delete process.env.GIT_CONFIG_GLOBAL;
    const content = await withWorkspace(source, "token", sha, sha, (root) => readFile(join(root, "a.txt"), "utf8"));
    assert.equal(content, "data\n");
    await assert.rejects(access(marker), "全局 filter 没有执行");
  } finally {
    Object.assign(process.env, saved);
    if (saved.GIT_CONFIG_GLOBAL === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    await rm(source, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
