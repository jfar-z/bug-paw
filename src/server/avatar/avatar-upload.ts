import type { FastifyRequest } from "fastify";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

import { MAX_AVATAR_SOURCE_BYTES, type AvatarCropArea } from "../../shared/avatar-contracts";
import { DomainError } from "../core/errors";
import { parseAvatarCrop } from "./avatar-image-processor";

/** 已落入私有临时目录的头像上传，调用方必须在 finally 中清理。 */
export interface ReceivedAvatarUpload {
  sourcePath: string;
  crop: AvatarCropArea;
  cleanup(): Promise<void>;
}

/** 流式接收头像原图和裁剪坐标，避免把最大 20 MiB 原图整体保留在内存。 */
export async function receiveAvatarUpload(request: FastifyRequest): Promise<ReceivedAvatarUpload> {
  if (!request.isMultipart()) {
    throw new DomainError("INVALID_MULTIPART", "请使用 multipart/form-data 上传头像");
  }

  const directory = await mkdtemp(join(tmpdir(), "bug-paw-avatar-upload-"));
  await chmod(directory, 0o700);
  const sourcePath = join(directory, "source");
  let cropValue: string | undefined;
  let receivedFile = false;

  try {
    for await (const part of request.parts({
      limits: { files: 1, fields: 1, parts: 2, fileSize: MAX_AVATAR_SOURCE_BYTES },
    })) {
      if (part.type === "file") {
        if (part.fieldname !== "avatar" || receivedFile) throw invalidMultipart();
        receivedFile = true;
        await pipeline(part.file, createWriteStream(sourcePath, { flags: "wx", mode: 0o600 }));
        if (part.file.truncated) {
          throw new DomainError("AVATAR_TOO_LARGE", "原图不能超过 20 MB");
        }
        continue;
      }
      if (part.fieldname !== "crop" || typeof part.value !== "string" || cropValue !== undefined) {
        throw invalidMultipart();
      }
      cropValue = part.value;
    }

    if (!receivedFile) throw new DomainError("AVATAR_REQUIRED", "请选择头像图片");
    const crop = parseAvatarCrop(cropValue ?? "");
    return {
      sourcePath,
      crop,
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw normalizeMultipartError(error);
  }
}

function normalizeMultipartError(error: unknown): unknown {
  if (error instanceof DomainError) return error;
  const code = errorCode(error);
  if (code === "FST_REQ_FILE_TOO_LARGE") {
    return new DomainError("AVATAR_TOO_LARGE", "原图不能超过 20 MB", undefined, { cause: error });
  }
  if (code === "FST_FILES_LIMIT" || code === "FST_FIELDS_LIMIT" || code === "FST_PARTS_LIMIT") {
    return invalidMultipart(error);
  }
  if (code === "FST_INVALID_MULTIPART_CONTENT_TYPE" || code === "FST_MULTIPART_PREMATURE_CLOSE") {
    return invalidMultipart(error);
  }
  if (error instanceof Error && /unexpected end of form|premature close/iu.test(error.message)) {
    return invalidMultipart(error);
  }
  return error;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function invalidMultipart(cause?: unknown): DomainError {
  return new DomainError(
    "INVALID_MULTIPART",
    "头像上传格式无效",
    undefined,
    cause === undefined ? undefined : { cause },
  );
}
