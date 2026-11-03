import { createHash } from "node:crypto";

/** 稳定序列化对象，避免字段顺序影响参数与配置指纹。 */
export function taskFingerprint(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object")
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]));
    return item;
  };
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

/** 内容和媒体元数据一起校验，禁止创建后替换输入文件。 */
export function taskFileFingerprint(file: { content: Buffer; name: string; mediaType: string }): string {
  return taskFingerprint([file.name, file.mediaType, createHash("sha256").update(file.content).digest("hex")]);
}

/** 单次最多提交两个不同任务；运行接口始终使用数组。 */
export function validateTaskIds(ids: string[]): void {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 2
    || ids.some((id) => typeof id !== "string" || !id.trim() || id.length > 120)
    || new Set(ids).size !== ids.length)
    throw new TypeError("taskIds 必须包含 1～2 个不重复的真实任务 ID");
}

/** 任务失败必须进入 Pi 错误事件，同时保留同批成功结果。 */
export function hasFailedTasks(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const result = value as { status?: string; tasks?: { status?: string }[] };
  return result.status === "failed" || (Array.isArray(result.tasks) && result.tasks.some((task) => task.status === "failed"));
}
