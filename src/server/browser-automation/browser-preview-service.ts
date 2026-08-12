import { randomBytes } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, posix, relative, resolve, sep } from "node:path";

import mime from "mime";

import { BrowserAutomationError } from "./browser-error";

/** 单个 Run 的临时静态预览授权。 */
export interface BrowserPreviewGrant {
  /** 所属 Run。 */
  runId: string;
  /** 不透明随机授权。 */
  token: string;
  /** Worker 打开的内部 URL。 */
  url: string;
  /** 工作区相对入口。 */
  entryPath: string;
  /** 授权到期时间。 */
  expiresAt: number;
}

interface BrowserPreviewServiceOptions {
  /** 仅内部网络可访问的主服务 Origin。 */
  internalOrigin: string;
  /** 可测试 token 生成函数。 */
  token?: () => string;
  /** 可测试当前时间。 */
  now?: () => number;
  /** 授权最长存活时间。 */
  ttlMs?: number;
}

interface StoredGrant extends BrowserPreviewGrant {
  /** 经 realpath 固定的工作区根。 */
  cwd: string;
}

/** 为当前 Agent 工作区提供无目录列表的一次性静态预览。 */
export class BrowserPreviewService {
  /** token 到授权的映射。 */
  private readonly grants = new Map<string, StoredGrant>();
  /** 内部 Origin。 */
  private readonly internalOrigin: string;
  /** token 生成器。 */
  private readonly token: () => string;
  /** 当前时间。 */
  private readonly now: () => number;
  /** 授权时限。 */
  private readonly ttlMs: number;

  /** 创建静态预览服务。 */
  constructor(options: BrowserPreviewServiceOptions) {
    this.internalOrigin = options.internalOrigin.replace(/\/+$/u, "");
    this.token = options.token ?? (() => randomBytes(32).toString("hex"));
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 90 * 60_000;
  }

  /** 返回可加入短期出口 Grant 的规范化内部 Origin。 */
  get origin(): string {
    return new URL(this.internalOrigin).origin;
  }

  /** 校验 HTML 入口并签发当前 Run 的临时 URL。 */
  async authorize(input: { cwd: string; runId: string; entryPath: string }): Promise<BrowserPreviewGrant> {
    const cwd = await realpath(input.cwd);
    const entryPath = normalizeRelativePath(input.entryPath);
    if (extname(entryPath).toLowerCase() !== ".html") throw outsideError();
    await requireWorkspaceFile(cwd, entryPath);
    const token = this.token();
    const grant: StoredGrant = {
      runId: input.runId,
      token,
      cwd,
      entryPath,
      expiresAt: this.now() + this.ttlMs,
      url: `${this.internalOrigin}/internal/browser-preview/${encodeURIComponent(token)}/${entryPath.split("/").map(encodeURIComponent).join("/")}`,
    };
    this.grants.set(token, grant);
    return publicGrant(grant);
  }

  /** 读取授权工作区中的单个文件。 */
  async read(token: string, resourcePath: string): Promise<{ content: Buffer; mediaType: string }> {
    const grant = this.grants.get(token);
    if (!grant || grant.expiresAt <= this.now()) {
      if (grant) this.grants.delete(token);
      throw new BrowserAutomationError("BROWSER_CONTEXT_EXPIRED", "本地页面预览授权已失效", false);
    }
    const path = normalizeRelativePath(resourcePath);
    const absolutePath = await requireWorkspaceFile(grant.cwd, path);
    return {
      content: await readFile(absolutePath),
      mediaType: mime.getType(absolutePath) ?? "application/octet-stream",
    };
  }

  /** 撤销指定 Run 的全部预览授权。 */
  revokeRun(runId: string): number {
    let removed = 0;
    for (const [token, grant] of this.grants) {
      if (grant.runId === runId) {
        this.grants.delete(token);
        removed += 1;
      }
    }
    return removed;
  }
}

/** 校验词法路径和 realpath 均位于工作区，且拒绝符号链接和目录。 */
async function requireWorkspaceFile(cwd: string, path: string): Promise<string> {
  const candidate = resolve(cwd, path);
  if (!isWithin(cwd, candidate)) throw outsideError();
  try {
    const lexicalInfo = await lstat(candidate);
    if (lexicalInfo.isSymbolicLink() || !lexicalInfo.isFile()) throw outsideError();
    const actual = await realpath(candidate);
    if (!isWithin(cwd, actual) || actual !== candidate) throw outsideError();
    return actual;
  } catch (error) {
    if (error instanceof BrowserAutomationError) throw error;
    throw outsideError();
  }
}

/** 规范化 URL 使用的工作区相对路径。 */
function normalizeRelativePath(value: string): string {
  if (!value || value.includes("\0") || value.includes("\\") || isAbsolute(value)) throw outsideError();
  const normalized = posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) throw outsideError();
  return normalized;
}

/** 判断目标是否在根目录内。 */
function isWithin(root: string, target: string): boolean {
  const value = relative(root, target);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

/** 创建统一的工作区边界错误。 */
function outsideError(): BrowserAutomationError {
  return new BrowserAutomationError("BROWSER_LOCAL_FILE_OUTSIDE_WORKSPACE", "本地页面文件不在当前 Agent 工作目录或不是可预览文件", false);
}

/** 从内部存储结构移除绝对工作区路径。 */
function publicGrant(grant: StoredGrant): BrowserPreviewGrant {
  return {
    runId: grant.runId,
    token: grant.token,
    url: grant.url,
    entryPath: grant.entryPath,
    expiresAt: grant.expiresAt,
  };
}
