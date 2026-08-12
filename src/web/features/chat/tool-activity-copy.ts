import type { ToolBlock } from "../../conversation-timeline";

/** 提取工具参数中已完整生成的可靠文件路径。 */
export function toolTargetPath(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined;
  const path = typeof args.path === "string" && args.path ? args.path : args.file_path;
  return typeof path === "string" && path ? path : undefined;
}

/** 根据工具与目标生成不重复生命周期状态的动作文案。 */
export function toolActivityCopy(tool: ToolBlock): string {
  const path = tool.parameterPath ?? toolTargetPath(tool.args);
  if (tool.status === "preparing") {
    if (tool.name === "write") return path ? `编写 ${path}` : "编写文件内容";
    if (tool.name === "edit") return path ? `拟定对 ${path} 的修改` : "拟定文件修改";
    if (tool.name === "bash") return "组织命令";
    if (tool.name === "read") return path ? `确定读取 ${path}` : "确定读取目标";
    return `生成 ${tool.name} 的调用参数`;
  }

  if (tool.status === "parameterizing") {
    if (tool.name === "write") return path ? `正在编写 ${path}` : "正在编写文件内容";
    if (tool.name === "edit") return path ? `正在拟定对 ${path} 的修改` : "正在拟定文件修改";
    if (tool.name === "bash") return "正在组织命令";
    if (tool.name === "read") return path ? `正在确定读取 ${path}` : "正在确定读取目标";
    return "正在生成调用参数";
  }

  if (tool.name === "write") return path ? `写入 ${path}` : "写入文件";
  if (tool.name === "edit") return path ? `修改 ${path}` : "修改文件";
  if (tool.name === "bash") return "执行命令";
  if (tool.name === "read") return path ? `读取 ${path}` : "读取文件";
  return `执行 ${tool.name}`;
}

/** 将工具生命周期映射为右侧的简短状态文案。 */
export function toolStatusCopy(tool: ToolBlock): string {
  if (tool.status === "preparing") return "准备中";
  if (tool.status === "parameterizing") return "参数生成中";
  if (tool.status === "running") return "执行中";
  if (tool.status === "error") return "失败";
  if (tool.status === "cancelled") return "未执行";
  return "已完成";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
