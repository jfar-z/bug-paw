import type { AigcOpenAiInterfaceConfig, AigcOpenAiParameterDefinition } from "./aigc-contracts";

/** OpenAI 适配器自行管理、不可由自定义参数覆盖的字段。 */
export const AIGC_OPENAI_RESERVED_PARAMETER_NAMES = new Set(["model", "prompt", "image"]);

/** 为新建 OpenAI 接口提供尺寸与质量参数模板。 */
export function createDefaultOpenAiParameters(): AigcOpenAiParameterDefinition[] {
  return [
    {
      name: "size",
      type: "string",
      description: "输出图片尺寸；可按渠道要求改名，或拆分为 width、height。",
    },
    {
      name: "quality",
      type: "string",
      enumValues: ["auto", "low", "medium", "high", "standard", "hd"],
      description: "输出质量；具体可选值由模型和渠道决定。",
    },
  ];
}

/** 读取新参数定义，并将旧版固定字段转换为等价定义。 */
export function resolveOpenAiParameterDefinitions(config: AigcOpenAiInterfaceConfig): AigcOpenAiParameterDefinition[] {
  if (Array.isArray(config.parameters)) return config.parameters.map(copyParameterDefinition);
  const parameters = createDefaultOpenAiParameters();
  if (config.size) parameters[0].defaultValue = config.size;
  if (config.quality) parameters[1].defaultValue = config.quality;
  if (config.responseFormat) {
    parameters.push({
      name: "response_format",
      type: "string",
      enumValues: ["url", "b64_json"],
      defaultValue: config.responseFormat,
      description: "旧版响应格式配置。",
    });
  }
  return parameters;
}

/** 深复制参数定义，避免编辑表单修改服务端返回对象。 */
export function copyParameterDefinition(parameter: AigcOpenAiParameterDefinition): AigcOpenAiParameterDefinition {
  return {
    ...parameter,
    ...(parameter.enumValues ? { enumValues: [...parameter.enumValues] } : {}),
  };
}
