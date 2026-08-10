import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import sharp from "sharp";

test("按指定像素裁掉截图顶部和底部", async () => {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "bugpaw-screenshot-crop-"));
  const inputPath = path.join(temporaryDirectory, "input.png");
  const outputPath = path.join(temporaryDirectory, "output.png");

  try {
    const pixels = Buffer.from([
      255, 0, 0, 255, 0, 0,
      0, 255, 0, 0, 255, 0,
      0, 0, 255, 0, 0, 255,
      255, 255, 0, 255, 255, 0,
      255, 0, 255, 255, 0, 255,
      0, 255, 255, 0, 255, 255,
    ]);

    await sharp(pixels, { raw: { width: 2, height: 6, channels: 3 } })
      .png()
      .toFile(inputPath);

    execFileSync(
      process.execPath,
      [
        "tools/screenshots/crop.mjs",
        "--input",
        inputPath,
        "--output",
        outputPath,
        "--top",
        "1",
        "--bottom",
        "2",
      ],
      { cwd: process.cwd(), stdio: "pipe" },
    );

    const { data, info } = await sharp(outputPath).raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 2);
    assert.equal(info.height, 3);
    assert.deepEqual([...data.subarray(0, 6)], [0, 255, 0, 0, 255, 0]);
    assert.deepEqual([...data.subarray(data.length - 6)], [255, 255, 0, 255, 255, 0]);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
