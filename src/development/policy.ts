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
// 字数上限与 commit-pr Skill 里写的一致；超了在同一会话里让模型压缩一次。
export const WRITING_LIMITS = { prBody: 1000, issueBody: 800, issueReply: 500 };

export type DevelopmentResult =
  | { kind: "pr"; title: string; summary: string }
  | { kind: "issue"; title: string; body: string };

// 改动由服务从工作区收集，模型只交 PR 标题和说明；需求要先问清楚时交 issue；refusal 非空时拒绝整个任务。
export function parseDevelopmentResult(value: unknown): DevelopmentResult {
  const v = strictObject(value, ["title", "summary", "refusal", "issue"], "开发结果");
  if (typeof v.refusal === "string" && v.refusal.trim())
    throw new DevelopmentError(requiredText(v.refusal, "拒绝原因", 1500), "refused");
  if (v.issue !== undefined && v.issue !== null) {
    const issue = strictObject(v.issue, ["title", "body"], "issue");
    return {
      kind: "issue",
      title: requiredText(issue.title, "issue 标题", 120),
      body: requiredText(issue.body, "issue 正文", 4000),
    };
  }
  return {
    kind: "pr",
    title: requiredText(v.title, "PR 标题", 150),
    summary: requiredText(v.summary, "修改说明", 4000),
  };
}

// 超过字数上限时返回给模型的压缩要求；没超返回 undefined。
export function lengthFeedback(result: DevelopmentResult) {
  const [label, text, max] =
    result.kind === "pr"
      ? ["PR 正文", result.summary, WRITING_LIMITS.prBody]
      : ["issue 正文", result.body, WRITING_LIMITS.issueBody];
  if (text.length <= max) return undefined;
  return `${label}有 ${text.length} 字，超过 ${max} 字的上限。按 commit-pr Skill 的写法压缩：只留读的人需要知道的，用大白话短句；不要改代码，重新输出完整的 JSON。`;
}

// issue 里的“开始”指令：整条回复只有这一句（可带标点），避免讨论里顺口提到“开始”就开工。
export function isStartCommand(body: string) {
  return /^\s*(开始|开始开发|开工|\/start)\s*[。.!！]?\s*$/i.test(body);
}
