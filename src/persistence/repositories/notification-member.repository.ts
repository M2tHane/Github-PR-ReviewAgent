import type { Pool } from "pg";
import type { NotificationMember } from "../../notifications/members.js";

export class NotificationMemberRepository {
  constructor(private readonly pool: Pool) {}

  async list(repositoryId: number): Promise<NotificationMember[]> {
    const result = await this.pool.query(
      `SELECT github_login AS "githubLogin",wecom_userid AS "wecomUserId"
       FROM repository_notification_members WHERE repository_id=$1 ORDER BY github_login`,
      [repositoryId],
    );
    return result.rows;
  }

  async save(repositoryId: number, member: NotificationMember) {
    await this.pool.query(
      `INSERT INTO repository_notification_members(repository_id,github_login,wecom_userid) VALUES($1,$2,$3)
       ON CONFLICT(repository_id,github_login) DO UPDATE SET wecom_userid=$3,updated_at=now()`,
      [repositoryId, member.githubLogin, member.wecomUserId],
    );
  }

  async remove(repositoryId: number, githubLogin: string) {
    await this.pool.query("DELETE FROM repository_notification_members WHERE repository_id=$1 AND github_login=$2", [
      repositoryId,
      githubLogin,
    ]);
  }
}
