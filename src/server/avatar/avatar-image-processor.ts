import { open } from "node:fs/promises";
import sharp from "sharp";

import {
  MAX_AVATAR_INPUT_PIXELS,
  MAX_AVATAR_OUTPUT_BYTES,
  type AvatarCropArea,
} from "../../shared/avatar-contracts";
import { DomainError } from "../core/errors";

const ENCODING_ATTEMPTS = [
  { size: 512, quality: 82 },
  { size: 512, quality: 72 },
  { size: 512, quality: 62 },
  { size: 448, quality: 62 },
  { size: 384, quality: 62 },
  { size: 320, quality: 62 },
  { size: 256, quality: 62 },
] as const;

const CROP_BOUNDARY_EPSILON = 1e-7;

/** 单次 WebP 编码使用的最大边长和质量。 */
export interface AvatarEncodingAttempt {
  size: number;
  quality: number;
}

/** 测试可注入编码结果，以覆盖稳定的体积降级顺序。 */
export interface AvatarImageProcessorOptions {
  encodeAttempt?: (pipeline: ReturnType<typeof sharp>, attempt: AvatarEncodingAttempt) => Promise<Buffer>;
}

/** 服务端标准化后的头像文件。 */
export interface ProcessedAvatar {
  content: Buffer;
  mediaType: "image/webp";
  width: number;
  height: number;
}

interface PixelCropArea {
  left: number;
  top: number;
  size: number;
}

/** 解析并校验浏览器提交的百分比裁剪区域。 */
export function parseAvatarCrop(value: string): AvatarCropArea {
  let candidate: unknown;
  try {
    candidate = JSON.parse(value);
  } catch {
    throw invalidCrop();
  }
  if (!isRecord(candidate)) throw invalidCrop();
  const { x, y, width, height } = candidate;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) {
    throw invalidCrop();
  }
  return normalizeCrop({ x, y, width, height });
}

/** 校验、裁剪并把头像标准化为受限体积的静态 WebP。 */
export async function processAvatarImage(
  sourcePath: string,
  crop: AvatarCropArea,
  options: AvatarImageProcessorOptions = {},
): Promise<ProcessedAvatar> {
  await assertSupportedImageSignature(sourcePath);
  try {
    const input = sharp(sourcePath, { limitInputPixels: MAX_AVATAR_INPUT_PIXELS, pages: 1 });
    const metadata = await input.metadata();
    const width = metadata.width;
    const height = metadata.height;
    if (!width || !height) throw processingFailed();
    if (width * height > MAX_AVATAR_INPUT_PIXELS) {
      throw new DomainError("AVATAR_TOO_MANY_PIXELS", "头像图片像素过大");
    }

    const visuallyRotated = metadata.orientation !== undefined && metadata.orientation >= 5 && metadata.orientation <= 8;
    const visualWidth = visuallyRotated ? height : width;
    const visualHeight = visuallyRotated ? width : height;
    const pixelCrop = toPixelCrop(crop, visualWidth, visualHeight);
    const basePipeline = sharp(sourcePath, { limitInputPixels: MAX_AVATAR_INPUT_PIXELS, pages: 1 })
      .autoOrient()
      .extract({ left: pixelCrop.left, top: pixelCrop.top, width: pixelCrop.size, height: pixelCrop.size });

    for (const attempt of ENCODING_ATTEMPTS) {
      const pipeline = basePipeline.clone()
        .resize(attempt.size, attempt.size, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: attempt.quality, alphaQuality: 100 });
      const content = options.encodeAttempt
        ? await options.encodeAttempt(pipeline, attempt)
        : await pipeline.toBuffer();
      if (content.byteLength <= MAX_AVATAR_OUTPUT_BYTES) {
        const size = Math.min(pixelCrop.size, attempt.size);
        return { content, mediaType: "image/webp", width: size, height: size };
      }
    }
    throw processingFailed();
  } catch (error) {
    if (error instanceof DomainError) throw error;
    if (isPixelLimitError(error)) {
      throw new DomainError("AVATAR_TOO_MANY_PIXELS", "头像图片像素过大", undefined, { cause: error });
    }
    throw processingFailed(error);
  }
}

/** 只接受 PNG、JPEG 和 WebP，文件扩展名与客户端 MIME 均不作为信任依据。 */
async function assertSupportedImageSignature(sourcePath: string): Promise<void> {
  const handle = await open(sourcePath, "r");
  try {
    const signature = Buffer.alloc(12);
    const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
    const header = signature.subarray(0, bytesRead);
    if (!isPng(header) && !isJpeg(header) && !isWebp(header)) {
      throw new DomainError("INVALID_AVATAR_TYPE", "仅支持 PNG、JPEG 或 WebP 图片");
    }
  } finally {
    await handle.close();
  }
}

function toPixelCrop(crop: AvatarCropArea, width: number, height: number): PixelCropArea {
  const normalizedCrop = normalizeCrop(crop);

  const left = Math.round(width * normalizedCrop.x / 100);
  const top = Math.round(height * normalizedCrop.y / 100);
  const cropWidth = Math.round(width * normalizedCrop.width / 100);
  const cropHeight = Math.round(height * normalizedCrop.height / 100);
  if (Math.abs(cropWidth - cropHeight) > 1) throw invalidCrop();
  const size = Math.min(cropWidth, cropHeight);
  if (size <= 0 || left + size > width || top + size > height) throw invalidCrop();
  return { left, top, size };
}

/** 容忍浏览器百分比换算的极小误差，但不放宽真实越界裁剪。 */
function normalizeCrop(crop: AvatarCropArea): AvatarCropArea {
  if (!Object.values(crop).every(isFiniteNumber)) throw invalidCrop();
  if (crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0) throw invalidCrop();
  const right = crop.x + crop.width;
  const bottom = crop.y + crop.height;
  if (right > 100 + CROP_BOUNDARY_EPSILON || bottom > 100 + CROP_BOUNDARY_EPSILON) throw invalidCrop();
  return {
    ...crop,
    width: right > 100 ? 100 - crop.x : crop.width,
    height: bottom > 100 ? 100 - crop.y : crop.height,
  };
}

function isPng(value: Buffer): boolean {
  return value.length >= 8 && value.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

function isJpeg(value: Buffer): boolean {
  return value.length >= 3 && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff;
}

function isWebp(value: Buffer): boolean {
  return value.length >= 12 && value.subarray(0, 4).toString("ascii") === "RIFF"
    && value.subarray(8, 12).toString("ascii") === "WEBP";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPixelLimitError(error: unknown): boolean {
  return error instanceof Error && /pixel limit|image exceeds/iu.test(error.message);
}

function invalidCrop(): DomainError {
  return new DomainError("INVALID_AVATAR_CROP", "请选择有效的正方形裁剪区域");
}

function processingFailed(cause?: unknown): DomainError {
  return new DomainError(
    "AVATAR_PROCESSING_FAILED",
    "头像图片无法处理，请更换图片后重试",
    undefined,
    cause === undefined ? undefined : { cause },
  );
}
