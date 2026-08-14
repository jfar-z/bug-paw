import { describe, expect, it } from "vitest";

import { MAX_AVATAR_SOURCE_BYTES } from "../../../shared/avatar-contracts";
import { validateAvatarFile } from "./avatar-file";

describe("头像原图前端校验", () => {
  it("接受 PNG、JPEG 和 WebP 原图", () => {
    expect(validateAvatarFile(new File(["x"], "a.png", { type: "image/png" }))).toBeUndefined();
    expect(validateAvatarFile(new File(["x"], "a.jpg", { type: "image/jpeg" }))).toBeUndefined();
    expect(validateAvatarFile(new File(["x"], "a.webp", { type: "image/webp" }))).toBeUndefined();
  });

  it("拒绝不支持的文件类型", () => {
    expect(validateAvatarFile(new File(["x"], "a.gif", { type: "image/gif" })))
      .toBe("仅支持 PNG、JPEG 或 WebP 图片");
  });

  it("拒绝超过 20 MiB 的原图", () => {
    const file = new File([new Uint8Array(MAX_AVATAR_SOURCE_BYTES + 1)], "a.png", { type: "image/png" });

    expect(validateAvatarFile(file)).toBe("原图不能超过 20 MB");
  });
});
