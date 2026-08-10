#!/usr/bin/env node

import path from "node:path";

import sharp from "sharp";

/**
 * 读取命令行中的命名参数。
 *
 * @param {string[]} argumentsList 命令行参数
 * @returns {Map<string, string>} 参数名称与值
 */
function parseArguments(argumentsList) {
  const values = new Map();

  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1];

    if (!name?.startsWith("--") || value === undefined) {
      throw new Error("参数必须使用 --名称 值 的格式");
    }

    values.set(name.slice(2), value);
  }

  return values;
}

/**
 * 将参数转换为非负整数像素值。
 *
 * @param {string | undefined} value 参数值
 * @param {string} name 参数名称
 * @returns {number} 像素值
 */
function parsePixels(value, name) {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new Error(`--${name} 必须是非负整数`);
  }

  return Number(value);
}

/**
 * 裁剪截图并输出不含原始元数据的 PNG 文件。
 *
 * @param {{input: string, output: string, top: number, bottom: number}} options 裁剪选项
 * @returns {Promise<void>}
 */
async function cropScreenshot({ input, output, top, bottom }) {
  const image = sharp(input);
  const metadata = await image.metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error("无法读取输入图片尺寸");
  }

  const height = metadata.height - top - bottom;
  if (height <= 0) {
    throw new Error("顶部与底部裁剪像素之和必须小于图片高度");
  }

  await image
    .extract({ left: 0, top, width: metadata.width, height })
    .png()
    .toFile(output);
}

async function main() {
  const argumentsMap = parseArguments(process.argv.slice(2));
  const input = argumentsMap.get("input");
  const output = argumentsMap.get("output");

  if (!input || !output) {
    throw new Error("必须提供 --input 和 --output");
  }

  if (path.resolve(input) === path.resolve(output)) {
    throw new Error("输出路径不能覆盖输入图片");
  }

  await cropScreenshot({
    input,
    output,
    top: parsePixels(argumentsMap.get("top"), "top"),
    bottom: parsePixels(argumentsMap.get("bottom"), "bottom"),
  });
}

main().catch((error) => {
  console.error(`截图裁剪失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
