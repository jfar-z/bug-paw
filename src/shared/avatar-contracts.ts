/** 头像原图允许上传的最大字节数。 */
export const MAX_AVATAR_SOURCE_BYTES = 20 * 1024 * 1024;

/** 标准化头像允许持久化的最大字节数。 */
export const MAX_AVATAR_OUTPUT_BYTES = 2 * 1024 * 1024;

/** 头像原图允许解码的最大像素数。 */
export const MAX_AVATAR_INPUT_PIXELS = 64_000_000;

/** 浏览器按视觉方向提交的百分比裁剪区域。 */
export interface AvatarCropArea {
  x: number;
  y: number;
  width: number;
  height: number;
}
