import type { ThinkingLevelKey } from "../../../shared/configuration-contracts";

export type ThinkingProtocol =
  | "openai"
  | "openrouter"
  | "deepseek"
  | "together"
  | "baseten"
  | "zai"
  | "qwen"
  | "qwen-chat-template"
  | "chat-template"
  | "string-thinking"
  | "ant-ling";

export interface ThinkingProtocolOption {
  value: "auto" | ThinkingProtocol;
  label: string;
}

export interface ThinkingProtocolModel {
  compat: Record<string, unknown>;
  thinkingLevelMap: Partial<Record<ThinkingLevelKey, string | null>>;
}

export interface ThinkingProtocolPreviewItem {
  json?: Record<string, unknown>;
  note?: string;
}

export interface ThinkingProtocolPreview {
  enabled: ThinkingProtocolPreviewItem;
  disabled: ThinkingProtocolPreviewItem;
}

/** Pi 当前内置的思考协议，自动模式不写入 models.json。 */
export const thinkingProtocolOptions: ThinkingProtocolOption[] = [
  { value: "auto", label: "自动（由 Pi 推断）" },
  { value: "openai", label: "OpenAI（openai）" },
  { value: "openrouter", label: "OpenRouter（openrouter）" },
  { value: "deepseek", label: "DeepSeek（deepseek）" },
  { value: "together", label: "Together AI（together）" },
  { value: "baseten", label: "Baseten（baseten）" },
  { value: "zai", label: "智谱 AI（zai）" },
  { value: "qwen", label: "Qwen（qwen）" },
  { value: "qwen-chat-template", label: "Qwen Chat Template（qwen-chat-template）" },
  { value: "chat-template", label: "自定义 Chat Template（chat-template）" },
  { value: "string-thinking", label: "字符串思考参数（string-thinking）" },
  { value: "ant-ling", label: "Ant Ling（ant-ling）" },
];

function conditionalPreview(note: string): ThinkingProtocolPreview {
  return { enabled: { note }, disabled: { note } };
}

function mappedThinkingLevel(model: ThinkingProtocolModel, level: "off" | "high", fallback: string): string | null {
  const mapped = model.thinkingLevelMap[level];
  return mapped === undefined ? fallback : mapped;
}

/**
 * 预览 Pi 根据协议追加的思考参数，而非完整请求体，避免误展示模型或凭证信息。
 */
export function getThinkingProtocolPreview(protocol: ThinkingProtocol, model: ThinkingProtocolModel): ThinkingProtocolPreview {
  switch (protocol) {
    case "qwen":
      return { enabled: { json: { enable_thinking: true } }, disabled: { json: { enable_thinking: false } } };
    case "qwen-chat-template":
      return {
        enabled: { json: { chat_template_kwargs: { enable_thinking: true, preserve_thinking: true } } },
        disabled: { json: { chat_template_kwargs: { enable_thinking: false, preserve_thinking: true } } },
      };
    case "zai":
      return {
        enabled: { json: { thinking: { type: "enabled", clear_thinking: false } } },
        disabled: { json: { thinking: { type: "disabled" } } },
      };
    case "deepseek":
      return {
        enabled: { json: { thinking: { type: "enabled" } } },
        disabled: model.thinkingLevelMap.off === null
          ? { note: "当前“off”映射标记为不支持，Pi 不会追加关闭思考参数。" }
          : { json: { thinking: { type: "disabled" } } },
      };
    case "together":
      return { enabled: { json: { reasoning: { enabled: true } } }, disabled: { json: { reasoning: { enabled: false } } } };
    case "openrouter": {
      const enabled = mappedThinkingLevel(model, "high", "high");
      const disabled = mappedThinkingLevel(model, "off", "none");
      return {
        enabled: enabled === null
          ? { note: "当前“high”映射标记为不支持，Pi 不会追加开启思考参数。" }
          : { json: { reasoning: { effort: enabled } } },
        disabled: disabled === null
          ? { note: "当前“off”映射标记为不支持，Pi 不会追加关闭思考参数。" }
          : { json: { reasoning: { effort: disabled } } },
      };
    }
    case "string-thinking": {
      const enabled = mappedThinkingLevel(model, "high", "high");
      const disabled = mappedThinkingLevel(model, "off", "none");
      return {
        enabled: enabled === null
          ? { note: "当前“high”映射标记为不支持，Pi 不会追加开启思考参数。" }
          : { json: { thinking: enabled } },
        disabled: disabled === null
          ? { note: "当前“off”映射标记为不支持，Pi 不会追加关闭思考参数。" }
          : { json: { thinking: disabled } },
      };
    }
    case "openai":
      return conditionalPreview("该协议是否追加 reasoning_effort 取决于“支持推理强度”和思考等级映射配置。");
    case "baseten":
      return conditionalPreview("该协议需要在高级兼容性中配置 chatTemplateArgs，Pi 才会追加对应参数。");
    case "chat-template":
      return conditionalPreview("该协议需要在高级兼容性中配置 chatTemplateKwargs，Pi 才会追加对应参数。");
    case "ant-ling":
      return conditionalPreview("该协议依赖思考等级映射；仅映射为字符串的开启等级会追加 reasoning.effort 参数。");
  }
}
