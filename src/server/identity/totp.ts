import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** 生成具有 160 位熵的 RFC 4648 Base32 密钥。 */
export function createTotpSecret(): string {
  let bits = "";
  for (const byte of randomBytes(20)) bits += byte.toString(2).padStart(8, "0");
  return bits.match(/.{5}/g)!.map((chunk) => BASE32[parseInt(chunk, 2)]).join("");
}

/** RFC 6238 动态截断；参数化位数与摘要算法用于标准测试向量。 */
export function totpAt(secret: string, timeMs: number, digits = 6, algorithm: "sha1" | "sha256" | "sha512" = "sha1"): string {
  if (!/^[A-Z2-7]+$/.test(secret) || !Number.isFinite(timeMs) || timeMs < 0) throw new Error("TOTP 计算参数无效");
  const bits = [...secret].map((letter) => BASE32.indexOf(letter).toString(2).padStart(5, "0")).join("");
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(timeMs / 30_000)));
  const digest = createHmac(algorithm, key).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % (10 ** digits)).padStart(digits, "0");
}

/** 允许前后一个时间步；返回成功的时间步供事务单次消费。 */
export function matchTotp(secret: string, code: string, timeMs: number, lastStep = -1): number | undefined {
  if (!/^\d{6}$/.test(code)) return undefined;
  const current = Math.floor(timeMs / 30_000);
  for (const step of [current, current - 1, current + 1]) {
    if (step < 0 || step <= lastStep) continue;
    if (timingSafeEqual(Buffer.from(code), Buffer.from(totpAt(secret, step * 30_000)))) return step;
  }
  return undefined;
}

/** 使用通用验证器识别的 URI，二维码只由本机生成。 */
export function totpUri(secret: string): string {
  return `otpauth://totp/BugPaw:owner?secret=${secret}&issuer=BugPaw&algorithm=SHA1&digits=6&period=30`;
}
