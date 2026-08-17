import type { AigcTaskRecord } from "../../shared/aigc-contracts";
import { readJson, writeJsonAtomic } from "../storage";

/** 以单文件 JSON 保存 AIGC 任务历史。 */
export class AigcTaskRepository {
  private readonly tasks = new Map<string, AigcTaskRecord>();
  private readonly ready: Promise<void>;

  /**
   * @param filePath 任务历史文件路径
   */
  constructor(private readonly filePath: string) {
    this.ready = this.load();
  }

  /** 列出全部任务，按创建时间倒序。 */
  async list(): Promise<AigcTaskRecord[]> {
    await this.ready;
    return [...this.tasks.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  /** 读取单个任务。 */
  async get(id: string): Promise<AigcTaskRecord | undefined> {
    await this.ready;
    const task = this.tasks.get(id);
    return task ? copyTask(task) : undefined;
  }

  /** 创建任务。 */
  async create(task: AigcTaskRecord): Promise<AigcTaskRecord> {
    await this.ready;
    if (this.tasks.has(task.id)) throw new TypeError("AIGC 任务标识重复");
    this.tasks.set(task.id, copyTask(task));
    await this.persist();
    return copyTask(task);
  }

  /** 更新任务字段。 */
  async update(id: string, patch: Partial<AigcTaskRecord>): Promise<AigcTaskRecord | undefined> {
    await this.ready;
    const current = this.tasks.get(id);
    if (!current) return undefined;
    const next = copyTask({ ...current, ...patch, id: current.id });
    this.tasks.set(id, next);
    await this.persist();
    return copyTask(next);
  }

  /** 加载历史文件并容错缺失或损坏内容。 */
  private async load(): Promise<void> {
    const value = await readJson<AigcTaskRecord[]>(this.filePath);
    if (!Array.isArray(value)) return;
    for (const task of value) {
      if (isTaskRecord(task)) this.tasks.set(task.id, copyTask(task));
    }
  }

  /** 原子保存当前任务集合。 */
  private async persist(): Promise<void> {
    await writeJsonAtomic(this.filePath, [...this.tasks.values()].map(copyTask));
  }
}

/** 复制任务记录，避免调用方修改内存状态。 */
function copyTask(task: AigcTaskRecord): AigcTaskRecord {
  return {
    ...task,
    inputs: { ...task.inputs },
    assets: task.assets.map((asset) => ({ ...asset })),
    ...(task.error ? { error: { ...task.error } } : {}),
  };
}

function isTaskRecord(value: unknown): value is AigcTaskRecord {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && typeof (value as AigcTaskRecord).id === "string"
    && typeof (value as AigcTaskRecord).interfaceId === "string"
    && typeof (value as AigcTaskRecord).status === "string"
    && Array.isArray((value as AigcTaskRecord).assets);
}
