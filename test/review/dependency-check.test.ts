import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { checkDependencyChanges } from "../../src/review/dependency-check.js";
import { validateDisplay } from "../../src/review/presentation.js";
import type { Dependency } from "../../src/health/vulnerabilities.js";
import type { VulnerabilityRecord } from "../../src/health/types.js";
import type { StoredFinding } from "../../src/review/types.js";

const exec = promisify(execFile);
const lock = (packages: Record<string, string>) =>
  JSON.stringify(
    {
      lockfileVersion: 3,
      packages: Object.fromEntries(
        Object.entries(packages).map(([name, version]) => [`node_modules/${name}`, { version }]),
      ),
    },
    null,
    2,
  );
const record = (pkg: string, version: string, severity: VulnerabilityRecord["severity"], fixed: string[]) =>
  ({
    id: `GHSA-${pkg}`,
    aliases: [`CVE-2021-${pkg.length}`],
    summary: `${pkg} issue`,
    severity,
    ecosystem: "npm",
    package: pkg,
    version,
    manifestPath: "package-lock.json",
    line: 4,
    dev: false,
    fixedVersions: fixed,
    url: `https://osv.dev/vulnerability/GHSA-${pkg}`,
  }) satisfies VulnerabilityRecord;

async function repository(base: Record<string, string> | null, head: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "pi-dep-check-"));
  const git = (...args: string[]) =>
    exec("git", [
      "-C",
      root,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ]);
  await git("init", "-q");
  await writeFile(join(root, "README.md"), "x\n");
  if (base) await writeFile(join(root, "package-lock.json"), lock(base));
  await git("add", ".");
  await git("commit", "-qm", "base");
  const baseSha = (await git("rev-parse", "HEAD")).stdout.trim();
  await writeFile(join(root, "package-lock.json"), lock(head));
  await git("add", ".");
  await git("commit", "-qm", "head");
  return { root, baseSha };
}

function fakeOsv(records: VulnerabilityRecord[]) {
  const calls: string[][] = [];
  return {
    calls,
    audit: async (dependencies: Dependency[]) => {
      calls.push(dependencies.map((item) => `${item.name}@${item.version}`));
      return {
        queried: new Set(dependencies.map((item) => `${item.name}@${item.version}`)).size,
        missingData: [],
        vulnerabilities: records.filter((item) =>
          dependencies.some((dep) => dep.name === item.package && dep.version === item.version),
        ),
      };
    },
  };
}

test("PR 只查询新引入或换了版本的依赖，高危且可修复的生成问题，其余只在管理页列出", async () => {
  const { root, baseSha } = await repository(
    { react: "18.2.0", lodash: "4.17.21" },
    { react: "18.2.0", lodash: "4.17.20", "left-pad": "1.3.0" },
  );
  try {
    const osv = fakeOsv([record("lodash", "4.17.20", "high", ["4.17.21"]), record("left-pad", "1.3.0", "low", [])]);
    const result = await checkDependencyChanges(
      root,
      baseSha,
      [{ filename: "package-lock.json", status: "modified" }],
      osv,
      [],
      AbortSignal.timeout(5000),
    );
    assert.deepEqual(osv.calls, [["lodash@4.17.20", "left-pad@1.3.0"]], "没变的 react 不查询");
    assert.equal(result.findings.length, 1);
    const [finding] = result.findings;
    assert.equal(finding!.category, "security");
    assert.equal(finding!.severity, "high");
    assert.equal(finding!.path, "package-lock.json");
    assert.equal(finding!.side, "RIGHT");
    assert.match(finding!.suggestion!, /4\.17\.21/);
    validateDisplay(finding!.display);
    assert.match(result.limitations.join("\n"), /另有 1 个/);
    assert.equal(result.audit?.vulnerabilities.length, 2);

    const previous = [
      { id: "finding_old", path: "package-lock.json", display: finding!.display, description: "" },
    ] as unknown as StoredFinding[];
    const again = await checkDependencyChanges(
      root,
      baseSha,
      [{ filename: "package-lock.json", status: "modified" }],
      osv,
      previous,
      AbortSignal.timeout(5000),
    );
    assert.equal(again.findings[0]!.display!.previousFindingId, "finding_old", "同一个问题再次推送时记为之前提过");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("锁文件没改动或只删除依赖时不查询，也不出现告警", async () => {
  const { root, baseSha } = await repository({ lodash: "4.17.20", react: "18.2.0" }, { lodash: "4.17.20" });
  try {
    const osv = fakeOsv([record("lodash", "4.17.20", "high", ["4.17.21"])]);
    const untouched = await checkDependencyChanges(
      root,
      baseSha,
      [{ filename: "src/a.ts", status: "modified" }],
      osv,
      [],
      AbortSignal.timeout(5000),
    );
    assert.deepEqual(untouched, { findings: [], limitations: [] });
    const removedOnly = await checkDependencyChanges(
      root,
      baseSha,
      [{ filename: "package-lock.json", status: "modified" }],
      osv,
      [],
      AbortSignal.timeout(5000),
    );
    assert.deepEqual(removedOnly.findings, []);
    assert.equal(removedOnly.audit, undefined);
    assert.deepEqual(osv.calls, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("新加的锁文件里所有依赖都算新引入", async () => {
  const { root, baseSha } = await repository(null, { lodash: "4.17.20" });
  try {
    const osv = fakeOsv([record("lodash", "4.17.20", "critical", ["4.17.21"])]);
    const result = await checkDependencyChanges(
      root,
      baseSha,
      [{ filename: "package-lock.json", status: "added" }],
      osv,
      [],
      AbortSignal.timeout(5000),
    );
    assert.deepEqual(osv.calls, [["lodash@4.17.20"]]);
    assert.equal(result.findings[0]!.severity, "critical");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
