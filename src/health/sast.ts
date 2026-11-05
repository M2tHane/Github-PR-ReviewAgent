import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { scopedPaths } from "./health.service.js";
import type { HealthMissingData, HealthScope, SastRecord, SastScan } from "./types.js";

const exec = promisify(execFile);
export const SAST_LIMITS = { files: 3000, fileBytes: 1_000_000, records: 200, timeoutMs: 90_000 };
export const SEMGREP_RULES = fileURLToPath(new URL("../../../rules/semgrep/", import.meta.url));
const TARGETS = /\.(?:[cm]?[jt]sx?|py|java|go)$/;
const SEVERITY: Record<string, SastRecord["severity"]> = { ERROR: "high", WARNING: "medium", INFO: "low" };

// 只用本服务自带的本地规则；不读仓库里的 Semgrep 配置、不联网、不上报统计。
export async function runSemgrep(root: string, scope: HealthScope, semgrepPath: string, signal: AbortSignal) {
  const missingData: HealthMissingData[] = [];
  const missing = (reason: string, detail: string) => missingData.push({ source: "sast", reason, detail });
  const targets = (await scopedPaths(root, scope, signal)).filter((path) => TARGETS.test(path));
  if (targets.length > SAST_LIMITS.files)
    missing("file_limit", `共 ${targets.length} 个源码文件，只扫描前 ${SAST_LIMITS.files} 个。`);
  const scan: SastScan = { status: "complete", scannedFiles: 0, records: [] };
  if (!targets.length) return { scan, missingData };
  const home = await mkdtemp(join(tmpdir(), "pi-semgrep-"));
  let stdout: string;
  try {
    stdout = (
      await exec(
        semgrepPath,
        [
          "scan",
          "--config",
          SEMGREP_RULES,
          "--json",
          "--metrics=off",
          "--disable-version-check",
          "--quiet",
          "--timeout",
          "10",
          "--max-target-bytes",
          String(SAST_LIMITS.fileBytes),
          "--jobs",
          "2",
          // 文件名来自待审仓库，用 -- 隔开，避免被当成命令行选项。
          "--",
          ...targets.slice(0, SAST_LIMITS.files),
        ],
        {
          cwd: root,
          signal,
          timeout: SAST_LIMITS.timeoutMs,
          maxBuffer: 32 * 1024 * 1024,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            SEMGREP_SEND_METRICS: "off",
            SEMGREP_ENABLE_VERSION_CHECK: "0",
          },
        },
      )
    ).stdout;
  } catch (error: any) {
    signal.throwIfAborted();
    if (error?.code === "ENOENT") {
      missing("not_installed", "服务器没有安装 Semgrep（SEMGREP_PATH），没有做代码规则扫描。");
      return { scan: { ...scan, status: "incomplete" as const }, missingData };
    }
    // Semgrep 有问题时也可能已经输出完整 JSON；没有就当这次没扫成。
    stdout = typeof error?.stdout === "string" ? error.stdout : "";
  } finally {
    await rm(home, { recursive: true, force: true });
  }
  let output: any;
  try {
    output = JSON.parse(stdout);
  } catch {
    missing("scan_failed", "Semgrep 没有正常完成，没有做代码规则扫描。");
    return { scan: { ...scan, status: "incomplete" as const }, missingData };
  }
  const errors = (Array.isArray(output?.errors) ? output.errors : []).filter((item: any) => item?.level === "error");
  if (errors.length) missing("parse_errors", `Semgrep 有 ${errors.length} 处文件或规则没能解析，相关内容没有扫描。`);
  const records = new Map<string, SastRecord>();
  for (const result of Array.isArray(output?.results) ? output.results : []) {
    const path = String(result?.path ?? "").replace(/^\.\//, "");
    const line = Number(result?.start?.line);
    const rule = String(result?.check_id ?? "")
      .split(".")
      .at(-1)!;
    if (!targets.includes(path) || !Number.isSafeInteger(line) || line < 1 || !rule) continue;
    const id = "sast_" + createHash("sha256").update(`${path}:${line}:${rule}`).digest("hex").slice(0, 16);
    records.set(id, {
      id,
      rule,
      label: String(result.extra?.metadata?.label ?? rule).slice(0, 40),
      severity: SEVERITY[String(result.extra?.severity)] ?? "low",
      path,
      line,
      message: String(result.extra?.message ?? "").slice(0, 300),
    });
  }
  const order = ["high", "medium", "low"];
  const sorted = [...records.values()].sort(
    (a, b) => order.indexOf(a.severity) - order.indexOf(b.severity) || a.path.localeCompare(b.path) || a.line - b.line,
  );
  if (sorted.length > SAST_LIMITS.records)
    missing("record_limit", `规则命中 ${sorted.length} 处，报告只保留前 ${SAST_LIMITS.records} 处。`);
  const scanned = Array.isArray(output?.paths?.scanned) ? output.paths.scanned.length : 0;
  return {
    scan: {
      status: missingData.length ? ("incomplete" as const) : ("complete" as const),
      scannedFiles: scanned,
      records: sorted.slice(0, SAST_LIMITS.records),
    },
    missingData,
  };
}
