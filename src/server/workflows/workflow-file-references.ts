import type { WorkflowFile } from "../../shared/workflow-contracts";

/** 遍历结构化值中的受控文件引用，覆盖数组、对象、循环及调用快照。 */
export function workflowFileReferences(value: unknown): Map<string, WorkflowFile> {
  const result = new Map<string, WorkflowFile>();
  const visit = (item: unknown) => {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) { item.forEach(visit); return; }
    const record = item as Record<string, unknown>;
    if (typeof record.assetId === "string" && typeof record.mediaType === "string" && typeof record.name === "string")
      result.set(record.assetId, item as WorkflowFile);
    Object.values(record).forEach(visit);
  };
  visit(value);
  return result;
}
