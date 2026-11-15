import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";

export function option(name, fallback) {
  return (
    process.argv
      .slice(2)
      .find((arg) => arg.startsWith(`--${name}=`))
      ?.slice(name.length + 3) ?? fallback
  );
}

export function positiveInteger(name, fallback) {
  const value = Number(option(name, fallback));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`--${name} 必须是正整数`);
  return value;
}

export async function loadCases(directory, requested = []) {
  const files = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  const cases = await Promise.all(
    files.map(async (name) => JSON.parse(await readFile(new URL(name, directory), "utf8"))),
  );
  for (const id of requested) if (!cases.some((sample) => sample.id === id)) throw new Error(`未知用例：${id}`);
  return cases.filter((sample) => requested.length === 0 || requested.includes(sample.id));
}

export function metadata(cases) {
  return {
    createdAt: new Date().toISOString(),
    sourceSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()),
    casesSha256: createHash("sha256").update(JSON.stringify(cases)).digest("hex"),
  };
}

export async function saveReport(path, report) {
  const output = resolve(path);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  return output;
}
