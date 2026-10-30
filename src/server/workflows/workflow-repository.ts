import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  WorkflowDefinition,
  WorkflowRun,
} from "../../shared/workflow-contracts";
import { readJson, writeJsonAtomic } from "../storage";
import { KeyedMutex } from "../core/keyed-mutex";

/** 独立持久化新业务数据；不迁移或改写既有生产数据库。 */
export class WorkflowRepository {
  private readonly lock = new KeyedMutex();
  constructor(private readonly directory: string) {}
  async definitions(): Promise<WorkflowDefinition[]> {
    const items =
      (await readJson<WorkflowDefinition[]>(
        join(this.directory, "definitions.json"),
      )) ?? [];
    // 旧定义缺少说明时只在读取结果补齐，避免触发生产数据迁移。
    return items.map((item) => ({
      ...item,
      description: item.description ?? "",
    }));
  }
  /** 在锁内计算新版本，落盘成功后才向调用者确认。 */
  async mutateDefinitions<T>(
    operation: (items: WorkflowDefinition[]) => T,
  ): Promise<T> {
    return this.lock.run("definitions", async () => {
      const items = await this.definitions();
      const result = operation(items);
      await writeJsonAtomic(join(this.directory, "definitions.json"), items);
      return result;
    });
  }
  async saveRun(run: WorkflowRun): Promise<void> {
    await this.lock.run(run.id, () =>
      writeJsonAtomic(
        join(this.directory, "runs", `${run.id}.json`),
        structuredClone(run),
      ),
    );
  }
  async runs(): Promise<WorkflowRun[]> {
    let names: string[];
    try {
      names = await readdir(join(this.directory, "runs"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const result: WorkflowRun[] = [];
    for (const name of names.filter((n) => /^[a-f0-9-]{36}\.json$/.test(n))) {
      const run = await readJson<WorkflowRun>(
        join(this.directory, "runs", name),
      );
      if (run) result.push(run);
    }
    return result;
  }
}
