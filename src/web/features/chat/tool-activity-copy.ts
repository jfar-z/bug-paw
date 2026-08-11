import type { ToolBlock } from "../../conversation-timeline";

/** 提取工具参数中已完整生成的可靠文件路径。 */
export function toolTargetPath(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined;
  const path = typeof args.path === "string" && args.path ? args.path : args.file_path;
  return typeof path === "string" && path ? path : undefined;
}

/** 根据工具生命周期生成不会误报副作用的活动文案。 */
export function toolActivityCopy(tool: ToolBlock): string {
  const path = toolTargetPath(tool.args);
  if (tool.status === "completed") return appendPath(`${tool.name} 已完成`, path);
  if (tool.status === "cancelled") return appendPath(`${tool.name} 未执行`, path);
  if (tool.status === "error") return appendPath(`${tool.name} 执行失败`, path);

  if (tool.status === "preparing") {
    if (tool.name === "write") return path ? `正在编写 ${path}` : "正在编写文件内容";
    if (tool.name === "edit") return path ? `正在拟定对 ${path} 的修改` : "正在拟定文件修改";
    if (tool.name === "bash") return "正在组织命令";
    if (tool.name === "read") return path ? `正在确定读取 ${path}` : "正在确定读取目标";
    return `正在生成 ${tool.name} 的调用参数`;
  }

  if (tool.name === "write") return path ? `正在写入 ${path}` : "正在写入文件";
  if (tool.name === "edit") return path ? `正在应用对 ${path} 的修改` : "正在应用文件修改";
  if (tool.name === "bash") return "正在执行命令";
  if (tool.name === "read") return path ? `正在读取 ${path}` : "正在读取文件";
  return `正在执行 ${tool.name}`;
}

function appendPath(value: string, path: string | undefined): string {
  return path ? `${value} · ${path}` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
