import { describe, expect, it } from "vitest";

import {
  formatTtsCustomParameters,
  parseTtsCustomParametersText,
} from "./tts-custom-parameters-form";

describe("TTS 自定义参数表单助手", () => {
  it("以两个空格格式化对象并解析为结构化参数", () => {
    expect(formatTtsCustomParameters({ instructions: "愉快" }))
      .toBe('{\n  "instructions": "愉快"\n}');
    expect(parseTtsCustomParametersText('{"speed":1.1}')).toEqual({ speed: 1.1 });
  });

  it("把缺失参数格式化为空对象", () => {
    expect(formatTtsCustomParameters(undefined)).toBe("{}");
  });

  it("为 JSON 语法错误提供稳定提示", () => {
    expect(() => parseTtsCustomParametersText("{")).toThrow("必须是有效的 JSON");
  });

  it("复用共享规则拒绝非对象和受保护字段", () => {
    expect(() => parseTtsCustomParametersText("[1]")).toThrow("必须是 JSON 对象");
    expect(() => parseTtsCustomParametersText('{"input":"覆盖"}')).toThrow("不能覆盖 input");
  });
});
