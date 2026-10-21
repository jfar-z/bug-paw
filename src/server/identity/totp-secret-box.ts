import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { DomainError } from "../core/errors";

/** 用独立的本地 0600 密钥加密身份数据库中的 TOTP 密钥，缺失时拒绝降级。 */
export class TotpSecretBox {
  constructor(private readonly keyFile: string) {}

  /** 首次绑定才创建加密密钥，不能因解密失败覆盖已有密钥。 */
  encrypt(secret: string): string {
    try {
      let key: Buffer;
      try { key = readFileSync(this.keyFile); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        try { writeFileSync(this.keyFile, randomBytes(32), { flag: "wx", mode: 0o600 }); }
        catch (creationError) {
          // 多个连接同时首次绑定时只允许使用已原子创建的同一密钥。
          if ((creationError as NodeJS.ErrnoException).code !== "EEXIST") throw creationError;
        }
        key = readFileSync(this.keyFile);
      }
      if (key.length !== 32) throw new Error("加密密钥长度错误");
      chmodSync(this.keyFile, 0o600);
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const content = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
      return [iv, cipher.getAuthTag(), content].map((part) => part.toString("base64url")).join(".");
    } catch {
      throw new DomainError("SECURITY_STORAGE_FAILED", "加密双因素绑定密钥失败，请检查身份加密文件的权限与完整性");
    }
  }

  /** 解密只读取现有密钥；文件丢失必须恢复原文件，不能生成替代密钥。 */
  decrypt(value: string): string {
    try {
      const [iv, tag, content] = value.split(".").map((part) => Buffer.from(part, "base64url"));
      const cipher = createDecipheriv("aes-256-gcm", readFileSync(this.keyFile), iv);
      cipher.setAuthTag(tag);
      return Buffer.concat([cipher.update(content), cipher.final()]).toString("utf8");
    } catch {
      throw new DomainError("SECURITY_STORAGE_FAILED", "读取双因素绑定密钥失败，请恢复匹配的身份加密文件与数据库");
    }
  }
}
