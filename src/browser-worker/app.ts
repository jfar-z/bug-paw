import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BrowserCommand, BrowserWorkerArtifactHandle, CreateBrowserContextRequest } from "../shared/browser-worker-protocol";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

/** Worker App 管理的单个 Context 接口。 */
export interface WorkerBrowserSession {
  /** 执行一个原子命令。 */
  execute(command: BrowserCommand): Promise<unknown>;
  /** 关闭 Browser Context。 */
  close(): Promise<void>;
}

interface WorkerBinaryArtifact {
  /** 浏览器生成的二进制内容。 */
  content: Buffer;
  /** 产物 MIME。 */
  mediaType: string;
  /** 浏览器建议的文件名。 */
  suggestedName?: string;
}

interface StoredArtifact extends BrowserWorkerArtifactHandle {
  /** Worker 私有临时路径。 */
  path: string;
  /** 所属租约。 */
  leaseId: string;
}

/** Worker 内部 HTTP 服务依赖。 */
export interface BrowserWorkerAppOptions {
  /** HMAC 内部通信密钥。 */
  secret: string;
  /** 从已验证配置创建 Context。 */
  createSession(input: CreateBrowserContextRequest): Promise<WorkerBrowserSession>;
  /** 可测试当前时间。 */
  now?: () => number;
}

/** 创建只处理已认证原子命令的 Worker HTTP 服务。 */
export function createBrowserWorkerApp(options: BrowserWorkerAppOptions) {
  const sessions = new Map<string, WorkerBrowserSession>();
  const artifacts = new Map<string, StoredArtifact>();
  const nonces = new Map<string, number>();
  let artifactRoot: Promise<string> | undefined;
  const now = options.now ?? Date.now;
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      const record = error instanceof Error && "code" in error ? error as Error & { code: unknown } : undefined;
      const code = typeof record?.code === "string" ? record.code : "BROWSER_WORKER_PROTOCOL_INVALID";
      sendJson(response, code === "BROWSER_WORKER_PROTOCOL_INVALID" ? 400 : 200, {
        status: "error",
        error: { code, message: error instanceof Error ? error.message : "浏览器 Worker 请求失败", retryable: false },
      });
    });
  });

  /** 路由单个已认证请求。 */
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === "GET" && request.url === "/healthz") {
      const body = await readBody(request);
      authenticate(request, body, now(), nonces, options.secret);
      sendJson(response, 200, { status: "ok", data: { status: "ok", contexts: sessions.size } });
      return;
    }
    const body = await readBody(request);
    if (!hasAuthHeaders(request)) {
      sendJson(response, 401, { status: "error", error: { code: "BROWSER_WORKER_PROTOCOL_INVALID", message: "内部请求未认证", retryable: false } });
      return;
    }
    authenticate(request, body, now(), nonces, options.secret);
    const value = body.length > 0 ? JSON.parse(body.toString("utf8")) as unknown : undefined;
    if (request.method === "POST" && request.url === "/v1/contexts") {
      const input = requireContextInput(value);
      if (sessions.has(input.leaseId)) throw workerError("BROWSER_WORKER_PROTOCOL_INVALID", "Browser Context 已存在");
      sessions.set(input.leaseId, await options.createSession(input));
      sendJson(response, 200, { status: "ok", data: { contextId: input.leaseId } });
      return;
    }
    const artifactMatch = request.url?.match(/^\/v1\/contexts\/([^/]+)\/artifacts\/([^/]+)$/u);
    if (request.method === "GET" && artifactMatch) {
      const leaseId = decodeURIComponent(artifactMatch[1]!);
      const handle = decodeURIComponent(artifactMatch[2]!);
      const artifact = artifacts.get(handle);
      if (!artifact || artifact.leaseId !== leaseId) throw workerError("BROWSER_WORKER_PROTOCOL_INVALID", "浏览器产物不存在或已经读取");
      artifacts.delete(handle);
      response.writeHead(200, {
        "content-type": artifact.mediaType,
        "content-length": artifact.size,
        "content-disposition": `attachment; filename="${encodeURIComponent(artifact.suggestedName ?? "artifact.bin")}"`,
        "cache-control": "no-store",
      });
      const stream = createReadStream(artifact.path);
      stream.once("close", () => { void unlink(artifact.path).catch(() => undefined); });
      stream.once("error", () => response.destroy());
      stream.pipe(response);
      return;
    }
    const match = request.url?.match(/^\/v1\/contexts\/([^/]+)(?:\/commands)?$/u);
    if (!match) throw workerError("BROWSER_WORKER_PROTOCOL_INVALID", "内部接口不存在");
    const leaseId = decodeURIComponent(match[1]!);
    if (request.method === "DELETE") {
      const session = sessions.get(leaseId);
      sessions.delete(leaseId);
      await session?.close();
      await removeLeaseArtifacts(leaseId, artifacts);
      sendJson(response, 200, { status: "ok", data: {} });
      return;
    }
    const session = sessions.get(leaseId);
    if (!session) throw workerError("BROWSER_CONTEXT_NOT_OPEN", "Browser Context 不存在或已经关闭");
    if (request.method !== "POST" || !request.url?.endsWith("/commands") || !isRecord(value) || value.leaseId !== leaseId || !isRecord(value.command)) {
      throw workerError("BROWSER_WORKER_PROTOCOL_INVALID", "浏览器命令格式无效");
    }
    const result = await session.execute(requireBrowserCommand(value.command));
    const binary = binaryArtifact(result);
    if (!binary) {
      sendJson(response, 200, { status: "ok", data: result });
      return;
    }
    artifactRoot ??= mkdtemp(join(tmpdir(), "bugpaw-browser-worker-"));
    const handle = randomUUID();
    const path = join(await artifactRoot, handle);
    await writeFile(path, binary.content, { mode: 0o600, flag: "wx" });
    const size = (await stat(path)).size;
    const artifact: StoredArtifact = {
      handle,
      leaseId,
      path,
      mediaType: binary.mediaType,
      size,
      ...(binary.suggestedName ? { suggestedName: binary.suggestedName } : {}),
    };
    artifacts.set(handle, artifact);
    sendJson(response, 200, { status: "ok", data: { artifact: publicArtifact(artifact) } });
  }

  server.on("close", () => {
    sessions.forEach((session) => void session.close());
    sessions.clear();
    artifacts.clear();
    if (artifactRoot) void artifactRoot.then((root) => rm(root, { recursive: true, force: true }));
  });
  return server;
}

