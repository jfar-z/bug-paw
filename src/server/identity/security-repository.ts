import type { Database } from "../database/database";
import { DomainError } from "../core/errors";

/** 私有身份状态；密钥字段只能存放认证加密后的内容。 */
export interface TotpState extends Record<string, unknown> {
  secret: string | null;
  last_step: number;
  generation: number;
  enabled_at: string | null;
}

/** 挑战令牌仅存摘要；绑定挑战同时受现有会话和代际约束。 */
export interface AuthChallenge extends Record<string, unknown> {
  token_hash: string;
  kind: "login" | "setup";
  session_hash: string | null;
  secret: string | null;
  generation: number;
  remember: number;
  expires_at: number;
}

/** 集中身份安全 SQL，消费验证码、挑战及轮换会话均使用同一事务。 */
export class SecurityRepository {
  constructor(private readonly database: Database) {}

  transaction<T>(operation: () => T): T { return this.database.transaction(operation); }

  state(): TotpState {
    return this.database.readOne<TotpState>("SELECT secret,last_step,generation,enabled_at FROM user_totp WHERE user_id='owner'")
      ?? { secret: null, last_step: -1, generation: 0, enabled_at: null };
  }

  save(state: TotpState): void {
    this.database.write(`INSERT INTO user_totp(user_id,secret,last_step,generation,enabled_at) VALUES ('owner',?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET secret=excluded.secret,last_step=excluded.last_step,generation=excluded.generation,enabled_at=excluded.enabled_at`,
    [state.secret, state.last_step, state.generation, state.enabled_at]);
  }

  /** 有界、持久化且跨客户端共享的预算，不随新建挑战或重启清零。 */
  attempt(bucket: "manage" | "factor" | "password", now: number): void {
    const allowed = this.transaction(() => {
      const row = this.database.readOne<{ attempts: number; reset_at: number }>("SELECT attempts,reset_at FROM auth_attempts WHERE bucket=?", [bucket]);
      const limit = bucket === "password" ? 20 : 5;
      if (row && row.reset_at > now && row.attempts >= limit) return false;
      this.database.write(`INSERT INTO auth_attempts(bucket,attempts,reset_at) VALUES (?,1,?)
        ON CONFLICT(bucket) DO UPDATE SET attempts=?,reset_at=?`,
      [bucket, now + 60_000, row && row.reset_at > now ? row.attempts + 1 : 1, row && row.reset_at > now ? row.reset_at : now + 60_000]);
      return true;
    });
    if (!allowed) throw new DomainError("TOTP_RATE_LIMITED", "身份验证尝试过于频繁，请等待一分钟后重试");
  }

  putChallenge(challenge: AuthChallenge, now: number): void {
    this.database.write("DELETE FROM auth_challenges WHERE expires_at<=?", [now]);
    if (challenge.kind === "setup") this.database.write("DELETE FROM auth_challenges WHERE kind='setup' AND session_hash=?", [challenge.session_hash]);
    this.database.write(`INSERT INTO auth_challenges(token_hash,user_id,kind,session_hash,secret,generation,remember,expires_at)
      VALUES (?,'owner',?,?,?,?,?,?)`, [challenge.token_hash,challenge.kind,challenge.session_hash,challenge.secret,challenge.generation,challenge.remember,challenge.expires_at]);
    this.database.write("DELETE FROM auth_challenges WHERE token_hash IN (SELECT token_hash FROM auth_challenges ORDER BY expires_at DESC LIMIT -1 OFFSET 32)");
  }

  challenge(hash: string, kind: "login" | "setup", now: number): AuthChallenge {
    const row = this.database.readOne<AuthChallenge>(`SELECT * FROM auth_challenges WHERE ${kind === "setup" ? "session_hash" : "token_hash"}=? AND kind=? AND expires_at>?`, [hash,kind,now]);
    if (!row || row.generation !== this.state().generation) throw new DomainError("TOTP_CHALLENGE_EXPIRED", "身份验证已过期，请重新开始绑定或登录");
    return row;
  }

  clearChallenges(): void { this.database.write("DELETE FROM auth_challenges"); }
  cancelSetup(hash: string): void { this.database.write("DELETE FROM auth_challenges WHERE kind='setup' AND session_hash=?", [hash]); }
  consumeChallenge(hash: string): void { this.database.write("DELETE FROM auth_challenges WHERE token_hash=?", [hash]); }

  replaceRecovery(hashes: string[]): void {
    this.database.write("DELETE FROM totp_recovery_codes WHERE user_id='owner'");
    for (const hash of hashes) this.database.write("INSERT INTO totp_recovery_codes(user_id,code_hash) VALUES ('owner',?)", [hash]);
  }
  consumeRecovery(hash: string): boolean {
    return this.database.write("DELETE FROM totp_recovery_codes WHERE user_id='owner' AND code_hash=?", [hash]).changes === 1;
  }
  recoveryCount(): number { return this.database.readOne<{ count: number }>("SELECT count(*) AS count FROM totp_recovery_codes WHERE user_id='owner'")!.count; }

  requireSession(hash: string, now: number): { remember: number; expires_at: string } {
    const row = this.database.readOne<{ remember: number; expires_at: string }>("SELECT remember,expires_at FROM web_sessions WHERE token_hash=? AND user_id='owner' AND expires_at>?", [hash,new Date(now).toISOString()]);
    if (!row) throw new DomainError("AUTH_REQUIRED", "当前登录已失效，请重新登录");
    return row;
  }
  issueSession(hash: string, remember: boolean, now: number, expires = new Date(now + 7 * 24 * 60 * 60_000).toISOString()): void {
    this.database.write("DELETE FROM web_sessions WHERE expires_at<=?", [new Date(now).toISOString()]);
    this.database.write("INSERT INTO web_sessions(token_hash,user_id,expires_at,created_at,remember) VALUES (?,'owner',?,?,?)", [hash,expires,new Date(now).toISOString(),Number(remember)]);
  }
  rotateSession(oldHash: string, newHash: string, now: number): boolean {
    const old = this.requireSession(oldHash,now);
    this.database.write("DELETE FROM web_sessions WHERE user_id='owner'");
    this.clearChallenges();
    this.issueSession(newHash, Boolean(old.remember), now, old.expires_at);
    return Boolean(old.remember);
  }
}
