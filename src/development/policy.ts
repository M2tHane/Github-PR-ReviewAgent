import { requiredText, strictObject } from "../shared/model-json.js";
import { DevelopmentError, type DevelopmentSettings, type Protection } from "./types.js";

export function safePath(value: unknown): string {
  const path = requiredText(value, "文件路径", 500);
  if (
    path !== value ||
    /\p{Cc}/u.test(path) ||
    /[\\:*?[\]]/.test(path) ||
    path.startsWith("/") ||
    path.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")
  )
    throw new DevelopmentError("文件路径无效或指向 Git 内部目录");
  return path;
}
export function validBranch(value: unknown): string {
  const branch = requiredText(value, "目标分支", 200);
  if (
    branch !== value ||
    /\p{Cc}/u.test(branch) ||
    branch === "@" ||
    /[\s~^:?*[\\]/.test(branch) ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.endsWith(".") ||
    branch.startsWith("-") ||
    branch.split("/").some((p) => !p || p.startsWith(".") || p.endsWith(".lock"))
  )
    throw new DevelopmentError("目标分支名称无效");
  return branch;
}
export function parseSettings(input: unknown): DevelopmentSettings {
  const v = strictObject(input, ["chatId", "targetBranch", "enabled", "members", "protections", "version"], "开发设置");
  const chatId = requiredText(v.chatId, "群 ID", 200);
  if (
    !/^[a-z\d_-]+$/i.test(chatId) ||
    typeof v.enabled !== "boolean" ||
    !Number.isSafeInteger(v.version) ||
    v.version < 0
  )
    throw new DevelopmentError("群 ID、启用状态或设置版本无效");
  if (
    !Array.isArray(v.members) ||
    v.members.length > 200 ||
    !Array.isArray(v.protections) ||
    v.protections.length > 100
  )
    throw new DevelopmentError("成员或保护规则数量无效");
  const members = v.members.map((input: unknown) => {
    const member = strictObject(input, ["userid", "role"], "开发成员");
    if (
      typeof member.userid !== "string" ||
      !/^[a-z\d_.@-]{1,64}$/i.test(member.userid) ||
      member.userid.toLowerCase() === "@all" ||
      !["admin", "developer"].includes(member.role)
    )
      throw new DevelopmentError("成员 ID 或身份无效");
    return { userid: member.userid, role: member.role as "admin" | "developer" };
  });
  if (new Set(members.map((m) => m.userid)).size !== members.length) throw new DevelopmentError("成员 ID 重复");
  if (!members.some((m) => m.role === "admin")) throw new DevelopmentError("请至少设置一名管理员");
  const protections = v.protections.map((input: unknown): Protection => {
    const rule = strictObject(input, ["name", "paths", "reason"], "保护规则");
    if (!Array.isArray(rule.paths) || !rule.paths.length || rule.paths.length > 100)
      throw new DevelopmentError("保护范围不能为空");
    return {
      name: requiredText(rule.name, "规则名称", 100),
      reason: requiredText(rule.reason, "规则说明", 1000),
      paths: rule.paths.map((p: unknown) => {
        if (typeof p !== "string") throw new DevelopmentError("保护范围无效");
        if (p === "**") return p;
        if (p.endsWith("/**")) return `${safePath(p.slice(0, -3))}/**`;
        if (p.endsWith("/")) return `${safePath(p.slice(0, -1))}/**`;
        return safePath(p);
      }),
    };
  });
  return {
    chatId,
    targetBranch: validBranch(v.targetBranch),
    enabled: v.enabled,
    members,
    protections,
    version: v.version,
  };
}
export function enforceProtections(paths: string[], role: string, protections: Protection[]) {
  if (role === "admin") return;
  for (const path of paths)
    for (const rule of protections) {
      if (
        rule.paths.some(
          (p) =>
            p === "**" ||
            p === path ||
            (p.endsWith("/**") && (path === p.slice(0, -3) || path.startsWith(p.slice(0, -2)))),
        )
      )
        throw new DevelopmentError(
          `已拒绝整个任务：${path} 命中保护规则「${rule.name}」。${rule.reason}。仅管理员可发起这类修改。`,
          "refused",
        );
    }
}
// 改动由服务从工作区收集，模型只交 PR 标题和说明；refusal 非空时拒绝整个任务。
export function parseDevelopmentResult(value: unknown): { title: string; summary: string } {
  const v = strictObject(value, ["title", "summary", "refusal"], "开发结果");
  if (typeof v.refusal === "string" && v.refusal.trim())
    throw new DevelopmentError(requiredText(v.refusal, "拒绝原因", 1500), "refused");
  return { title: requiredText(v.title, "PR 标题", 150), summary: requiredText(v.summary, "修改说明", 4000) };
}
