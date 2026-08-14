// @vitest-environment node

import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MAX_AVATAR_SOURCE_BYTES, type AvatarCropArea } from "../../shared/avatar-contracts";
import { registerApiErrorHandler } from "../http/error-handler";
import { receiveAvatarUpload } from "./avatar-upload";

describe("头像 multipart 接收", () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];
  let png = Buffer.alloc(0);

  beforeEach(async () => {
    png = await sharp({ create: { width: 32, height: 32, channels: 4, background: "#336699cc" } })
      .png()
      .toBuffer();
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it.each(["crop-first", "file-first"] as const)("接受 %s 的字段顺序并在处理后清理临时文件", async (order) => {
    const app = await fixture();
    const boundary = `avatar-order-${order}`;
    const crop = { x: 10, y: 0, width: 80, height: 80 };

    const response = await app.inject({
      method: "POST",
      url: "/upload",
      headers: multipartHeaders(boundary),
      payload: avatarMultipart(boundary, png, crop, order),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ size: png.byteLength, crop });
    await expect(stat(response.json().sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("缺少头像文件时返回稳定错误并清理临时目录", async () => {
    await expectUploadError(
      fieldOnlyMultipart("avatar-missing-file", "crop", JSON.stringify(fullCrop())),
      "avatar-missing-file",
      "AVATAR_REQUIRED",
    );
  });

  it("缺少裁剪字段时返回稳定错误并清理临时目录", async () => {
    await expectUploadError(
      fileOnlyMultipart("avatar-missing-crop", "avatar", png),
      "avatar-missing-crop",
      "INVALID_AVATAR_CROP",
    );
  });

  it("拒绝重复头像文件", async () => {
    const boundary = "avatar-two-files";
    const payload = multipartBody(boundary, [
      filePart("avatar", "one.png", "image/png", png),
      filePart("avatar", "two.png", "image/png", png),
      fieldPart("crop", JSON.stringify(fullCrop())),
    ]);
    await expectUploadError(payload, boundary, "INVALID_MULTIPART");
  });

  it("拒绝未知文件字段", async () => {
    const boundary = "avatar-unknown-file";
    const payload = multipartBody(boundary, [
      filePart("photo", "avatar.png", "image/png", png),
      fieldPart("crop", JSON.stringify(fullCrop())),
    ]);
    await expectUploadError(payload, boundary, "INVALID_MULTIPART");
  });

  it("拒绝无效裁剪 JSON", async () => {
    const boundary = "avatar-invalid-crop";
    const payload = multipartBody(boundary, [
      filePart("avatar", "avatar.png", "image/png", png),
      fieldPart("crop", "{"),
    ]);
    await expectUploadError(payload, boundary, "INVALID_AVATAR_CROP");
  });

  it("超过 20 MiB 时返回体积错误并清理部分文件", async () => {
    const boundary = "avatar-too-large";
    const payload = avatarMultipart(
      boundary,
      Buffer.alloc(MAX_AVATAR_SOURCE_BYTES + 1, 1),
      fullCrop(),
      "file-first",
    );
    await expectUploadError(payload, boundary, "AVATAR_TOO_LARGE", 413);
  });

  it("拒绝非 multipart 请求且不创建临时目录", async () => {
    const app = await fixture();
    const before = await avatarTempDirectories();

    const response = await app.inject({ method: "POST", url: "/upload" });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_MULTIPART");
    expect(await avatarTempDirectories()).toEqual(before);
  });

  async function fixture() {
    const app = Fastify();
    apps.push(app);
    await app.register(multipart);
    registerApiErrorHandler(app);
    app.post("/upload", async (request, reply) => {
      const upload = await receiveAvatarUpload(request);
      let result: { size: number; crop: AvatarCropArea; sourcePath: string };
      try {
        const size = (await stat(upload.sourcePath)).size;
        result = { size, crop: upload.crop, sourcePath: upload.sourcePath };
      } finally {
        await upload.cleanup();
      }
      return reply.send(result);
    });
    await app.ready();
    return app;
  }

  async function expectUploadError(payload: Buffer, boundary: string, code: string, statusCode = 400) {
    const app = await fixture();
    const before = await avatarTempDirectories();
    const response = await app.inject({
      method: "POST",
      url: "/upload",
      headers: multipartHeaders(boundary),
      payload,
    });

    expect(response.statusCode).toBe(statusCode);
    expect(response.json().error.code).toBe(code);
    expect(await avatarTempDirectories()).toEqual(before);
  }
});

function fullCrop(): AvatarCropArea {
  return { x: 0, y: 0, width: 100, height: 100 };
}

function multipartHeaders(boundary: string): Record<string, string> {
  return { "content-type": `multipart/form-data; boundary=${boundary}` };
}

function avatarMultipart(
  boundary: string,
  content: Buffer,
  crop: AvatarCropArea,
  order: "crop-first" | "file-first",
): Buffer {
  const parts = [
    filePart("avatar", "avatar.png", "image/png", content),
    fieldPart("crop", JSON.stringify(crop)),
  ];
  return multipartBody(boundary, order === "file-first" ? parts : parts.toReversed());
}

function fieldOnlyMultipart(boundary: string, name: string, value: string): Buffer {
  return multipartBody(boundary, [fieldPart(name, value)]);
}

function fileOnlyMultipart(boundary: string, name: string, content: Buffer): Buffer {
  return multipartBody(boundary, [filePart(name, "avatar.png", "image/png", content)]);
}

function multipartBody(boundary: string, parts: Buffer[]): Buffer {
  return Buffer.concat([
    ...parts.flatMap((part) => [Buffer.from(`--${boundary}\r\n`), part, Buffer.from("\r\n")]),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
}

function fieldPart(name: string, value: string): Buffer {
  return Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n${value}`);
}

function filePart(name: string, filename: string, mediaType: string, content: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n`
      + `Content-Type: ${mediaType}\r\n\r\n`,
    ),
    content,
  ]);
}

async function avatarTempDirectories(): Promise<string[]> {
  return (await readdir(tmpdir()))
    .filter((name) => name.startsWith("bug-paw-avatar-upload-"))
    .sort();
}