/** 识别 Session 返回的二进制产物。 */
function binaryArtifact(value: unknown): WorkerBinaryArtifact | undefined {
  if (!isRecord(value) || !isRecord(value.artifact) || !Buffer.isBuffer(value.artifact.content)) return undefined;
  if (typeof value.artifact.mediaType !== "string") throw workerError("BROWSER_WORKER_PROTOCOL_INVALID", "浏览器产物 MIME 无效");
  return value.artifact as unknown as WorkerBinaryArtifact;
}

/** 只暴露一次性句柄和必要元数据。 */
function publicArtifact(artifact: StoredArtifact): BrowserWorkerArtifactHandle {
  return {
    handle: artifact.handle,
    mediaType: artifact.mediaType,
    size: artifact.size,
    ...(artifact.suggestedName ? { suggestedName: artifact.suggestedName } : {}),
  };
}

/** Context 关闭时删除尚未消费的临时产物。 */
async function removeLeaseArtifacts(leaseId: string, artifacts: Map<string, StoredArtifact>): Promise<void> {
  const matches = [...artifacts.values()].filter((artifact) => artifact.leaseId === leaseId);
  for (const artifact of matches) {
    artifacts.delete(artifact.handle);
    await unlink(artifact.path).catch(() => undefined);
  }
}

