import { describe, expect, it } from "vitest";

import {
  isTtsResponseFormat,
  normalizeTtsCustomParameters,
  readTtsCustomParameters,
} from "./tts-custom-parameters";

describe("TTS 自定义请求参数", () => {
  it("保留合法的嵌套 JSON 参数", () => {
    const source = {
      instructions: "开心",
      speed: 1.2,
      emotion: { name: "warm", intensity: 0.8 },
      tags: ["zh-CN", "story"],
    };

    const normalized = normalizeTtsCustomParameters(source);

    expect(normalized).toEqual(source);
    expect(normalized).not.toBe(source);
  });

  it("拒绝非对象与受保护的 input 字段", () => {
    expect(() => normalizeTtsCustomParameters(null)).toThrow("必须是 JSON 对象");
    expect(() => normalizeTtsCustomParameters([])).toThrow("必须是 JSON 对象");
    expect(() => normalizeTtsCustomParameters("instructions")).toThrow("必须是 JSON 对象");
    expect(() => normalizeTtsCustomParameters({ input: "替换文本" })).toThrow("不能覆盖 input");
  });

  it("仅允许应用支持的 response_format", () => {
    expect(isTtsResponseFormat("pcm")).toBe(true);
    expect(isTtsResponseFormat("flac")).toBe(false);
    expect(() => normalizeTtsCustomParameters({ response_format: "flac" })).toThrow("response_format 无效");
  });

  it("按 UTF-8 字节限制参数体积并拒绝不可序列化对象", () => {
    expect(() => normalizeTtsCustomParameters({ instructions: "好".repeat(6_000) })).toThrow("不能超过 16 KiB");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => normalizeTtsCustomParameters(cyclic)).toThrow("必须可序列化为 JSON");
  });

  it("读取历史配置时把缺失或非法参数降级为空对象", () => {
    expect(readTtsCustomParameters(undefined)).toEqual({});
    expect(readTtsCustomParameters({ input: "历史错误值" })).toEqual({});
    expect(readTtsCustomParameters({ instructions: "保留" })).toEqual({ instructions: "保留" });
  });
});
