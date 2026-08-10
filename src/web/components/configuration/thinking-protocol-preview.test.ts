import { describe, expect, it } from "vitest";
import { getThinkingProtocolPreview, thinkingProtocolOptions } from "./thinking-protocol-preview";

describe("思考协议参数预览", () => {
  const model = { compat: {}, thinkingLevelMap: {} };

  it("列出 Pi 当前支持的全部思考协议", () => {
    expect(thinkingProtocolOptions.map((option) => option.value)).toEqual([
      "auto",
      "openai",
      "openrouter",
      "deepseek",
      "together",
      "baseten",
      "zai",
      "qwen",
      "qwen-chat-template",
      "chat-template",
      "string-thinking",
      "ant-ling",
    ]);
  });

  it("按最外层结构预览 Qwen Chat Template 的开启和关闭参数", () => {
    expect(getThinkingProtocolPreview("qwen-chat-template", model)).toEqual({
      enabled: { json: { chat_template_kwargs: { enable_thinking: true, preserve_thinking: true } } },
      disabled: { json: { chat_template_kwargs: { enable_thinking: false, preserve_thinking: true } } },
    });
  });

  it("预览具有固定开关字段的协议", () => {
    expect(getThinkingProtocolPreview("qwen", model)).toEqual({
      enabled: { json: { enable_thinking: true } },
      disabled: { json: { enable_thinking: false } },
    });
    expect(getThinkingProtocolPreview("zai", model)).toEqual({
      enabled: { json: { thinking: { type: "enabled", clear_thinking: false } } },
      disabled: { json: { thinking: { type: "disabled" } } },
    });
    expect(getThinkingProtocolPreview("deepseek", model)).toEqual({
      enabled: { json: { thinking: { type: "enabled" } } },
      disabled: { json: { thinking: { type: "disabled" } } },
    });
    expect(getThinkingProtocolPreview("together", model)).toEqual({
      enabled: { json: { reasoning: { enabled: true } } },
      disabled: { json: { reasoning: { enabled: false } } },
    });
  });

  it("按当前思考映射预览档位形式的协议", () => {
    expect(getThinkingProtocolPreview("openrouter", model)).toEqual({
      enabled: { json: { reasoning: { effort: "high" } } },
      disabled: { json: { reasoning: { effort: "none" } } },
    });
    expect(getThinkingProtocolPreview("string-thinking", {
      compat: {},
      thinkingLevelMap: { high: "intensive", off: "disabled" },
    })).toEqual({
      enabled: { json: { thinking: "intensive" } },
      disabled: { json: { thinking: "disabled" } },
    });
  });

  it("在明确支持推理强度时预览 Pi 会追加的 reasoning_effort", () => {
    expect(getThinkingProtocolPreview("qwen", {
      compat: { supportsReasoningEffort: true },
      thinkingLevelMap: { high: "intensive" },
    }).enabled).toEqual({ json: { enable_thinking: true, reasoning_effort: "intensive" } });
    expect(getThinkingProtocolPreview("zai", {
      compat: { supportsReasoningEffort: true },
      thinkingLevelMap: { high: "intensive" },
    }).enabled).toEqual({ json: { thinking: { type: "enabled", clear_thinking: false }, reasoning_effort: "intensive" } });
    expect(getThinkingProtocolPreview("deepseek", {
      compat: { supportsReasoningEffort: true },
      thinkingLevelMap: { high: "intensive" },
    }).enabled).toEqual({ json: { thinking: { type: "enabled" }, reasoning_effort: "intensive" } });
    expect(getThinkingProtocolPreview("together", {
      compat: { supportsReasoningEffort: true },
      thinkingLevelMap: { high: "intensive" },
    }).enabled).toEqual({ json: { reasoning: { enabled: true }, reasoning_effort: "intensive" } });
  });

  it("按 Pi 的空值回退规则处理开启和关闭映射", () => {
    expect(getThinkingProtocolPreview("openrouter", {
      compat: {},
      thinkingLevelMap: { high: null, off: null },
    })).toEqual({
      enabled: { json: { reasoning: { effort: "high" } } },
      disabled: { note: "当前“off”映射标记为不支持，Pi 不会追加关闭思考参数。" },
    });
    expect(getThinkingProtocolPreview("string-thinking", {
      compat: {},
      thinkingLevelMap: { high: null, off: null },
    })).toEqual({
      enabled: { json: { thinking: "high" } },
      disabled: { note: "当前“off”映射标记为不支持，Pi 不会追加关闭思考参数。" },
    });
  });

  it("对依赖其他兼容配置的协议说明预览前提", () => {
    for (const protocol of ["openai", "baseten", "chat-template", "ant-ling"] as const) {
      const preview = getThinkingProtocolPreview(protocol, model);
      expect(preview.enabled.json).toBeUndefined();
      expect(preview.disabled.json).toBeUndefined();
      expect(preview.enabled.note).toBeTruthy();
      expect(preview.disabled.note).toBeTruthy();
    }
  });
});
