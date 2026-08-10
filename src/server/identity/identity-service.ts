import { createSessionToken, hashSessionToken, verifyPassword } from "../auth";
import type { IdentityRepository, IdentityUser } from "./identity-repository";
import { SYSTEM_LIMITS } from "../core/limits";

const OWNER_ID = "owner";
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1_000;
const LOGIN_WINDOW_MS = 60 * 1_000;
const MAX_LOGIN_FAILURES = 5;

interface LoginFailureState {
  failures: number;
  resetAt: number;
}

export interface IdentityServiceOptions {
  now?: () => Date;
}

export interface IdentityService {
  isInitialized(): Promise<boolean>;
  login(password: string, clientKey: string): Promise<
    | { status: "authenticated"; token: string }
    | { status: "invalid" | "rate_limited" | "not_initialized" }
  >;
  logout(token: string | undefined): Promise<void>;
  authenticateToken(token: string | undefined): Promise<boolean>;
  getProfile(): Promise<IdentityUser | undefined>;
  updateProfile(
    expectedRevision: string,
    patch: { displayName?: string; avatar?: IdentityUser["avatar"] | null },
  ): Promise<IdentityUser>;
}

/** 单用户登录策略，Repository 只接收密码摘要和 Session Token 摘要。 */
export function createIdentityService(
  repository: IdentityRepository,
  options: IdentityServiceOptions = {},
): IdentityService {
  const now = options.now ?? (() => new Date());
  const failures = new LoginFailureTracker();

  return {
    async isInitialized() {
      return Boolean(await repository.getUser(OWNER_ID));
    },
    async login(password, clientKey) {
      const currentTime = now();
      if (failures.isRateLimited(clientKey, currentTime.getTime())) {
        return { status: "rate_limited" };
      }
      const owner = await repository.getUser(OWNER_ID);
      if (!owner) return { status: "not_initialized" };
      if (!(await verifyPassword(password, owner.password))) {
        failures.record(clientKey, currentTime.getTime());
        return { status: "invalid" };
      }

      failures.clear(clientKey);
      await repository.deleteExpiredWebSessions(currentTime.toISOString());
      const token = createSessionToken();
      await repository.createWebSession({
        tokenHash: hashSessionToken(token),
        userId: owner.id,
        createdAt: currentTime.toISOString(),
        expiresAt: new Date(currentTime.getTime() + SESSION_DURATION_MS).toISOString(),
      });
      return { status: "authenticated", token };
    },
    async logout(token) {
      if (!token) return;
      await repository.deleteWebSession(hashSessionToken(token));
    },
    async authenticateToken(token) {
      if (!token) return false;
      return Boolean(await repository.findWebSession(hashSessionToken(token), now().toISOString()));
    },
    getProfile: () => repository.getUser(OWNER_ID),
    updateProfile: (expectedRevision, patch) => repository.updateProfile(OWNER_ID, expectedRevision, {
      ...patch,
      now: now().toISOString(),
    }),
  };
}

/** 有界保存短期登录失败状态，避免伪造客户端标识造成常驻内存增长。 */
export class LoginFailureTracker {
  private readonly failures = new Map<string, LoginFailureState>();

  constructor(private readonly maxClients: number = SYSTEM_LIMITS.loginFailureClients) {}

  get size(): number { return this.failures.size; }

  isRateLimited(clientKey: string, now: number): boolean {
    const failure = this.failures.get(clientKey);
    if (!failure) return false;
    if (failure.resetAt <= now) {
      this.failures.delete(clientKey);
      return false;
    }
    return failure.failures >= MAX_LOGIN_FAILURES;
  }

  record(clientKey: string, now: number): void {
    const existing = this.failures.get(clientKey);
    if (!existing || existing.resetAt <= now) {
      this.failures.delete(clientKey);
      this.failures.set(clientKey, { failures: 1, resetAt: now + LOGIN_WINDOW_MS });
    } else {
      existing.failures += 1;
    }
    while (this.failures.size > this.maxClients) {
      this.failures.delete(this.failures.keys().next().value as string);
    }
  }

  clear(clientKey: string): void { this.failures.delete(clientKey); }
}
