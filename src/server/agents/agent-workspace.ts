import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, realpath, rename, rm, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Agent 工作目录校验错误代码。
 */
export type AgentWorkspaceErrorCode =
  | "WORKSPACE_NOT_ABSOLUTE"
  | "WORKSPACE_ROOT_FORBIDDEN"
  | "WORKSPACE_OUTSIDE_DATA"
  | "WORKSPACE_NOT_DIRECTORY"
  | "WORKSPACE_IN_USE"
  | "WORKSPACE_PI_CONFLICT"
  | "DEFAULT_WORKSPACE_FIXED"
  | "WORKSPACE_MIGRATION_FAILED";

/**
 * 可由 HTTP 层稳定映射的 Agent 工作目录错误。
 */
export class AgentWorkspaceError extends Error {
  /**
   * 稳定错误代码。
   */
  readonly code: AgentWorkspaceErrorCode;

  /**
   * 创建工作目录错误。
   *
   * @param code 稳定错误代码
   * @param message 面向用户的中文错误信息
   */
  constructor(code: AgentWorkspaceErrorCode, message: string) {
    super(message);
    this.name = "AgentWorkspaceError";
    this.code = code;
  }
}

/**
 * 已准备完成、等待 Profile 写入结果的 `.pi` 迁移。
 */
export interface PiMigration {
  /**
   * Profile 写入成功后完成源目录清理。
   */
  commit(): Promise<void>;

  /**
   * Profile 写入失败时恢复迁移前状态。
   */
  rollback(): Promise<void>;
}

/**
 * 解析并校验数据根目录下的 Agent 工作目录。
 *
 * @param rootDir 服务端数据根目录
 * @param candidate 用户提交的候选路径
 */
export async function resolveAgentWorkspace(rootDir: string, candidate: string): Promise<string> {
  const value = candidate.trim();
  if (!isAbsolute(value)) {
    throw new AgentWorkspaceError("WORKSPACE_NOT_ABSOLUTE", "工作目录必须是绝对路径");
  }
  const root = resolve(rootDir);
  const target = resolve(value);
  const relativePath = relative(root, target);
  if (!relativePath) {
    throw new AgentWorkspaceError("WORKSPACE_ROOT_FORBIDDEN", "不能直接使用数据根目录");
  }
  if (isOutside(relativePath)) {
    throw new AgentWorkspaceError("WORKSPACE_OUTSIDE_DATA", "工作目录必须位于专用 workspace 目录下");
  }

  const existing = await nearestExistingPath(target);
  const info = await lstat(existing);
  if (!info.isDirectory() && !info.isSymbolicLink()) {
    throw new AgentWorkspaceError("WORKSPACE_NOT_DIRECTORY", "工作目录路径包含非目录对象");
  }
  const realRoot = await realpath(root);
  const realExisting = await realpath(existing);
  const realRelative = relative(realRoot, realExisting);
  if (isOutside(realRelative)) {
    throw new AgentWorkspaceError("WORKSPACE_OUTSIDE_DATA", "工作目录通过符号链接越出专用 workspace 目录");
  }
  return resolve(realExisting, relative(existing, target));
}

/**
 * 判断文件系统路径是否已经存在。
 *
 * @param path 待检查路径
 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return false;
    throw error;
  }
}

/**
 * 准备把旧工作目录的 `.pi` 迁移到新工作目录。
 *
 * @param sourceCwd 旧工作目录
 * @param targetCwd 新工作目录
 */
export async function preparePiMigration(sourceCwd: string, targetCwd: string): Promise<PiMigration> {
  const sourcePi = join(sourceCwd, ".pi");
  const targetPi = join(targetCwd, ".pi");
  if (await pathExists(targetPi)) {
    throw new AgentWorkspaceError("WORKSPACE_PI_CONFLICT", "目标工作目录已存在 .pi，无法迁移");
  }

  const targetExisted = await pathExists(targetCwd);
  await mkdir(targetCwd, { recursive: true, mode: 0o700 });
  if (!(await pathExists(sourcePi))) {
    return createEmptyMigration(targetCwd, targetExisted);
  }

  try {
    await rename(sourcePi, targetPi);
    return {
      commit: async () => undefined,
      rollback: async () => {
        await rename(targetPi, sourcePi);
        await removeCreatedEmptyDirectory(targetCwd, targetExisted);
      },
    };
  } catch (error) {
    if (!isFileSystemError(error, "EXDEV")) {
      await removeCreatedEmptyDirectory(targetCwd, targetExisted);
      throw migrationError(error);
    }
  }

  const temporaryPi = join(targetCwd, `.pi-migrate-${randomUUID()}`);
  try {
    await cp(sourcePi, temporaryPi, {
      recursive: true,
      force: false,
      errorOnExist: true,
      verbatimSymlinks: true,
    });
    await rename(temporaryPi, targetPi);
    return {
      commit: async () => {
        try {
          await rm(sourcePi, { recursive: true, force: true });
        } catch (error) {
          console.error("跨设备迁移已切换到新工作目录，但旧 .pi 清理失败", error);
        }
      },
      rollback: async () => {
        await rm(targetPi, { recursive: true, force: true });
        await removeCreatedEmptyDirectory(targetCwd, targetExisted);
      },
    };
  } catch (error) {
    await rm(temporaryPi, { recursive: true, force: true });
    await rm(targetPi, { recursive: true, force: true });
    await removeCreatedEmptyDirectory(targetCwd, targetExisted);
    throw migrationError(error);
  }
}

/**
 * 创建无需移动 `.pi` 的空迁移事务。
 *
 * @param targetCwd 新工作目录
 * @param targetExisted 新工作目录此前是否存在
 */
function createEmptyMigration(targetCwd: string, targetExisted: boolean): PiMigration {
  return {
    commit: async () => undefined,
    rollback: async () => removeCreatedEmptyDirectory(targetCwd, targetExisted),
  };
}

/**
 * 回滚时删除本次创建且仍为空的目标目录。
 *
 * @param targetCwd 新工作目录
 * @param targetExisted 新工作目录此前是否存在
 */
async function removeCreatedEmptyDirectory(targetCwd: string, targetExisted: boolean): Promise<void> {
  if (targetExisted) return;
  await rmdir(targetCwd).catch(() => undefined);
}

/**
 * 把底层文件系统异常包装成稳定迁移错误。
 *
 * @param error 底层异常
 */
function migrationError(error: unknown): AgentWorkspaceError {
  const detail = error instanceof Error ? `：${error.message}` : "";
  return new AgentWorkspaceError("WORKSPACE_MIGRATION_FAILED", `迁移 .pi 失败${detail}`);
}

/**
 * 判断相对路径是否越出根目录。
 *
 * @param value 待判断的相对路径
 */
function isOutside(value: string): boolean {
  return value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value);
}

/**
 * 从候选路径向上寻找最近的已存在对象。
 *
 * @param candidate 候选绝对路径
 */
async function nearestExistingPath(candidate: string): Promise<string> {
  let current = candidate;
  while (true) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT") && !isFileSystemError(error, "ENOTDIR")) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

/**
 * 判断未知异常是否为指定文件系统错误。
 *
 * @param error 未知异常
 * @param code 文件系统错误代码
 */
function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
