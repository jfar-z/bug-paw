import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import type {
  AigcMediaClip,
  AigcMediaClipInput,
  AigcMediaClipKind,
  AigcMediaProject,
  AigcMediaProjectCreateInput,
  AigcMediaProjectDocument,
  AigcMediaProjectKind,
  AigcMediaProjectUpdateInput,
  AigcMediaRenderJob,
} from "../../shared/aigc-media-editor-contracts";
import { readJson, writeJsonAtomic } from "../storage";
import { sanitizeFileName, validAssetId, type AigcAssetService } from "./aigc-asset-service";
import { AigcMediaRenderer, type AigcResolvedMediaClip } from "./aigc-media-renderer";
import type { AigcTaskService } from "./aigc-task-service";

const MAX_CLIPS = 30;
const MAX_QUEUE = 8;
const MAX_SOURCE_BYTES = 1024 * 1024 * 1024;
const MAX_VIDEO_DURATION_MS = 20 * 60 * 1000;
const MAX_AUDIO_DURATION_MS = 2 * 60 * 60 * 1000;
const MIN_IMAGE_DURATION_MS = 500;
const MAX_IMAGE_DURATION_MS = 30_000;

interface StoredMediaEditorDocument {
  projects: AigcMediaProject[];
  renders: AigcMediaRenderJob[];
}

interface AigcMediaProjectDependencies {
  filePath: string;
  outputRoot: string;
  tasks: Pick<AigcTaskService, "get">;
  assets: Pick<AigcAssetService, "resolveOutputPath">;
  renderer?: Pick<AigcMediaRenderer, "probe" | "render">;
}

/** 可稳定映射为 HTTP 状态的轻剪辑领域错误。 */
export class AigcMediaProjectError extends Error {
  constructor(readonly code: "NOT_FOUND" | "CONFLICT" | "INVALID" | "QUEUE_FULL", message: string) {
    super(message);
    this.name = "AigcMediaProjectError";
  }
}

