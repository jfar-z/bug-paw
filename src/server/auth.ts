import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const PASSWORD_HASH_BYTES = 64;
const SCRYPT_OPTIONS = {
  N: 16_384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
};

export interface PasswordRecord {
  algorithm: "scrypt";
  salt: string;
  hash: string;
}

/**
 * 使用独立随机盐生成管理员密码记录。
 */
export async function hashPassword(password: string): Promise<PasswordRecord> {
  const salt = randomBytes(16);
  const hash = await derivePassword(password, salt);
  return {
    algorithm: "scrypt",
    salt: salt.toString("base64url"),
    hash: hash.toString("base64url"),
  };
}

/**
 * 以恒定时间比较派生结果，避免直接比较密码或哈希字符串。
 */
export async function verifyPassword(password: string, record: PasswordRecord): Promise<boolean> {
  if (record.algorithm !== "scrypt") {
    return false;
  }

  try {
    const expected = Buffer.from(record.hash, "base64url");
    const actual = await derivePassword(password, Buffer.from(record.salt, "base64url"));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/**
 * 创建只返回给浏览器一次的高熵会话令牌。
 */
export function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * 将会话令牌转换为可安全持久化的单向摘要。
 */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, PASSWORD_HASH_BYTES, SCRYPT_OPTIONS, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });
}
