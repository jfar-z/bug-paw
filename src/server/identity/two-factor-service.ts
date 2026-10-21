import { randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { createSessionToken, hashSessionToken, verifyPassword } from "../auth";
import { DomainError } from "../core/errors";
import type { IdentityRepository } from "./identity-repository";
import { createTotpSecret, matchTotp, totpUri } from "./totp";
import { TotpSecretBox } from "./totp-secret-box";
import type { SecurityProof, SecurityStatus, TotpSetup } from "../../shared/security-contracts";

const CHALLENGE_MS = 5 * 60_000;

/** 管理身份验证的应用服务，明文仅在绑定和恢复码生成的响应中短暂存在。 */
export function createTwoFactorService(repository: IdentityRepository, keyFile: string, now: () => Date) {
  const store = repository.security;
  const box = new TotpSecretBox(keyFile);
  const time = () => now().getTime();
  const sessionHash = (token: string | undefined) => {
    if (!token) throw new DomainError("AUTH_REQUIRED", "请先登录再管理双因素认证");
    return hashSessionToken(token);
  };

  /** 不把 SQLite、加密数据或文件路径带入错误日志和浏览器响应。 */
  function transact<T>(operation: string, work: () => T): T {
    try { return store.transaction(work); }
    catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError("SECURITY_STORAGE_FAILED", `${operation}时身份数据库事务未完成，请检查数据目录权限和磁盘空间`);
    }
  }

  async function requirePassword(token: string | undefined, password: string): Promise<string> {
    const hash = sessionHash(token);
    store.requireSession(hash, time());
    store.attempt("manage", time());
    const user = await repository.getUser("owner");
    if (!user || !(await verifyPassword(password, user.password))) throw new DomainError("INVALID_CREDENTIALS", "访问密码错误");
    return hash;
  }

  /** 调用方必须持有事务，保证已用时间步和恢复码只能消费一次。 */
  function consumeFactor(code: string, recovery: boolean, currentTime: number): void {
    const state = store.state();
    if (!state.secret) throw new DomainError("TOTP_STATE_CONFLICT", "双因素认证状态已变化，请重新加载安全设置或重新登录");
    if (recovery) {
      const normalized = code.replace(/[\s-]/g, "").toUpperCase();
      if (!/^[A-F0-9]{32}$/.test(normalized) || !store.consumeRecovery(hashSessionToken(normalized))) {
        throw new DomainError("TOTP_INVALID_CODE", "恢复码无效或已使用，请使用其他未使用的恢复码");
      }
      return;
    }
    const step = matchTotp(box.decrypt(state.secret), code, currentTime, state.last_step);
    if (step === undefined) throw new DomainError("TOTP_INVALID_CODE", "验证码无效、已使用或已过期，请等待验证器更新后重试，并检查设备时间");
    store.save({ ...state, last_step: step });
  }

  function newRecoveryCodes(): string[] {
    const codes = Array.from({ length: 8 }, () => randomBytes(16).toString("hex").toUpperCase());
    store.replaceRecovery(codes.map(hashSessionToken));
    return codes.map((code) => code.match(/.{4}/g)!.join("-"));
  }

  return {
    /** 密码正确也只能签发挑战，绝不能先建立可访问业务接口的会话。 */
    passwordLogin(remember: boolean): { status: "authenticated"; token: string } | { status: "second_factor_required"; challenge: string; expiresAt: string } {
      return transact("创建登录凭据", () => {
        const currentTime = time();
        const state = store.state();
        const token = createSessionToken();
        if (state.secret) {
          const expires = currentTime + CHALLENGE_MS;
          store.putChallenge({ token_hash: hashSessionToken(token), kind: "login", session_hash: null, secret: null, generation: state.generation, remember: Number(remember), expires_at: expires }, currentTime);
          return { status: "second_factor_required", challenge: token, expiresAt: new Date(expires).toISOString() };
        }
        store.issueSession(hashSessionToken(token), remember, currentTime);
        return { status: "authenticated", token };
      });
    },

    completeLogin(challengeToken: string | undefined, code: string, recovery: boolean) {
      store.attempt("factor", time());
      return transact("完成第二因素登录", () => {
        const currentTime = time();
        const challenge = store.challenge(hashSessionToken(challengeToken ?? ""), "login", currentTime);
        consumeFactor(code, recovery, currentTime);
        const token = createSessionToken();
        store.consumeChallenge(challenge.token_hash);
        store.issueSession(hashSessionToken(token), Boolean(challenge.remember), currentTime);
        return { token, remember: Boolean(challenge.remember) };
      });
    },

    status(token: string | undefined): SecurityStatus {
      return transact("读取双因素认证状态", () => {
        store.requireSession(sessionHash(token), time());
        const state = store.state();
        return { enabled: Boolean(state.secret), enabledAt: state.enabled_at, recoveryCodesRemaining: store.recoveryCount() };
      });
    },

    async beginSetup(token: string | undefined, password: string): Promise<TotpSetup> {
      const hash = await requirePassword(token, password);
      const secret = createTotpSecret();
      let qrCode: string;
      try { qrCode = await QRCode.toDataURL(totpUri(secret), { width: 240, margin: 4, errorCorrectionLevel: "M" }); }
      catch { throw new DomainError("SECURITY_STORAGE_FAILED", "生成双因素绑定二维码失败，绑定尚未创建，请重新尝试"); }
      return transact("创建双因素绑定", () => {
        const currentTime = time();
        store.requireSession(hash, currentTime);
        const state = store.state();
        if (state.secret) throw new DomainError("TOTP_STATE_CONFLICT", "双因素认证已经启用，请重新加载安全设置");
        const expires = currentTime + CHALLENGE_MS;
        store.putChallenge({ token_hash: hashSessionToken(createSessionToken()), kind: "setup", session_hash: hash, secret: box.encrypt(secret), generation: state.generation, remember: 0, expires_at: expires }, currentTime);
        return { secret, qrCode, expiresAt: new Date(expires).toISOString() };
      });
    },

    confirmSetup(token: string | undefined, code: string) {
      const hash = sessionHash(token);
      store.requireSession(hash, time());
      store.attempt("manage", time());
      return transact("保存并启用双因素认证", () => {
        const currentTime = time();
        store.requireSession(hash, currentTime);
        const state = store.state();
        if (state.secret) throw new DomainError("TOTP_STATE_CONFLICT", "双因素认证已经启用，请重新加载安全设置");
        const pending = store.challenge(hash, "setup", currentTime);
        const step = matchTotp(box.decrypt(pending.secret!), code, currentTime);
        if (step === undefined) throw new DomainError("TOTP_INVALID_CODE", "首次验证码无效或已过期，双因素认证尚未启用，请检查验证器及设备时间");
        store.save({ secret: pending.secret, last_step: step, generation: state.generation + 1, enabled_at: new Date(currentTime).toISOString() });
        const recoveryCodes = newRecoveryCodes();
        const nextToken = createSessionToken();
        const remember = store.rotateSession(hash, hashSessionToken(nextToken), currentTime);
        return { token: nextToken, remember, recoveryCodes };
      });
    },

    cancelSetup(token: string | undefined): void {
      transact("取消双因素绑定", () => {
        const hash = sessionHash(token);
        store.requireSession(hash, time());
        store.cancelSetup(hash);
      });
    },

    async manage(token: string | undefined, proof: SecurityProof, action: "disable" | "recovery") {
      const hash = await requirePassword(token, proof.password);
      return transact(action === "disable" ? "关闭双因素认证" : "重新生成恢复码", () => {
        const currentTime = time();
        store.requireSession(hash, currentTime);
        consumeFactor(proof.code, proof.recovery === true, currentTime);
        const state = store.state();
        store.save(action === "disable"
          ? { secret: null, last_step: -1, generation: state.generation + 1, enabled_at: null }
          : { ...state, generation: state.generation + 1 });
        const recoveryCodes = action === "recovery" ? newRecoveryCodes() : [];
        if (action === "disable") store.replaceRecovery([]);
        const nextToken = createSessionToken();
        const remember = store.rotateSession(hash, hashSessionToken(nextToken), currentTime);
        return { token: nextToken, remember, recoveryCodes };
      });
    },
  };
}

export type TwoFactorService = ReturnType<typeof createTwoFactorService>;