/** 读取有界请求体。 */
async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw workerError("BROWSER_WORKER_PROTOCOL_INVALID", "内部请求体过大");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** 校验时间、nonce、正文哈希和 HMAC。 */
function authenticate(request: IncomingMessage, body: Buffer, now: number, nonces: Map<string, number>, secret: string): void {
  const timestamp = singleHeader(request, "x-bugpaw-timestamp");
  const nonce = singleHeader(request, "x-bugpaw-nonce");
  const contentHash = singleHeader(request, "x-bugpaw-content-sha256");
  const signature = singleHeader(request, "x-bugpaw-signature");
  const parsedTimestamp = Number(timestamp);
  if (!Number.isSafeInteger(parsedTimestamp) || Math.abs(now - parsedTimestamp) > 60_000) throw workerError("BROWSER_WORKER_PROTOCOL_INVALID", "内部请求时间无效");
  for (const [seen, expiresAt] of nonces) if (expiresAt <= now) nonces.delete(seen);
  if (nonces.has(nonce)) throw workerError("BROWSER_WORKER_PROTOCOL_INVALID", "内部请求 nonce 已使用");
  const actualHash = createHash("sha256").update(body).digest("hex");
  if (contentHash !== actualHash) throw workerError("BROWSER_WORKER_PROTOCOL_INVALID", "内部请求正文校验失败");
  const path = request.url ?? "";
  const canonical = `${request.method}\n${path}\n${timestamp}\n${nonce}\n${contentHash}`;
  const expected = createHmac("sha256", secret).update(canonical).digest();
  const actual = Buffer.from(signature, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw workerError("BROWSER_WORKER_PROTOCOL_INVALID", "内部请求签名无效");
  nonces.set(nonce, now + 60_000);
}

/** 判断请求是否携带完整认证头。 */
function hasAuthHeaders(request: IncomingMessage): boolean {
  return ["x-bugpaw-timestamp", "x-bugpaw-nonce", "x-bugpaw-content-sha256", "x-bugpaw-signature"]
    .every((name) => typeof request.headers[name] === "string");
}

/** 读取单值 Header。 */
function singleHeader(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  if (typeof value !== "string") throw workerError("BROWSER_WORKER_PROTOCOL_INVALID", "内部请求缺少认证字段");
  return value;
}

/** 校验创建 Context 的最小结构。 */
function requireContextInput(value: unknown): CreateBrowserContextRequest {
  if (!isRecord(value)
    || typeof value.leaseId !== "string"
    || !isRecord(value.egress)
    || value.egress.leaseId !== value.leaseId
    || !Number.isInteger(value.maxPages)
    || (value.maxPages as number) < 1
    || (value.maxPages as number) > 4
    || !Array.isArray(value.permissions)) {
    throw workerError("BROWSER_WORKER_PROTOCOL_INVALID", "Browser Context 参数无效");
  }
  return value as unknown as CreateBrowserContextRequest;
}

/** 在 Worker 边界完整限制可执行的原子命令形状。 */
function requireBrowserCommand(value: Record<string, unknown>): BrowserCommand {
  switch (value.type) {
    case "open":
      if (!isRecord(value.target) || !["url", "preview"].includes(String(value.target.kind)) || typeof value.target.url !== "string" || typeof value.newPage !== "boolean") break;
      return value as unknown as BrowserCommand;
    case "snapshot":
      if (Number.isInteger(value.maxCharacters) && Number(value.maxCharacters) >= 1 && Number(value.maxCharacters) <= 200_000 && optionalString(value.pageId)) return value as unknown as BrowserCommand;
      break;
    case "click":
    case "submit":
      if (typeof value.ref === "string" && optionalString(value.pageId)) return value as unknown as BrowserCommand;
      break;
    case "scroll":
      if (["up", "down", "left", "right"].includes(String(value.direction)) && ["small", "medium", "large"].includes(String(value.amount)) && optionalString(value.ref) && optionalString(value.pageId)) return value as unknown as BrowserCommand;
      break;
    case "input":
      if (typeof value.ref === "string" && typeof value.text === "string" && value.text.length <= 100_000 && optionalString(value.pageId)) return value as unknown as BrowserCommand;
      break;
    case "upload":
      if (typeof value.ref === "string" && Array.isArray(value.files) && value.files.length <= 10 && value.files.every(isWorkerUpload) && optionalString(value.pageId)) return value as unknown as BrowserCommand;
      break;
    case "screenshot":
      if (["viewport", "fullPage", "element"].includes(String(value.mode)) && ["png", "jpeg"].includes(String(value.format)) && optionalString(value.ref) && optionalString(value.pageId) && optionalQuality(value.quality)) return value as unknown as BrowserCommand;
      break;
    case "download":
      if (isRecord(value.source) && optionalString(value.pageId)
        && ((value.source.kind === "url" && typeof value.source.url === "string") || (value.source.kind === "element" && typeof value.source.ref === "string"))) return value as unknown as BrowserCommand;
      break;
  }
  throw workerError("BROWSER_WORKER_PROTOCOL_INVALID", "浏览器命令格式无效或类型不受支持");
}

/** 判断可选字符串字段。 */
function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

/** 判断可选 JPEG 质量。 */
function optionalQuality(value: unknown): boolean {
  return value === undefined || (Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 100);
}

/** 校验 Worker 临时上传描述。 */
function isWorkerUpload(value: unknown): boolean {
  return isRecord(value)
    && typeof value.handle === "string"
    && typeof value.name === "string"
    && typeof value.mediaType === "string";
}

/** 发送固定 JSON 响应。 */
function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, { "content-type": "application/json", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
  response.end(body);
}

/** 创建带 code 的 Worker 错误。 */
function workerError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
