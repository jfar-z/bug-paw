import { MAX_AVATAR_SOURCE_BYTES } from "../../../shared/avatar-contracts";

const AVATAR_MIME_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/webp"]);

/** 在进入裁剪器前快速拒绝不支持或超过原图上限的文件。 */
export function validateAvatarFile(file: File): string | undefined {
  if (!AVATAR_MIME_TYPES.has(file.type)) {
    return "仅支持 PNG、JPEG 或 WebP 图片";
  }
  return file.size > MAX_AVATAR_SOURCE_BYTES ? "原图不能超过 20 MB" : undefined;
}
