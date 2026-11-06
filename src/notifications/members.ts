export interface NotificationMember {
  githubLogin: string;
  wecomUserId: string;
}

export const githubLoginPattern = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;

export function parseNotificationMember(value: unknown): NotificationMember | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const member = value as Record<string, unknown>;
  if (
    Object.keys(member).some((key) => key !== "githubLogin" && key !== "wecomUserId") ||
    typeof member.githubLogin !== "string" ||
    typeof member.wecomUserId !== "string"
  )
    return undefined;
  const githubLogin = member.githubLogin.trim().toLowerCase();
  const wecomUserId = member.wecomUserId.trim();
  if (
    !githubLoginPattern.test(githubLogin) ||
    !/^[a-z\d_.@-]{1,64}$/i.test(wecomUserId) ||
    wecomUserId.toLowerCase() === "@all"
  )
    return undefined;
  return { githubLogin, wecomUserId };
}
