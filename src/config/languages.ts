import { extname } from "node:path";

// 变更语言识别与规则 Scope 的 languages 共用这一份映射。
const byExtension: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".java": "java", ".kt": "kotlin", ".kts": "kotlin", ".scala": "scala",
  ".py": "python", ".go": "go", ".rs": "rust", ".rb": "ruby", ".php": "php",
  ".cs": "csharp", ".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp",
  ".swift": "swift", ".dart": "dart", ".vue": "vue", ".sql": "sql", ".sh": "shell", ".bash": "shell",
};

const aliases: Record<string, string> = {
  ts: "typescript", js: "javascript", py: "python", golang: "go", kt: "kotlin",
  "c#": "csharp", "c++": "cpp", bash: "shell", sh: "shell",
};

export function languageOf(path: string): string | undefined {
  return byExtension[extname(path).toLowerCase()];
}

export function normalizeLanguage(name: string): string {
  const lower = name.trim().toLowerCase();
  return aliases[lower] ?? lower;
}
