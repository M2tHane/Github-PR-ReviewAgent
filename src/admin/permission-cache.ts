import type { GitHubClient } from "../github/client.js";
import type { Session } from "./dto.js";

type Entry = { result: Promise<boolean>; expiresAt: number; session: string };

// 每个管理服务实例共用；同时到来的列表和详情请求也复用同一次 GitHub 查询。
export class MaintainerPermissionCache {
  private readonly entries = new Map<string, Map<string, Entry>>();
  private nextSweep = 0;

  constructor(
    private readonly github: Pick<GitHubClient, "hasMaintainerPermission">,
    private readonly now = Date.now,
  ) {}

  check(user: Session, repository: string): Promise<boolean> {
    const now = this.now();
    if (now >= this.nextSweep) {
      for (const [login, entries] of this.entries) {
        for (const [name, entry] of entries) if (entry.expiresAt <= now) entries.delete(name);
        if (!entries.size) this.entries.delete(login);
      }
      this.nextSweep = now + 60_000;
    }
    const login = user.login.toLowerCase(),
      name = repository.toLowerCase();
    let entries = this.entries.get(login);
    if (!entries) {
      entries = new Map();
      this.entries.set(login, entries);
    }
    const cached = entries.get(name);
    if (cached && cached.session === user.csrf && cached.expiresAt > now) return cached.result;
    // 新登录会话不复用旧会话缓存；即使退出和重新登录落在不同 edge，也会重新查权限。
    const entry: Entry = {
      session: user.csrf,
      expiresAt: Infinity,
      result: this.github.hasMaintainerPermission(user.token, repository).then(
        (allowed) => {
          entry.expiresAt = this.now() + (allowed ? 5 * 60_000 : 60_000);
          return allowed;
        },
        (error) => {
          if (entries.get(name) === entry) entries.delete(name);
          throw error;
        },
      ),
    };
    entries.set(name, entry);
    return entry.result;
  }

  clear(user: Session) {
    this.entries.delete(user.login.toLowerCase());
  }
}
