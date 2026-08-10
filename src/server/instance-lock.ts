import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";

import { DomainError } from "./core/errors";

export interface InstanceLock {
  release(): Promise<void>;
}

export interface InstanceLockOptions {
  retryWindowMs?: number;
  retryIntervalMs?: number;
}

const INSTANCE_LOCK_STALE_MS = 60_000;
const INSTANCE_LOCK_UPDATE_MS = 20_000;
const INSTANCE_LOCK_RETRY_WINDOW_MS = 75_000;
const INSTANCE_LOCK_RETRY_INTERVAL_MS = 1_000;

/** 获取数据目录独占锁，防止多个服务实例维护相互分叉的 Runtime。 */
export async function acquireInstanceLock(appDirectory: string, options: InstanceLockOptions = {}): Promise<InstanceLock> {
  await mkdir(appDirectory, { recursive: true, mode: 0o700 });
  let unlock: () => Promise<void>;
  try {
    unlock = await lockfile.lock(appDirectory, {
      lockfilePath: join(appDirectory, ".bugpaw-instance.lock"),
      realpath: true,
      // 容器重建时等待旧实例完成优雅退出，异常退出则等待陈旧锁安全过期。
      retries: createLockRetries(options),
      stale: INSTANCE_LOCK_STALE_MS,
      update: INSTANCE_LOCK_UPDATE_MS,
    });
  } catch (error) {
    if (isLockConflict(error)) {
      throw new DomainError("INSTANCE_ALREADY_RUNNING", "数据目录已经被另一个 BugPaw 服务实例使用", undefined, {
        cause: error,
      });
    }
    throw error;
  }

  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      await unlock();
    },
  };
}

function createLockRetries(options: InstanceLockOptions) {
  const retryWindowMs = options.retryWindowMs ?? INSTANCE_LOCK_RETRY_WINDOW_MS;
  const retryIntervalMs = options.retryIntervalMs ?? INSTANCE_LOCK_RETRY_INTERVAL_MS;
  const interval = Math.max(1, retryIntervalMs);
  return {
    retries: Math.max(0, Math.ceil(Math.max(0, retryWindowMs) / interval)),
    factor: 1,
    minTimeout: interval,
    maxTimeout: interval,
  };
}

function isLockConflict(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error.code === "ELOCKED" || error.code === "EEXIST");
}