/** 持久化轻剪辑工程，并以全局单并发队列执行 FFmpeg。 */
export class AigcMediaProjectService {
  private readonly projects = new Map<string, AigcMediaProject>();
  private readonly renders = new Map<string, AigcMediaRenderJob>();
  private readonly renderer: Pick<AigcMediaRenderer, "probe" | "render">;
  private readonly ready: Promise<void>;
  private mutationTail = Promise.resolve();
  private activeRenderId?: string;
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly dependencies: AigcMediaProjectDependencies) {
    this.renderer = dependencies.renderer ?? new AigcMediaRenderer();
    this.ready = this.load();
  }

  /** 按最近修改时间列出全部剪辑工程。 */
  async list(): Promise<AigcMediaProjectDocument> {
    await this.ready;
    return { projects: [...this.projects.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).map(copyProject) };
  }

  /** 读取单个工程。 */
  async get(id: string): Promise<AigcMediaProject | undefined> {
    await this.ready;
    const project = this.projects.get(id);
    return project ? copyProject(project) : undefined;
  }

  /** 创建不含片段的轻剪辑工程。 */
  async create(input: AigcMediaProjectCreateInput): Promise<AigcMediaProject> {
    return this.mutate(async () => {
      const kind = validateProjectKind(input.kind);
      const now = new Date().toISOString();
      const project: AigcMediaProject = {
        id: randomUUID(),
        revision: randomUUID(),
        name: normalizeProjectName(input.name, kind),
        kind,
        clips: [],
        createdAt: now,
        updatedAt: now,
      };
      this.projects.set(project.id, project);
      await this.persist();
      return copyProject(project);
    });
  }

  /** 校验所有产物引用并原子替换工程时间线。 */
  async update(id: string, input: AigcMediaProjectUpdateInput): Promise<AigcMediaProject> {
    await this.ready;
    const current = this.projects.get(id);
    if (!current) throw new AigcMediaProjectError("NOT_FOUND", "剪辑工程不存在");
    if (current.revision !== input.revision) throw new AigcMediaProjectError("CONFLICT", "剪辑工程已在其他页面更新");
    const clips = await this.materializeClips(current.kind, input.clips, current.clips);
    const name = normalizeProjectName(input.name, current.kind);
    return this.mutate(async () => {
      const latest = this.projects.get(id);
      if (!latest) throw new AigcMediaProjectError("NOT_FOUND", "剪辑工程不存在");
      if (latest.revision !== input.revision) throw new AigcMediaProjectError("CONFLICT", "剪辑工程已在其他页面更新");
      const project: AigcMediaProject = {
        ...latest,
        revision: randomUUID(),
        name,
        clips,
        updatedAt: new Date().toISOString(),
      };
      this.projects.set(id, project);
      await this.persist();
      return copyProject(project);
    });
  }

  /** 删除工程、历史导出记录和对应文件。 */
  async remove(id: string): Promise<void> {
    await this.mutate(async () => {
      if (!this.projects.has(id)) throw new AigcMediaProjectError("NOT_FOUND", "剪辑工程不存在");
      const running = [...this.renders.values()].find((job) => job.projectId === id && job.status === "running");
      if (running) throw new AigcMediaProjectError("CONFLICT", "工程正在导出，不能删除");
      for (const [renderId, job] of this.renders) {
        if (job.projectId === id) this.renders.delete(renderId);
      }
      this.projects.delete(id);
      await this.persist();
      await rm(join(this.dependencies.outputRoot, id), { recursive: true, force: true });
    });
  }

  /** 创建导出任务；实际执行由全局单并发队列串行调度。 */
  async render(projectId: string): Promise<AigcMediaRenderJob> {
    const job = await this.mutate(async () => {
      const project = this.projects.get(projectId);
      if (!project) throw new AigcMediaProjectError("NOT_FOUND", "剪辑工程不存在");
      if (!project.clips.length) throw new AigcMediaProjectError("INVALID", "请先添加至少一个片段");
      const active = [...this.renders.values()].find((candidate) => candidate.projectId === projectId
        && (candidate.status === "queued" || candidate.status === "running"));
      if (active) throw new AigcMediaProjectError("CONFLICT", "当前工程已有导出任务");
      const waiting = [...this.renders.values()].filter((candidate) => candidate.status === "queued").length;
      if (waiting >= MAX_QUEUE) throw new AigcMediaProjectError("QUEUE_FULL", "导出队列已满，请稍后重试");
      const created: AigcMediaRenderJob = {
        id: randomUUID(),
        projectId,
        projectName: project.name,
        kind: project.kind,
        status: "queued",
        progress: 0,
        createdAt: new Date().toISOString(),
      };
      this.renders.set(created.id, created);
      await this.persist();
      return this.withQueuePosition(created);
    });
    this.drainQueue();
    return job;
  }

  /** 读取导出任务并动态附加排队位置。 */
  async getRender(id: string): Promise<AigcMediaRenderJob | undefined> {
    await this.ready;
    const job = this.renders.get(id);
    return job ? this.withQueuePosition(job) : undefined;
  }

  /** 取消排队或运行中的导出任务。 */
  async cancelRender(id: string): Promise<AigcMediaRenderJob> {
    return this.mutate(async () => {
      const job = this.renders.get(id);
      if (!job) throw new AigcMediaProjectError("NOT_FOUND", "导出任务不存在");
      if (job.status === "queued") {
        const cancelled = { ...job, status: "cancelled" as const, finishedAt: new Date().toISOString() };
        this.renders.set(id, cancelled);
        await this.persist();
        return copyRender(cancelled);
      }
      if (job.status === "running") {
        this.controllers.get(id)?.abort(new DOMException("导出已取消", "AbortError"));
        return copyRender(job);
      }
      return copyRender(job);
    });
  }

  /** 解析已成功导出的文件路径，禁止越界。 */
  async resolveRenderPath(id: string): Promise<string | undefined> {
    await this.ready;
    const job = this.renders.get(id);
    if (!job || job.status !== "succeeded" || !job.fileName || !validAssetId(id) || !validAssetId(job.projectId)) return undefined;
    const root = resolve(this.dependencies.outputRoot);
    const target = resolve(root, job.projectId, id, job.kind === "video" ? "output.mp4" : "output.mp3");
    if (!target.startsWith(`${root}${sep}`)) return undefined;
    try {
      return (await stat(target)).isFile() ? target : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  /** 串行校验片段，避免同时启动多个 FFprobe 抢占有限 CPU。 */
  private async materializeClips(kind: AigcMediaProjectKind, inputs: AigcMediaClipInput[], previous: AigcMediaClip[]): Promise<AigcMediaClip[]> {
    if (!Array.isArray(inputs) || inputs.length > MAX_CLIPS) throw new AigcMediaProjectError("INVALID", `单个工程最多包含 ${MAX_CLIPS} 个片段`);
    const ids = new Set<string>();
    const clips: AigcMediaClip[] = [];
    let sourceBytes = 0;
    for (const input of inputs) {
      if (!input || !validAssetId(input.id) || ids.has(input.id) || !validAssetId(input.source?.taskId) || !validAssetId(input.source?.assetId)) {
        throw new AigcMediaProjectError("INVALID", "时间线片段格式无效");
      }
      ids.add(input.id);
      const task = await this.dependencies.tasks.get(input.source.taskId);
      const asset = task?.assets.find((candidate) => candidate.id === input.source.assetId);
      if (!task || !asset) throw new AigcMediaProjectError("NOT_FOUND", "时间线引用的 AIGC 产物不存在");
      const clipKind = mediaKind(asset.mediaType);
      if (!clipKind || (kind === "audio" ? clipKind !== "audio" : clipKind === "audio")) {
        throw new AigcMediaProjectError("INVALID", kind === "audio" ? "音频工程只能添加音频产物" : "视频工程只能添加视频或图片产物");
      }
      sourceBytes += asset.size;
      if (sourceBytes > MAX_SOURCE_BYTES) throw new AigcMediaProjectError("INVALID", "工程引用的原始产物总量不能超过 1 GiB");
      const path = await this.dependencies.assets.resolveOutputPath(task.id, asset.id);
      if (!path) throw new AigcMediaProjectError("NOT_FOUND", "时间线引用的 AIGC 产物文件不存在");
      const existing = previous.find((candidate) => candidate.id === input.id
        && candidate.source.taskId === input.source.taskId && candidate.source.assetId === input.source.assetId);
      const metadata = clipKind === "image"
        ? { durationMs: validateImageDuration(input.imageDurationMs), hasAudio: false }
        : existing && existing.kind === clipKind
          // AIGC 产物不可原位替换，未更换来源时复用已验证元数据，减少 FFprobe 消耗。
          ? { durationMs: existing.sourceDurationMs, hasAudio: existing.hasAudio, width: existing.width, height: existing.height }
          : await this.renderer.probe(path).catch(() => { throw new AigcMediaProjectError("INVALID", `无法读取媒体元数据：${asset.name}`); });
      const trimStartMs = clipKind === "image" ? 0 : validateInteger(input.trimStartMs, "片段起点", 0, metadata.durationMs - 1);
      const trimEndMs = clipKind === "image" ? metadata.durationMs : validateInteger(input.trimEndMs ?? metadata.durationMs, "片段终点", trimStartMs + 1, metadata.durationMs);
      clips.push({
        id: input.id,
        source: { taskId: task.id, assetId: asset.id },
        name: asset.name,
        mediaType: asset.mediaType,
        kind: clipKind,
        sourceDurationMs: metadata.durationMs,
        trimStartMs,
        trimEndMs,
        ...(clipKind === "image" ? { imageDurationMs: metadata.durationMs } : {}),
        muted: clipKind === "video" && Boolean(input.muted),
        hasAudio: metadata.hasAudio,
        ...(metadata.width ? { width: metadata.width } : {}),
        ...(metadata.height ? { height: metadata.height } : {}),
      });
    }
    const duration = clips.reduce((total, clip) => total + clipDuration(clip), 0);
    const maximum = kind === "video" ? MAX_VIDEO_DURATION_MS : MAX_AUDIO_DURATION_MS;
    if (duration > maximum) throw new AigcMediaProjectError("INVALID", kind === "video" ? "视频工程最长 20 分钟" : "音频工程最长 2 小时");
    return clips;
  }

  /** 若当前空闲，从持久化队列中启动最早的任务。 */
  private drainQueue(): void {
    if (this.activeRenderId) return;
    const next = [...this.renders.values()]
      .filter((job) => job.status === "queued")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
    if (!next) return;
    this.activeRenderId = next.id;
    void this.executeRender(next.id).catch(() => undefined).finally(() => {
      if (this.activeRenderId === next.id) this.activeRenderId = undefined;
      this.drainQueue();
    });
  }

  /** 解析源文件后执行唯一 FFmpeg 子进程，并原子发布完成文件。 */
  private async executeRender(id: string): Promise<void> {
    const controller = new AbortController();
    const context = await this.mutate(async () => {
      const job = this.renders.get(id);
      const project = job && this.projects.get(job.projectId);
      if (!job || !project || job.status !== "queued") return undefined;
      this.controllers.set(id, controller);
      this.renders.set(id, { ...job, status: "running", startedAt: new Date().toISOString(), progress: 0 });
      await this.persist().catch(() => undefined);
      return { project: copyProject(project) };
    });
    if (!context) return;
    const { project } = context;
    const directory = join(this.dependencies.outputRoot, project.id, id);
    const extension = project.kind === "video" ? "mp4" : "mp3";
    const target = join(directory, `output.${extension}`);
    const temporary = join(directory, `output.${extension}.tmp`);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const clips: AigcResolvedMediaClip[] = [];
      for (const clip of project.clips) {
        const path = await this.dependencies.assets.resolveOutputPath(clip.source.taskId, clip.source.assetId);
        if (!path) throw new Error("源产物已被删除");
        clips.push({
          path,
          kind: clip.kind,
          trimStartMs: clip.trimStartMs,
          durationMs: clipDuration(clip),
          muted: Boolean(clip.muted),
          hasAudio: clip.hasAudio,
        });
      }
      const size = await this.renderer.render({
        kind: project.kind,
        clips,
        outputPath: temporary,
        signal: controller.signal,
        onProgress: (progress) => {
          const current = this.renders.get(id);
          if (current?.status === "running") this.renders.set(id, { ...current, progress });
        },
      });
      await rename(temporary, target);
      const finishedAt = new Date().toISOString();
      const fileName = exportFileName(project.name, extension);
      await this.mutate(async () => {
        const current = this.renders.get(id);
        if (!current) return;
        this.renders.set(id, {
          ...current,
          status: "succeeded",
          progress: 1,
          fileName,
          mediaType: project.kind === "video" ? "video/mp4" : "audio/mpeg",
          size,
          finishedAt,
        });
        const latest = this.projects.get(project.id);
        if (latest) this.projects.set(project.id, { ...latest, latestRenderId: id, updatedAt: finishedAt, revision: randomUUID() });
        await this.persist();
      });
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      const cancelled = controller.signal.aborted;
      await this.mutate(async () => {
        const current = this.renders.get(id);
        if (!current) return;
        this.renders.set(id, {
          ...current,
          status: cancelled ? "cancelled" : "failed",
          progress: current.progress,
          ...(!cancelled ? { error: safeRenderError(error) } : {}),
          finishedAt: new Date().toISOString(),
        });
        await this.persist();
      });
    } finally {
      this.controllers.delete(id);
    }
  }

  private withQueuePosition(job: AigcMediaRenderJob): AigcMediaRenderJob {
    const copy = copyRender(job);
    if (job.status !== "queued") return copy;
    const queue = [...this.renders.values()].filter((candidate) => candidate.status === "queued")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return { ...copy, queuePosition: queue.findIndex((candidate) => candidate.id === job.id) + 1 };
  }

  private async load(): Promise<void> {
    const document = await readJson<StoredMediaEditorDocument>(this.dependencies.filePath);
    if (!document || !Array.isArray(document.projects) || !Array.isArray(document.renders)) return;
    for (const project of document.projects) {
      if (isProject(project)) this.projects.set(project.id, copyProject(project));
    }
    let recovered = false;
    for (const render of document.renders) {
      if (!isRender(render)) continue;
      const interrupted = render.status === "queued" || render.status === "running";
      this.renders.set(render.id, interrupted ? {
        ...copyRender(render),
        status: "failed",
        error: "服务重启导致导出中断，请重新导出",
        finishedAt: new Date().toISOString(),
      } : copyRender(render));
      recovered ||= interrupted;
    }
    if (recovered) await this.persist();
  }

  private async persist(): Promise<void> {
    await writeJsonAtomic(this.dependencies.filePath, {
      projects: [...this.projects.values()].map(copyProject),
      renders: [...this.renders.values()].map(copyRender),
    } satisfies StoredMediaEditorDocument);
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    await this.ready;
    let release: () => void = () => undefined;
    const previous = this.mutationTail;
    this.mutationTail = new Promise<void>((resolveTail) => { release = resolveTail; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function mediaKind(mediaType: string): AigcMediaClipKind | undefined {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("video/")) return "video";
  if (mediaType.startsWith("audio/")) return "audio";
  return undefined;
}

function clipDuration(clip: AigcMediaClip): number {
  return clip.kind === "image" ? clip.imageDurationMs ?? clip.sourceDurationMs : (clip.trimEndMs ?? clip.sourceDurationMs) - clip.trimStartMs;
}

function validateProjectKind(value: unknown): AigcMediaProjectKind {
  if (value !== "video" && value !== "audio") throw new AigcMediaProjectError("INVALID", "工程类型无效");
  return value;
}

function normalizeProjectName(value: unknown, kind: AigcMediaProjectKind): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (name.length > 80) throw new AigcMediaProjectError("INVALID", "工程名称不能超过 80 个字符");
  return name || `未命名${kind === "video" ? "视频" : "音频"}工程`;
}

function validateImageDuration(value: unknown): number {
  return validateInteger(value ?? 3000, "图片时长", MIN_IMAGE_DURATION_MS, MAX_IMAGE_DURATION_MS);
}

function validateInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new AigcMediaProjectError("INVALID", `${label}必须在 ${minimum} 到 ${maximum} 毫秒之间`);
  }
  return Number(value);
}

