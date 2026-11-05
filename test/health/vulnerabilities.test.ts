import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type IncomingMessage } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseHealthResult } from "../../src/health/health.service.js";
import { OsvClient, collectDependencies, parseManifest, type Dependency } from "../../src/health/vulnerabilities.js";
import {
  compareVersions,
  groupVulnerabilities,
  promptVulnerabilities,
} from "../../src/health/vulnerability-records.js";
import type { HealthJob } from "../../src/jobs/types.js";
import type { VulnerabilityRecord } from "../../src/health/types.js";

const exec = promisify(execFile);
const scope = { includePaths: [], excludePaths: [], outputLanguage: "zh-CN", budgetTokens: 1000 };

test("锁文件解析：npm、Go、Cargo、uv、requirements、pom 只取能确定的注册表版本", () => {
  const npm = parseManifest(
    "package-lock.json",
    JSON.stringify(
      {
        lockfileVersion: 3,
        packages: {
          "": { name: "app" },
          "node_modules/lodash": { version: "4.17.20" },
          "node_modules/a/node_modules/@scope/b": { version: "1.0.0", dev: true },
          "node_modules/alias": { name: "real-name", version: "2.0.0" },
          "node_modules/from-git": { version: "1.0.0", resolved: "git+ssh://git@github.com/x/y.git" },
          "node_modules/local": { link: true, resolved: "packages/local" },
        },
      },
      null,
      2,
    ),
  )!;
  assert.deepEqual(
    npm.dependencies.map((item) => [item.name, item.version, item.dev, item.line]),
    [
      ["lodash", "4.17.20", false, 7],
      ["@scope/b", "1.0.0", true, 10],
      ["real-name", "2.0.0", false, 14],
    ],
  );

  const go = parseManifest(
    "svc/go.mod",
    "module x\n\ngo 1.22\n\nrequire golang.org/x/net v0.7.0\nrequire (\n\tgithub.com/a/b v1.2.3 // indirect\n\tgithub.com/c/d v2.0.0+incompatible\n)\nreplace github.com/c/d => ../d\n",
  )!;
  assert.deepEqual(
    go.dependencies.map((item) => [item.name, item.version, item.line]),
    [
      ["golang.org/x/net", "0.7.0", 5],
      ["github.com/a/b", "1.2.3", 7],
    ],
  );
  assert.equal(go.unresolved, 1, "被 replace 的模块不按原版本查询");

  const cargo = parseManifest(
    "Cargo.lock",
    '[[package]]\nname = "app"\nversion = "0.1.0"\n\n[[package]]\nname = "time"\nversion = "0.1.43"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n',
  )!;
  assert.deepEqual(
    cargo.dependencies.map((item) => [item.name, item.version, item.line]),
    [["time", "0.1.43", 6]],
  );

  const uv = parseManifest(
    "uv.lock",
    '[[package]]\nname = "demo"\nversion = "0.1.0"\nsource = { virtual = "." }\n\n[[package]]\nname = "Jinja2"\nversion = "2.11.2"\nsource = { registry = "https://pypi.org/simple" }\ndependencies = [\n  { name = "markupsafe" },\n]\n[package.optional-dependencies]\nname = "ignored"\n',
  )!;
  assert.deepEqual(
    uv.dependencies.map((item) => [item.name, item.version]),
    [["jinja2", "2.11.2"]],
  );

  const requirements = parseManifest(
    "requirements-dev.txt",
    "# comment\nDjango==3.2.0 \\\n    --hash=sha256:abc\nrequests[security]==2.19.0 ; python_version >= '3'\nflask>=2.0\n-r base.txt\nnumpy==1.*\n",
  )!;
  assert.deepEqual(
    requirements.dependencies.map((item) => [item.name, item.version, item.line]),
    [
      ["django", "3.2.0", 2],
      ["requests", "2.19.0", 4],
    ],
  );
  assert.equal(requirements.unresolved, 2);

  const pom = parseManifest(
    "pom.xml",
    "<project>\n<properties><jackson.version>2.9.8</jackson.version></properties>\n<dependencies>\n<dependency>\n<groupId>com.fasterxml.jackson.core</groupId>\n<artifactId>jackson-databind</artifactId>\n<version>${jackson.version}</version>\n</dependency>\n<dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>4.12</version><scope>test</scope></dependency>\n<dependency><groupId>org.x</groupId><artifactId>managed</artifactId></dependency>\n</dependencies>\n</project>\n",
  )!;
  assert.deepEqual(
    pom.dependencies.map((item) => [item.name, item.version, item.dev, item.line]),
    [
      ["com.fasterxml.jackson.core:jackson-databind", "2.9.8", false, 4],
      ["junit:junit", "4.12", true, 9],
    ],
  );
  assert.equal(pom.unresolved, 1, "版本由父项目管理时不猜");
});

