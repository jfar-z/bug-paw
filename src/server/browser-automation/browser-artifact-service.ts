import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, realpath, rm } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";

import type { BrowserAutomationConfig } from "../../shared/browser-automation-contracts";
import { sanitizeAttachmentName } from "../attachments";
import { writeJsonAtomic } from "../storage";
import { BrowserAutomationError } from "./browser-error";

/** 已保存浏览产物的安全元数据。 */
export interface BrowserArtifact {
  /** 相对于 Agent 工作区的路径。 */
  path: string;
  /** 文件 MIME。 */
  mediaType: string;
  /** 文件字节数。 */
  size: number;
  /** 文件 SHA-256。 */
  sha256: string;
  /** 下载来源 URL。 */
  sourceUrl?: string;
}

interface ArtifactServiceDependencies {
  /** 可测试日期。 */
  now?: () => Date;
  /** 可测试任务目录标识。 */
  taskId?: () => string;
}

interface RunArtifactState {
  /** 当前 Run 的系统任务目录。 */
  taskId: string;
  /** 绑定的工作区 realpath。 */
  cwd: string;
  /** 截图数。 */
  screenshots: number;
  /** 下载数。 */
  downloads: number;
  /** 下载总字节数。 */
  downloadBytes: number;
  /** 已保存产物清单。 */
  artifacts: BrowserArtifact[];
}

/** 把 Worker 临时产物安全地写入当前 Agent 工作区。 */
export class BrowserArtifactService {
  /** Run 级计数与目录。 */
  private readonly runs = new Map<string, RunArtifactState>();
  /** 当前时间函数。 */
  private readonly now: () => Date;
  /** 任务标识生成函数。 */
  private readonly taskId: () => string;

  /** 创建浏览产物服务。 */
  constructor(private config: BrowserAutomationConfig["artifacts"], dependencies: ArtifactServiceDependencies = {}) {
    this.now = dependencies.now ?? (() => new Date());
    this.taskId = dependencies.taskId ?? randomUUID;
  }

  /** 运行期应用管理员更新后的产物配额。 */
  reconfigure(config: BrowserAutomationConfig["artifacts"]): void {
    this.config = { ...config, allowedDownloadMimeTypes: [...config.allowedDownloadMimeTypes], screenshotFormats: [...config.screenshotFormats] };
  }

  /** 保存一个下载流。 */
  async saveDownload(input: {
    cwd: string;
    runId: string;
    originalName: string;
    mediaType: string;
    sourceUrl: string;
    stream: Readable;
  }): Promise<BrowserArtifact> {
    const mediaType = input.mediaType.toLowerCase();
    if (!this.config.allowedDownloadMimeTypes.includes(mediaType)) {
      throw new BrowserAutomationError("BROWSER_DOWNLOAD_BLOCKED", "下载文件类型不在允许清单中", false);
    }
    const state = await this.state(input.runId, input.cwd);
    if (state.downloads >= this.config.maxDownloadsPerRun) throw limitError("当前 Run 的下载数量已达到上限");
    const remaining = this.config.maxDownloadBytesPerRun - state.downloadBytes;
    const maximum = Math.min(this.config.maxDownloadBytes, remaining);
    if (maximum <= 0) throw limitError("当前 Run 的下载总量已达到上限");
    const artifact = await this.saveStream(state, "downloads", sanitizeAttachmentName(input.originalName), mediaType, input.stream, maximum, input.sourceUrl);
    state.downloads += 1;
    state.downloadBytes += artifact.size;
    await this.writeManifest(state);
    return artifact;
  }

  /** 保存一张由 Worker 返回的截图。 */
  async saveScreenshot(input: { cwd: string; runId: string; format: "png" | "jpeg"; content: Buffer }): Promise<BrowserArtifact> {
    if (!this.config.screenshotFormats.includes(input.format)) throw new BrowserAutomationError("BROWSER_ARTIFACT_LIMIT_REACHED", "截图格式未启用", false);
    const state = await this.state(input.runId, input.cwd);
    if (state.screenshots >= this.config.maxScreenshotsPerRun) throw limitError("当前 Run 的截图数量已达到上限");
    const extension = input.format === "jpeg" ? "jpg" : "png";
    const artifact = await this.saveStream(
      state,
      "screenshots",
      `screenshot-${String(state.screenshots + 1).padStart(3, "0")}.${extension}`,
      input.format === "jpeg" ? "image/jpeg" : "image/png",
      bufferStream(input.content),
      50 * 1024 * 1024,
    );
    state.screenshots += 1;
    await this.writeManifest(state);
    return artifact;
  }

