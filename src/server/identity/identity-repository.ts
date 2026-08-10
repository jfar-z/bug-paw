import type { PasswordRecord } from "../auth";
import { DomainError } from "../core/errors";
import type { Database } from "../database/database";

export interface IdentityUser {
  id: string;
  password: PasswordRecord;
  displayName: string;
  avatar?: { path: string; mediaType: "image/png" | "image/jpeg" | "image/webp" };
  revision: string;
  createdAt: string;
  updatedAt: string;
}

export interface WebSessionRecord {
  tokenHash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

export interface IdentityRepository {
  initializeUser(input: { id: string; password: PasswordRecord; displayName: string; now: string }): Promise<IdentityUser>;
  getUser(id: string): Promise<IdentityUser | undefined>;
  updateProfile(
    id: string,
    expectedRevision: string,
    patch: {
      displayName?: string;
      avatar?: IdentityUser["avatar"] | null;
      now: string;
    },
  ): Promise<IdentityUser>;
  createWebSession(session: WebSessionRecord): Promise<void>;
  findWebSession(tokenHash: string, now: string): Promise<WebSessionRecord | undefined>;
  deleteWebSession(tokenHash: string): Promise<void>;
  deleteExpiredWebSessions(now: string): Promise<number>;
}

/** 创建只管理身份和浏览器会话摘要的 Repository。 */
export function createIdentityRepository(database: Database): IdentityRepository {
  return {
    async initializeUser(input) {
      return database.transaction(() => {
        const existing = database.readOne<{ count: number }>("SELECT COUNT(*) AS count FROM users");
        if ((existing?.count ?? 0) > 0) {
          throw new DomainError("VERSION_CONFLICT", "应用已经完成初始化");
        }
        database.write(`
          INSERT INTO users(
            id, password_algorithm, password_salt, password_hash,
            display_name, revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
        `, [
          input.id,
          input.password.algorithm,
          input.password.salt,
          input.password.hash,
          input.displayName,
          input.now,
          input.now,
        ]);
        return {
          id: input.id,
          password: input.password,
          displayName: input.displayName,
          revision: "1",
          createdAt: input.now,
          updatedAt: input.now,
        };
      });
    },
    async getUser(id) {
      const row = database.readOne<UserRow>("SELECT * FROM users WHERE id = ?", [id]);
      return row ? toUser(row) : undefined;
    },
    async updateProfile(id, expectedRevision, patch) {
      const revision = parseRevision(expectedRevision);
      const current = database.readOne<UserRow>("SELECT * FROM users WHERE id = ?", [id]);
      if (!current) throw new DomainError("NOT_FOUND", "个人资料不存在");
      const avatar = patch.avatar === undefined
        ? current.avatar_path && current.avatar_media_type
          ? { path: current.avatar_path, mediaType: current.avatar_media_type }
          : undefined
        : patch.avatar ?? undefined;
      const result = database.write(`
        UPDATE users
        SET display_name = ?, avatar_path = ?, avatar_media_type = ?,
            revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ?
      `, [
        patch.displayName ?? current.display_name,
        avatar?.path ?? null,
        avatar?.mediaType ?? null,
        patch.now,
        id,
        revision,
      ]);
      if (result.changes !== 1) throw new DomainError("VERSION_CONFLICT", "个人资料已被其他请求修改");
      return toUser(database.readOne<UserRow>("SELECT * FROM users WHERE id = ?", [id])!);
    },
    async createWebSession(session) {
      database.write(`
        INSERT INTO web_sessions(token_hash, user_id, expires_at, created_at)
        VALUES (?, ?, ?, ?)
      `, [session.tokenHash, session.userId, session.expiresAt, session.createdAt]);
    },
    async findWebSession(tokenHash, now) {
      const row = database.readOne<WebSessionRow>(`
        SELECT token_hash, user_id, expires_at, created_at
        FROM web_sessions
        WHERE token_hash = ? AND expires_at > ?
      `, [tokenHash, now]);
      return row ? toWebSession(row) : undefined;
    },
    async deleteWebSession(tokenHash) {
      database.write("DELETE FROM web_sessions WHERE token_hash = ?", [tokenHash]);
    },
    async deleteExpiredWebSessions(now) {
      return database.write("DELETE FROM web_sessions WHERE expires_at <= ?", [now]).changes;
    },
  };
}

interface UserRow extends Record<string, unknown> {
  id: string;
  password_algorithm: "scrypt";
  password_salt: string;
  password_hash: string;
  display_name: string;
  avatar_path: string | null;
  avatar_media_type: "image/png" | "image/jpeg" | "image/webp" | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface WebSessionRow extends Record<string, unknown> {
  token_hash: string;
  user_id: string;
  expires_at: string;
  created_at: string;
}

function toUser(row: UserRow): IdentityUser {
  return {
    id: row.id,
    password: { algorithm: row.password_algorithm, salt: row.password_salt, hash: row.password_hash },
    displayName: row.display_name,
    ...(row.avatar_path && row.avatar_media_type ? { avatar: { path: row.avatar_path, mediaType: row.avatar_media_type } } : {}),
    revision: String(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseRevision(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new DomainError("VALIDATION_FAILED", "个人资料 Revision 无效");
  return Number(value);
}

function toWebSession(row: WebSessionRow): WebSessionRecord {
  return {
    tokenHash: row.token_hash,
    userId: row.user_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}