test("锁文件单独读取：超过普通文件上限也会检查，范围排除和不支持的锁文件写进缺失数据", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-deps-"));
  try {
    await exec("git", ["-C", root, "init", "-q"]);
    const padding = Object.fromEntries(
      Array.from({ length: 4000 }, (_, i) => [`node_modules/pad-${i}`, { version: "1.0.0", resolved: "file:x" }]),
    );
    await writeFile(
      join(root, "package-lock.json"),
      JSON.stringify(
        { lockfileVersion: 3, packages: { "node_modules/lodash": { version: "4.17.20" }, ...padding } },
        null,
        2,
      ),
    );
    await writeFile(join(root, "yarn.lock"), "# yarn\n");
    await writeFile(join(root, "requirements.txt"), "flask>=2\n");
    await exec("git", ["-C", root, "add", "."]);
    const result = await collectDependencies(root, scope, AbortSignal.timeout(5000));
    assert.deepEqual(
      result.dependencies.map((item) => item.name),
      ["lodash"],
    );
    assert.deepEqual(
      result.manifests.map((item) => [item.path, item.dependencies]),
      [
        ["package-lock.json", 1],
        ["requirements.txt", 0],
      ],
    );
    assert.deepEqual(
      result.missingData.map((item) => item.reason),
      ["unsupported_manifest", "unresolved_version"],
    );
    const excluded = await collectDependencies(
      root,
      { ...scope, excludePaths: ["package-lock.json", "yarn.lock", "requirements.txt"] },
      AbortSignal.timeout(5000),
    );
    assert.equal(excluded.manifests.length, 0);
    assert.equal(excluded.missingData.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function osvServer(handler: (path: string, body: any) => { status?: number; body: unknown }) {
  const requests: string[] = [];
  const server = createServer(async (request: IncomingMessage, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push(request.url!);
    const result = handler(request.url!, raw ? JSON.parse(raw) : undefined);
    response.writeHead(result.status ?? 200, { "content-type": "application/json" });
    response.end(JSON.stringify(result.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}`, requests, close: () => server.close() };
}

const dependency = (name: string, version: string, ecosystem: Dependency["ecosystem"] = "npm"): Dependency => ({
  ecosystem,
  name,
  version,
  manifestPath: "package-lock.json",
  line: 4,
  dev: false,
});

test("OSV 查询：批量查编号再取详情，合并互为别名的记录，按优先级排序", async () => {
  const details: Record<string, unknown> = {
    "GHSA-35jh-r3h4-6jhm": {
      id: "GHSA-35jh-r3h4-6jhm",
      summary: "Command Injection in lodash",
      aliases: ["CVE-2021-23337"],
      database_specific: { severity: "HIGH" },
      affected: [
        {
          package: { ecosystem: "npm", name: "lodash" },
          ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.21" }] }],
        },
      ],
    },
    "GHSA-low": {
      id: "GHSA-low",
      summary: "Low issue",
      database_specific: { severity: "LOW" },
      affected: [{ package: { ecosystem: "npm", name: "lodash" }, ranges: [{ events: [{ fixed: "4.17.19" }] }] }],
    },
    "PYSEC-2021-1": { id: "PYSEC-2021-1", aliases: ["GHSA-py", "CVE-2021-2"], details: "No severity here" },
    "GHSA-py": {
      id: "GHSA-py",
      aliases: ["PYSEC-2021-1", "CVE-2021-2"],
      summary: "Jinja2 ReDoS",
      database_specific: { severity: "MODERATE" },
      affected: [{ package: { ecosystem: "PyPI", name: "Jinja2" }, ranges: [{ events: [{ fixed: "2.11.3" }] }] }],
    },
  };
  const server = await osvServer((path, body) => {
    if (path === "/v1/querybatch")
      return {
        body: {
          results: body.queries.map((query: any) =>
            query.package.name === "lodash"
              ? { vulns: [{ id: "GHSA-low" }, { id: "GHSA-35jh-r3h4-6jhm" }] }
              : query.package.name === "jinja2"
                ? { vulns: [{ id: "PYSEC-2021-1" }, { id: "GHSA-py" }] }
                : {},
          ),
        },
      };
    const id = decodeURIComponent(path.replace("/v1/vulns/", ""));
    return details[id] ? { body: details[id] } : { status: 404, body: {} };
  });
  try {
    const result = await new OsvClient(server.url).audit(
      [
        dependency("lodash", "4.17.20"),
        { ...dependency("lodash", "4.17.20"), line: 90 },
        dependency("left-pad", "1.3.0"),
        dependency("jinja2", "2.11.2", "PyPI"),
      ],
      AbortSignal.timeout(5000),
    );
    assert.equal(result.queried, 3, "同一版本只查一次");
    assert.equal(server.requests.filter((path) => path === "/v1/querybatch").length, 1);
    assert.deepEqual(result.missingData, []);
    assert.deepEqual(
      result.vulnerabilities.map((record) => [record.id, record.severity, record.fixedVersions]),
      [
        ["GHSA-35jh-r3h4-6jhm", "high", ["4.17.21"]],
        ["GHSA-py", "medium", ["2.11.3"]],
        ["GHSA-low", "low", ["4.17.19"]],
      ],
    );
    assert.equal(result.vulnerabilities[0]!.url, "https://osv.dev/vulnerability/GHSA-35jh-r3h4-6jhm");
    assert.deepEqual(result.vulnerabilities[0]!.aliases, ["CVE-2021-23337"]);
  } finally {
    server.close();
  }
});

test("多个版本分支分别修复时，只给出覆盖当前版本的修复版本", async () => {
  assert.equal(compareVersions("2.9.8", "2.9.10.3"), -1);
  assert.equal(compareVersions("v1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
  const server = await osvServer((path, body) =>
    path === "/v1/querybatch"
      ? { body: { results: body.queries.map(() => ({ vulns: [{ id: "GHSA-branches" }] })) } }
      : {
          body: {
            id: "GHSA-branches",
            database_specific: { severity: "CRITICAL" },
            affected: [
              {
                package: { ecosystem: "Maven", name: "com.fasterxml.jackson.core:jackson-databind" },
                ranges: [
                  {
                    type: "ECOSYSTEM",
                    events: [
                      { introduced: "2.0.0" },
                      { fixed: "2.6.7.4" },
                      { introduced: "2.7.0" },
                      { fixed: "2.7.9.7" },
                      { introduced: "2.9.0" },
                      { fixed: "2.9.10.3" },
                    ],
                  },
                ],
              },
            ],
          },
        },
  );
  try {
    const result = await new OsvClient(server.url).audit(
      [dependency("com.fasterxml.jackson.core:jackson-databind", "2.9.8", "Maven")],
      AbortSignal.timeout(5000),
    );
    assert.deepEqual(result.vulnerabilities[0]!.fixedVersions, ["2.9.10.3"]);
  } finally {
    server.close();
  }
});

test("OSV 访问失败时记为缺失数据，不当作没有漏洞，也不让任务失败", async () => {
  const server = await osvServer(() => ({ status: 503, body: {} }));
  try {
    const result = await new OsvClient(server.url).audit([dependency("lodash", "4.17.20")], AbortSignal.timeout(5000));
    assert.deepEqual(result.vulnerabilities, []);
    assert.equal(result.queried, 0);
    assert.deepEqual(
      result.missingData.map((item) => [item.source, item.reason]),
      [["vulnerabilities", "fetch_failed"]],
    );
    assert.doesNotMatch(result.missingData[0]!.detail, /\b5\d\d\b/, "错误消息不能被误判为可重试");
  } finally {
    server.close();
  }
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(new OsvClient("http://127.0.0.1:9").audit([dependency("x", "1.0.0")], aborted.signal));
});

test("模型只能引用服务端提供的漏洞编号，security 意见必须带漏洞依据", () => {
  const record = {
    id: "GHSA-35jh-r3h4-6jhm",
    aliases: ["CVE-2021-23337"],
    summary: "Command Injection in lodash",
    severity: "high",
    ecosystem: "npm",
    package: "lodash",
    version: "4.17.20",
    manifestPath: "package-lock.json",
    dev: false,
    fixedVersions: ["4.17.21"],
    url: "https://osv.dev/vulnerability/GHSA-35jh-r3h4-6jhm",
  } satisfies VulnerabilityRecord;
  const binding = {
    job: { id: "job", repositoryId: 1 } as HealthJob,
    files: new Map([["src/a.ts", "import _ from 'lodash';"]]),
    readLines: new Map([["src/a.ts", new Set([1])]]),
    sources: [],
    memories: [],
    vulnerabilities: [record],
  };
  const finding = (references: unknown[]) =>
    JSON.stringify({
      summary: "lodash 有命令注入漏洞",
      findings: [
        {
          dimension: "security",
          severity: "high",
          evidenceLevel: "strong",
          description: "lodash 4.17.20 有命令注入漏洞，并且代码直接引用了它",
          impact: "template 处理外部输入时可执行命令",
          suggestion: "升级到 4.17.21",
          references,
        },
      ],
      limitations: [],
    });
  const result = parseHealthResult(
    finding([
      { kind: "vulnerability", id: "GHSA-35jh-r3h4-6jhm", detail: "OSV 记录" },
      { kind: "code", path: "src/a.ts", line: 1, detail: "直接引用" },
    ]),
    binding,
  );
  assert.deepEqual(result.findings[0]!.references[0], {
    kind: "vulnerability",
    id: "GHSA-35jh-r3h4-6jhm",
    detail: "OSV 记录",
  });
  assert.throws(
    () => parseHealthResult(finding([{ kind: "vulnerability", id: "CVE-2099-0001", detail: "编造" }]), binding),
    /未提供的来源/,
  );
  assert.throws(
    () =>
      parseHealthResult(finding([{ kind: "vulnerability", id: "GHSA-35jh-r3h4-6jhm", detail: "x" }]), {
        ...binding,
        vulnerabilities: undefined,
      }),
    /未提供的来源/,
    "没交给模型的记录也不能引用",
  );
  assert.throws(
    () => parseHealthResult(finding([{ kind: "code", path: "src/a.ts", line: 1, detail: "只有代码" }]), binding),
    /必须引用服务端提供的漏洞记录/,
  );
});

test("按依赖归组：给出能一次修掉全部漏洞的版本；交给模型的记录各依赖轮流取", () => {
  const record = (id: string, pkg: string, severity: VulnerabilityRecord["severity"], fixed: string[]) =>
    ({
      id,
      aliases: [],
      summary: id,
      severity,
      ecosystem: "Maven",
      package: pkg,
      version: "2.9.8",
      manifestPath: "pom.xml",
      dev: false,
      fixedVersions: fixed,
      url: `https://osv.dev/vulnerability/${id}`,
    }) satisfies VulnerabilityRecord;
  const jackson = Array.from({ length: 60 }, (_, i) =>
    record(`GHSA-j${i}`, "jackson", "critical", [`2.9.10.${i % 9}`]),
  );
  const groups = groupVulnerabilities([
    ...jackson,
    record("GHSA-nofix", "jackson", "medium", []),
    record("GHSA-l1", "lodash", "high", ["2.9.9", "3.0.0"]),
  ]);
  assert.deepEqual(
    groups.map((group) => [group.package, group.severity, group.records.length, group.upgradeTo, group.unfixed]),
    [
      ["jackson", "critical", 61, "2.9.10.8", 1],
      ["lodash", "high", 1, "2.9.9", 0],
    ],
  );
  const provided = promptVulnerabilities([...jackson, record("GHSA-l1", "lodash", "high", ["2.9.9"])], 50);
  assert.equal(provided.length, 50);
  assert.ok(
    provided.some((item) => item.id === "GHSA-l1"),
    "漏洞多的依赖不能占满名额",
  );
});