  /** 创建或读取 Run 状态，并阻止同一 Run 切换工作区。 */
  private async state(runId: string, cwdInput: string): Promise<RunArtifactState> {
    const cwd = await realpath(cwdInput);
    const existing = this.runs.get(runId);
    if (existing) {
      if (existing.cwd !== cwd) throw new BrowserAutomationError("BROWSER_LOCAL_FILE_OUTSIDE_WORKSPACE", "浏览器 Run 的工作目录发生变化", false);
      return existing;
    }
    const state = { taskId: this.taskId(), cwd, screenshots: 0, downloads: 0, downloadBytes: 0, artifacts: [] };
    this.runs.set(runId, state);
    return state;
  }

  /** 以有界流、独占目标和同目录临时文件保存产物。 */
  private async saveStream(
    state: RunArtifactState,
    kind: "screenshots" | "downloads",
    requestedName: string,
    mediaType: string,
    stream: AsyncIterable<unknown>,
    maximumBytes: number,
    sourceUrl?: string,
  ): Promise<BrowserArtifact> {
    const date = this.now().toISOString().slice(0, 10);
    const directory = join(state.cwd, "browser-artifacts", date, state.taskId, kind);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryRealPath = await realpath(directory);
    if (!isWithin(state.cwd, directoryRealPath)) throw new BrowserAutomationError("BROWSER_LOCAL_FILE_OUTSIDE_WORKSPACE", "浏览产物目录越出 Agent 工作区", false);
    const temporaryPath = join(directoryRealPath, `.${randomUUID()}.tmp`);
    const handle = await open(temporaryPath, "wx", 0o600);
    const hash = createHash("sha256");
    let size = 0;
    try {
      for await (const value of stream) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
        size += chunk.length;
        if (size > maximumBytes) throw new BrowserAutomationError("BROWSER_DOWNLOAD_TOO_LARGE", "下载文件超过当前大小限制", false);
        hash.update(chunk);
        await handle.write(chunk);
      }
      await handle.sync();
      await handle.close();
      const target = await linkWithAvailableName(temporaryPath, directoryRealPath, requestedName);
      await rm(temporaryPath, { force: true });
      const artifact: BrowserArtifact = {
        path: slashPath(relative(state.cwd, target)),
        mediaType,
        size,
        sha256: hash.digest("hex"),
        ...(sourceUrl ? { sourceUrl } : {}),
      };
      state.artifacts.push(artifact);
      return artifact;
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** 原子更新不含页面内容的 manifest。 */
  private async writeManifest(state: RunArtifactState): Promise<void> {
    const date = this.now().toISOString().slice(0, 10);
    await writeJsonAtomic(join(state.cwd, "browser-artifacts", date, state.taskId, "manifest.json"), {
      runId: state.artifacts.length > 0 ? "current" : "empty",
      artifacts: state.artifacts,
    });
  }
}

/** 使用硬链接独占提交临时文件，避免 rename 覆盖同名文件。 */
async function linkWithAvailableName(temporaryPath: string, directory: string, requestedName: string): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    const extension = extname(requestedName);
    const stem = basename(requestedName, extension);
    const name = attempt === 0 ? requestedName : `${stem} (${attempt})${extension}`;
    const target = resolve(directory, name);
    if (!isWithin(directory, target)) throw new BrowserAutomationError("BROWSER_LOCAL_FILE_OUTSIDE_WORKSPACE", "浏览产物文件名越界", false);
    try {
      await link(temporaryPath, target);
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

/** 将 Buffer 包装为异步可迭代流。 */
async function* bufferStream(content: Buffer): AsyncGenerator<Buffer> {
  yield content;
}

/** 创建统一的 Run 配额错误。 */
function limitError(message: string): BrowserAutomationError {
  return new BrowserAutomationError("BROWSER_ARTIFACT_LIMIT_REACHED", message, false);
}

/** 判断目标路径是否在根目录内。 */
function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`);
}

/** 把系统路径转换为工具可返回的正斜线相对路径。 */
function slashPath(value: string): string {
  return value.split(sep).join("/");
}