function exportFileName(name: string, extension: string): string {
  const stem = sanitizeFileName(name).replace(/\.[^.]+$/u, "") || "aigc-edit";
  return `${stem}.${extension}`;
}

function safeRenderError(error: unknown): string {
  const message = error instanceof Error ? error.message : "媒体导出失败";
  if (message.includes("源产物已被删除")) return message;
  if (message.includes("超时")) return "媒体导出超过资源时限";
  return "媒体导出失败，请检查源文件格式";
}

function copyProject(project: AigcMediaProject): AigcMediaProject {
  return { ...project, clips: project.clips.map((clip) => ({ ...clip, source: { ...clip.source } })) };
}

function copyRender(render: AigcMediaRenderJob): AigcMediaRenderJob {
  return { ...render };
}

function isProject(value: unknown): value is AigcMediaProject {
  return Boolean(value && typeof value === "object" && "id" in value && typeof value.id === "string"
    && "revision" in value && typeof value.revision === "string" && "kind" in value
    && (value.kind === "video" || value.kind === "audio") && "clips" in value && Array.isArray(value.clips));
}

function isRender(value: unknown): value is AigcMediaRenderJob {
  return Boolean(value && typeof value === "object" && "id" in value && typeof value.id === "string"
    && "projectId" in value && typeof value.projectId === "string" && "status" in value && typeof value.status === "string");
}
