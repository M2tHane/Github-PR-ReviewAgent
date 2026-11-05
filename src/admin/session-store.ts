import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import type { Pool } from "pg";

// 管理页登录会话和 OAuth state 的存储。生产用数据库版，多个实例共用；内存版只给单元测试用。
export interface SessionStore<T> {
  get(key: string): Promise<T | undefined>;
  set(key: string, value: T): Promise<boolean>;
  delete(key: string): Promise<void>;
}

export class ExpiringStore<T> {
  private values = new Map<string, { value: T; expiresAt: number; timer: ReturnType<typeof setTimeout> }>();
  constructor(
    private ttlMs: number,
    private capacity: number,
  ) {}
  get size() {
    return this.values.size;
  }
  get(key: string): T | undefined {
    const entry = this.values.get(key);
    if (entry && entry.expiresAt <= Date.now()) {
      this.delete(key);
      return undefined;
    }
    return entry?.value;
  }
  set(key: string, value: T): boolean {
    if (!this.values.has(key) && this.values.size >= this.capacity) return false;
    this.delete(key);
    const timer = setTimeout(() => this.delete(key), this.ttlMs);
    timer.unref();
    this.values.set(key, { value, expiresAt: Date.now() + this.ttlMs, timer });
    return true;
  }
  delete(key: string) {
    const entry = this.values.get(key);
    if (entry) clearTimeout(entry.timer);
    this.values.delete(key);
  }
}

export function memoryStore<T>(ttlMs: number, capacity: number): SessionStore<T> {
  const store = new ExpiringStore<T>(ttlMs, capacity);
  return {
    get: async (key) => store.get(key),
    set: async (key, value) => store.set(key, value),
    delete: async (key) => store.delete(key),
  };
}

// 数据库版：key 只存 SHA-256，value 用由 SESSION_SECRET 派生的密钥做 AES-256-GCM 加密。
// 数据库泄露时既拿不到能用的会话 ID，也拿不到维护者的 GitHub token。
export class DatabaseSessionStore<T> implements SessionStore<T> {
  private readonly key: Buffer;
  constructor(
    private pool: Pool,
    private kind: "session" | "oauth_state",
    private ttlMs: number,
    private capacity: number,
    secret: string,
  ) {
    this.key = Buffer.from(hkdfSync("sha256", secret, "pi-review-admin", kind, 32));
  }

  private id(key: string) {
    return createHash("sha256").update(key).digest("hex");
  }

  async get(key: string) {
    const row = (
      await this.pool.query("SELECT value FROM admin_sessions WHERE id=$1 AND kind=$2 AND expires_at>now()", [
        this.id(key),
        this.kind,
      ])
    ).rows[0];
    if (!row) return undefined;
    try {
      const [iv, tag, data] = String(row.value)
        .split(".")
        .map((part) => Buffer.from(part, "base64url"));
      const decipher = createDecipheriv("aes-256-gcm", this.key, iv!);
      decipher.setAuthTag(tag!);
      return JSON.parse(Buffer.concat([decipher.update(data!), decipher.final()]).toString("utf8")) as T;
    } catch {
      // SESSION_SECRET 换过，旧会话解不开，当作已过期。
      return undefined;
    }
  }

  async set(key: string, value: T) {
    await this.pool.query("DELETE FROM admin_sessions WHERE kind=$1 AND expires_at<=now()", [this.kind]);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    const sealed = [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64url")).join(".");
    // 数量上限和写入放在同一条语句里，多个实例同时登录也不会超出太多。
    const inserted = await this.pool.query(
      `INSERT INTO admin_sessions(id,kind,value,expires_at)
       SELECT $1,$2,$3,now()+make_interval(secs=>$4)
       WHERE (SELECT count(*) FROM admin_sessions WHERE kind=$2 AND expires_at>now())<$5
       ON CONFLICT(id) DO UPDATE SET value=EXCLUDED.value,expires_at=EXCLUDED.expires_at`,
      [this.id(key), this.kind, sealed, this.ttlMs / 1000, this.capacity],
    );
    return Boolean(inserted.rowCount);
  }

  async delete(key: string) {
    await this.pool.query("DELETE FROM admin_sessions WHERE id=$1 AND kind=$2", [this.id(key), this.kind]);
  }
}
