import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rm, stat } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { AigcUploadedAsset } from "../../shared/aigc-contracts";

const MAX_INPUT_ASSET_BYTES = 200 * 1024 * 1024;

/** 管理 AIGC 临时入参与执行产物文件。 */
export class AigcAssetService {
  private readonly inputDir: string;
  private readonly outputRoot: string;

  /**
   * @param rootDir AIGC 资产根目录
   */
  constructor(rootDir: string) {
    this.inputDir = join(rootDir, "inputs");
    this.outputRoot = join(rootDir, "outputs");
  }

  /** 保存浏览器上传的图片或视频入参。 */
  async saveInput(stream: Readable, fileName: string, mediaType: string): Promise<AigcUploadedAsset> {
    const id = randomUUID();
    await mkdir(this.inputDir, { recursive: true, mode: 0o700 });
    const safeName = sanitizeFileName(fileName);
    const target = join(this.inputDir, id);
    await writeStream(stream, target);
    try {
      const fileStat = await stat(target);
      if (fileStat.size > MAX_INPUT_ASSET_BYTES) {
        await rm(target, { force: true });
        throw new TypeError("AIGC 入参文件不能超过 200 MiB");
      }
      return { id, name: safeName, mediaType: normalizeMediaType(mediaType, safeName), size: fileStat.size };
    } catch (error) {
      await rm(target, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** 保存执行产物并返回可持久化到任务的资产摘要。 */
  async saveOutput(taskId: string, content: Buffer, fileName: string, mediaType: string) {
    const id = randomUUID();
    const dir = join(this.outputRoot, safeSegment(taskId));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const safeName = sanitizeFileName(fileName);
    const target = join(dir, id);
    const handle = await open(target, "wx", 0o600);
    try {
      await handle.writeFile(content);
    } finally {
      await handle.close();
    }
    const fileStat = await stat(target);
    return {
      id,
      name: safeName,
      mediaType: normalizeMediaType(mediaType, safeName),
      size: fileStat.size,
      createdAt: new Date().toISOString(),
    };
  }

  /** 解析入参文件路径，禁止越界。 */
  async resolveInputPath(id: string): Promise<string | undefined> {
    return resolveAssetPath(this.inputDir, id);
  }

  /** 解析任务产物文件路径，禁止越界。 */
  async resolveOutputPath(taskId: string, id: string): Promise<string | undefined> {
    return resolveAssetPath(join(this.outputRoot, safeSegment(taskId)), id);
  }

  /** 返回产物读取流。 */
  openOutput(taskId: string, id: string) {
    void taskId;
    void id;
    throw new Error("请通过 resolveOutputPath 读取文件");
  }
}

/** 将流写入目标文件，失败时清理残留。 */
async function writeStream(stream: Readable, target: string): Promise<void> {
  const handle = await open(target, "wx", 0o600);
  try {
    await pipeline(stream, handle.createWriteStream());
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(target, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 读取固定目录内的随机 ID 文件路径。 */
async function resolveAssetPath(directory: string, id: string): Promise<string | undefined> {
  if (!validAssetId(id)) return undefined;
  const target = resolve(directory, id);
  const root = resolve(directory);
  if (target !== root && !target.startsWith(`${root}${sep}`)) return undefined;
  try {
    const fileStat = await stat(target);
    return fileStat.isFile() ? target : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** 清理任务产物目录，供删除任务或重试失败时使用。 */
export async function removeOutputDirectory(rootDir: string, taskId: string): Promise<void> {
  const dir = join(rootDir, "outputs", safeSegment(taskId));
  await rm(dir, { recursive: true, force: true });
}

function validAssetId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u.test(value);
}

function safeSegment(value: string): string {
  if (!validAssetId(value)) throw new TypeError("AIGC 资产标识无效");
  return value;
}

/** 净化为可读且不可跨目录的文件名。 */
function sanitizeFileName(input: string): string {
  const crossPlatformBase = basename(input.replaceAll("\\", "/"));
  const normalized = crossPlatformBase
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^\p{L}\p{N} ._()-]+/gu, "-")
    .replace(/\s+/g, " ")
    .replace(/^[. -]+|[. -]+$/g, "")
    .slice(0, 160);
  return normalized || "aigc-asset";
}

function normalizeMediaType(value: string, filePath: string): string {
  return /^[\w.+-]+\/[\w.+-]+$/.test(value)
    ? value.toLowerCase()
    : filePath.endsWith(".png") ? "image/png"
    : filePath.endsWith(".jpg") || filePath.endsWith(".jpeg") ? "image/jpeg"
    : filePath.endsWith(".webp") ? "image/webp"
    : filePath.endsWith(".mp4") ? "video/mp4"
    : "application/octet-stream";
}
