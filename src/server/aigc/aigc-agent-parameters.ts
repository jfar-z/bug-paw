import type { AigcInterfaceRecord, AigcOpenAiInterfaceConfig, AigcWorkflowDetail } from "../../shared/aigc-contracts";
import { resolveOpenAiParameterDefinitions } from "../../shared/aigc-openai-parameters";
import { resolveWorkflowFieldMetadata } from "../../shared/aigc-workflow-field-metadata";

/** Agent 可见字段，只包含业务参数，不暴露原始工作流或渠道地址。 */
export interface AigcAgentField {
  name: string;
  type: "string" | "integer" | "number" | "boolean" | "enum" | "image" | "video" | "audio";
  required: boolean;
  description?: string;
  defaultValue?: string | number | boolean;
  enumValues?: (string | number | boolean)[];
  min?: number;
  max?: number;
  source?: "workspace" | "url";
}

/** 固定形状的参数项，避免向 Provider 发送动态 Record Schema。 */
export interface AigcAgentParameter {
  name: string;
  text?: string;
  number?: number;
  boolean?: boolean;
  path?: string;
  url?: string;
}

/** 从既有接口定义提取稳定字段，并保留真实默认值及数值约束。 */
export function agentFields(item: AigcInterfaceRecord, workflow?: AigcWorkflowDetail): AigcAgentField[] {
  if (item.protocol === "comfyui") {
    if (!workflow) throw new TypeError("ComfyUI 工作流不存在");
    const metadata = resolveWorkflowFieldMetadata(workflow);
    const fields = workflow.inputMappings.map((mapping): AigcAgentField => {
      const constraints = metadata[mapping.nodeId]?.[mapping.field];
      if (constraints?.conflict) throw new TypeError("工作流参数约束冲突，请在 AIGC 工作台修复");
      const type = mapping.type === "bool" ? "boolean" : mapping.type === "int" ? "integer"
        : mapping.type === "double" ? "number" : mapping.type;
      return {
        name: mapping.name, type, required: mapping.required, description: mapping.description,
        defaultValue: mapping.defaultValue,
        enumValues: constraints?.enumOptions ?? mapping.enumOptions,
        min: constraints?.min, max: constraints?.max,
        ...(["image", "video", "audio"].includes(type) ? { source: "workspace" as const } : {}),
      };
    });
    if (new Set(fields.map((field) => field.name)).size !== fields.length) throw new TypeError("工作流参数名称重复");
    return fields;
  }
  const fields: AigcAgentField[] = [{ name: "prompt", type: "string", required: item.capability !== "video-extend" }];
  if (["image-edit", "image-to-video"].includes(item.capability)) {
    fields.push({ name: "image", type: "image", required: true, source: item.protocol === "grok" ? "url" : "workspace" });
  }
  if (["video-edit", "video-extend"].includes(item.capability)) {
    fields.push({ name: "video", type: "video", required: true, source: "url" });
  }
  if (item.protocol === "openai") {
    return [...fields, ...resolveOpenAiParameterDefinitions(item.config as AigcOpenAiInterfaceConfig).map((parameter) => ({
      ...parameter, required: false,
    }))];
  }
  const config = item.config as { size?: string; duration?: number };
  if (item.capability === "text-to-image") fields.push({ name: "count", type: "integer", required: false, defaultValue: 1, min: 1, max: 10 });
  if (["text-to-image", "image-edit", "text-to-video", "image-to-video"].includes(item.capability)) {
    fields.push({ name: "size", type: "string", required: false, defaultValue: config.size });
  }
  if (item.capability.includes("video")) fields.push({ name: "duration", type: "integer", required: false, defaultValue: config.duration, min: 1, max: 300 });
  return fields;
}

/** 校验所有参数后才允许上传文件或创建计费任务。 */
export function validateAgentParameters(fields: AigcAgentField[], parameters: AigcAgentParameter[]): Record<string, string | number | boolean> {
  if (!Array.isArray(parameters) || parameters.length > 100 || Buffer.byteLength(JSON.stringify(parameters), "utf8") > 128 * 1024) {
    throw new TypeError("AIGC 参数最多 100 项且不能超过 128 KiB");
  }
  const values: Record<string, string | number | boolean> = Object.create(null);
  const fieldsByName = new Map(fields.map((field) => [field.name, field]));
  for (const parameter of parameters) {
    if (!parameter || typeof parameter !== "object") throw new TypeError("参数必须为字段项");
    const field = fieldsByName.get(parameter.name);
    if (!field || Object.hasOwn(values, parameter.name)) throw new TypeError("参数名称无效或重复");
    const keys = Object.keys(parameter).filter((key) => key !== "name" && parameter[key as keyof AigcAgentParameter] !== undefined);
    const expected = field.source === "workspace" ? "path" : field.source === "url" ? "url"
      : field.type === "enum" ? (typeof parameter.text === "string" ? "text" : typeof parameter.boolean === "boolean" ? "boolean" : "number")
      : field.type === "string" ? "text" : field.type === "boolean" ? "boolean" : "number";
    if (keys.length !== 1 || keys[0] !== expected) throw new TypeError(`参数 ${field.name} 必须且只能提供 ${expected}`);
    const value = parameter[expected];
    if (value === undefined) throw new TypeError("参数值缺失");
    values[field.name] = value;
  }
  for (const field of fields) {
    if (!Object.hasOwn(values, field.name) && field.defaultValue !== undefined) values[field.name] = field.defaultValue;
    const value = values[field.name];
    if (value === undefined) {
      if (field.required) throw new TypeError(`缺少必填参数 ${field.name}`);
      continue;
    }
    if (field.source || field.type === "string") {
      if (typeof value !== "string" || value.length > 20_000 || (field.required && !value.trim())) throw new TypeError(`参数 ${field.name} 文本无效`);
    } else if (field.type === "enum") {
      if (!["string", "number", "boolean"].includes(typeof value)) throw new TypeError("枚举值类型无效");
    } else if (field.type === "boolean") {
      if (typeof value !== "boolean") throw new TypeError(`参数 ${field.name} 必须为布尔值`);
    } else if (typeof value !== "number" || !Number.isFinite(value)
      || (field.type === "integer" && !Number.isInteger(value))
      || (field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max)) {
      throw new TypeError(`参数 ${field.name} 数值或范围无效`);
    }
    if (field.enumValues?.length && !field.enumValues.includes(value)) throw new TypeError(`参数 ${field.name} 不在枚举范围内`);
    if (field.source === "url") {
      const url = new URL(String(value));
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new TypeError("媒体 URL 必须为不含凭证或片段的 HTTP(S) 地址");
    }
  }
  return values;
}
