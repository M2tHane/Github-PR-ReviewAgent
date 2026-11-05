import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/config.js";

test("自定义模型服务是可选配置，填写时校验地址、接口类型和推理程度", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-config-test-"));
  try {
    await writeFile(join(dir, "key.pem"), "key");
    const base = {
      GITHUB_ALLOWED_REPOSITORIES: "o/r",
      GITHUB_PRIVATE_KEY_PATH: join(dir, "key.pem"),
      GITHUB_APP_ID: "1",
      GITHUB_WEBHOOK_SECRET: "s",
      DATABASE_URL: "postgres://x",
      MODEL_PROVIDER: "p",
      MODEL_NAME: "m",
      MODEL_API_KEY: "k",
    };
    assert.deepEqual(loadConfig(base).modelEndpoint, {
      baseUrl: undefined,
      api: "openai-completions",
      thinkingLevel: undefined,
    });
    assert.deepEqual(
      loadConfig({ ...base, MODEL_BASE_URL: "https://gw.example/v1", MODEL_THINKING: "high" }).modelEndpoint,
      { baseUrl: "https://gw.example/v1", api: "openai-completions", thinkingLevel: "high" },
    );
    assert.throws(() => loadConfig({ ...base, MODEL_BASE_URL: "gw.example" }), /MODEL_BASE_URL/);
    assert.throws(() => loadConfig({ ...base, MODEL_API: "grpc" }), /MODEL_API/);
    assert.throws(() => loadConfig({ ...base, MODEL_THINKING: "max" }), /MODEL_THINKING/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
