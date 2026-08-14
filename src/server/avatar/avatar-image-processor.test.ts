// @vitest-environment node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MAX_AVATAR_OUTPUT_BYTES } from "../../shared/avatar-contracts";
import { parseAvatarCrop, processAvatarImage } from "./avatar-image-processor";

describe("头像图片标准化", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bug-paw-avatar-processor-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("裁剪透明 PNG 并输出保留 Alpha 的静态 WebP", async () => {
    const source = join(root, "transparent.png");
    await sharp({
      create: {
        width: 900,
        height: 600,
        channels: 4,
        background: { r: 30, g: 120, b: 200, alpha: 0.4 },
      },
    }).png().toFile(source);

    const output = await processAvatarImage(source, { x: 25, y: 0, width: 50, height: 75 });
    const metadata = await sharp(output.content).metadata();

    expect(output).toMatchObject({ mediaType: "image/webp", width: 450, height: 450 });
    expect(metadata).toMatchObject({ format: "webp", width: 450, height: 450, hasAlpha: true });
    expect(metadata.pages).toBeUndefined();
    expect(output.content.byteLength).toBeLessThanOrEqual(MAX_AVATAR_OUTPUT_BYTES);
  });

  it("按 EXIF 视觉方向裁剪并移除元数据", async () => {
    const source = join(root, "oriented.jpg");
    await sharp({ create: { width: 200, height: 300, channels: 3, background: "#2554c7" } })
      .composite([{
        input: {
          create: { width: 100, height: 150, channels: 3, background: "#ef233c" },
        },
        left: 0,
        top: 150,
      }])
      .jpeg({ quality: 100, chromaSubsampling: "4:4:4" })
      .withMetadata({ orientation: 6 })
      .toFile(source);

    const output = await processAvatarImage(source, { x: 0, y: 0, width: 50, height: 75 });
    const metadata = await sharp(output.content).metadata();
    const { data, info } = await sharp(output.content).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const centerOffset = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * info.channels;

    expect(output).toMatchObject({ width: 150, height: 150 });
    expect(data[centerOffset]).toBeGreaterThan(200);
    expect(data[centerOffset + 2]).toBeLessThan(90);
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
  });

  it("不会放大小于输出上限的裁剪结果", async () => {
    const source = join(root, "small.webp");
    await sharp({ create: { width: 160, height: 120, channels: 3, background: "#ef8354" } })
      .webp()
      .toFile(source);

    const output = await processAvatarImage(source, { x: 12.5, y: 0, width: 75, height: 100 });

    expect(output).toMatchObject({ width: 120, height: 120 });
    await expect(sharp(output.content).metadata()).resolves.toMatchObject({ width: 120, height: 120 });
  });

  it("动画 WebP 只输出第一帧", async () => {
    const source = join(root, "animated.webp");
    const firstFrame = Buffer.alloc(40 * 40 * 3, 10);
    const secondFrame = Buffer.alloc(40 * 40 * 3, 240);
    await sharp(Buffer.concat([firstFrame, secondFrame]), {
      raw: { width: 40, height: 80, channels: 3, pageHeight: 40 },
    }).webp({ loop: 0, delay: [100, 100] }).toFile(source);

    const output = await processAvatarImage(source, { x: 0, y: 0, width: 100, height: 100 });
    const metadata = await sharp(output.content, { animated: true }).metadata();

    expect(metadata.pages).toBeUndefined();
    expect(output).toMatchObject({ width: 40, height: 40 });
  });

  it.each([
    ["空裁剪", "", "INVALID_AVATAR_CROP"],
    ["无效 JSON", "{", "INVALID_AVATAR_CROP"],
    ["越界裁剪", JSON.stringify({ x: 90, y: 0, width: 20, height: 20 }), "INVALID_AVATAR_CROP"],
    ["零尺寸裁剪", JSON.stringify({ x: 0, y: 0, width: 0, height: 0 }), "INVALID_AVATAR_CROP"],
  ])("拒绝%s", (_name, value, code) => {
    expect(() => parseAvatarCrop(value)).toThrowError(expect.objectContaining({ code }));
  });

  it("容忍裁剪区域贴边时的浮点计算误差", () => {
    const crop = parseAvatarCrop(JSON.stringify({
      x: 33.33333333333334,
      y: 0,
      width: 66.66666666666667,
      height: 66.66666666666667,
    }));

    expect(crop.x + crop.width).toBeLessThanOrEqual(100);
    expect(crop.width).toBeCloseTo(66.66666666666666, 12);
  });

  it("仍拒绝明显超出图片边界的裁剪区域", () => {
    const value = JSON.stringify({ x: 90, y: 0, width: 10.001, height: 10.001 });

    expect(() => parseAvatarCrop(value))
      .toThrowError(expect.objectContaining({ code: "INVALID_AVATAR_CROP" }));
  });

  it("拒绝换算后不是正方形的裁剪区域", async () => {
    const source = join(root, "wide.png");
    await sharp({ create: { width: 800, height: 400, channels: 3, background: "#4f5d75" } })
      .png()
      .toFile(source);

    await expect(processAvatarImage(source, { x: 0, y: 0, width: 50, height: 50 }))
      .rejects.toMatchObject({ code: "INVALID_AVATAR_CROP" });
  });

  it.each([
    ["伪 PNG", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])],
    ["损坏 JPEG", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])],
  ])("拒绝%s", async (_name, content) => {
    const source = join(root, "broken-image");
    await writeFile(source, content);

    await expect(processAvatarImage(source, { x: 0, y: 0, width: 100, height: 100 }))
      .rejects.toMatchObject({ code: "AVATAR_PROCESSING_FAILED" });
  });

  it("拒绝不受支持的图片格式", async () => {
    const source = join(root, "avatar.gif");
    await sharp({ create: { width: 40, height: 40, channels: 3, background: "#222222" } })
      .gif()
      .toFile(source);

    await expect(processAvatarImage(source, { x: 0, y: 0, width: 100, height: 100 }))
      .rejects.toMatchObject({ code: "INVALID_AVATAR_TYPE" });
  });

  it("拒绝超过解码像素上限的图片", async () => {
    const source = join(root, "too-many-pixels.png");
    await sharp({ create: { width: 8_001, height: 8_001, channels: 3, background: "#ffffff" } })
      .png()
      .toFile(source);

    await expect(processAvatarImage(source, { x: 0, y: 0, width: 100, height: 100 }))
      .rejects.toMatchObject({ code: "AVATAR_TOO_MANY_PIXELS" });
  });

  it("按固定质量和尺寸层级降级直到满足 2 MiB", async () => {
    const source = join(root, "fallback.png");
    await sharp({ create: { width: 900, height: 900, channels: 3, background: "#2d3142" } })
      .png()
      .toFile(source);
    const attempts: Array<{ size: number; quality: number }> = [];

    const output = await processAvatarImage(
      source,
      { x: 0, y: 0, width: 100, height: 100 },
      {
        encodeAttempt: async (_pipeline, attempt) => {
          attempts.push(attempt);
          return Buffer.alloc(attempts.length < 4 ? MAX_AVATAR_OUTPUT_BYTES + 1 : 64);
        },
      },
    );

    expect(attempts).toEqual([
      { size: 512, quality: 82 },
      { size: 512, quality: 72 },
      { size: 512, quality: 62 },
      { size: 448, quality: 62 },
    ]);
    expect(output).toMatchObject({ mediaType: "image/webp", width: 448, height: 448 });
  });

  it("所有降级层仍超限时返回稳定处理错误", async () => {
    const source = join(root, "uncompressible.png");
    await sharp({ create: { width: 900, height: 900, channels: 3, background: "#2d3142" } })
      .png()
      .toFile(source);
    const attempts: Array<{ size: number; quality: number }> = [];

    const result = processAvatarImage(
      source,
      { x: 0, y: 0, width: 100, height: 100 },
      {
        encodeAttempt: async (_pipeline, attempt) => {
          attempts.push(attempt);
          return Buffer.alloc(MAX_AVATAR_OUTPUT_BYTES + 1);
        },
      },
    );

    await expect(result).rejects.toMatchObject({ code: "AVATAR_PROCESSING_FAILED" });
    expect(attempts).toHaveLength(7);
  });
});
