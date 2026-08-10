import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { readJson, writeJsonAtomic } from "../storage";

export type ChatRunStatus = "queued" | "running" | "completed" | "aborted" | "error" | "interrupted";

/** Web 运行恢复所需的最小 Projection，不复制 Pi 历史或 Event Journal。 */
export interface RunCheckpoint {
  version: 1;
  runId?: string;
  sessionId: string;
  status?: ChatRunStatus;
  startedAt?: string;
  finishedAt?: string;
  lastEventId: number;
  /** 仅为读取旧检查点保留；新检查点不再复制完整会话消息。 */
  messages?: unknown[];
  /** 仅为读取旧检查点保留，新写入不再提供。 */
  events?: unknown[];
  error?: string;
}

export interface RunCheckpointStore {
  load(sessionId: string): Promise<RunCheckpoint | undefined>;
  save(checkpoint: RunCheckpoint): Promise<void>;
  remove(sessionId: string): Promise<void>;
  markInterrupted(finishedAt?: string): Promise<void>;
}

/** 创建以 Session ID 分片的 owner-only 检查点存储。 */
export function createRunCheckpointStore(runDir: string): RunCheckpointStore {
  const filePath = (sessionId: string) => join(runDir, `${assertSessionId(sessionId)}.json`);
  return {
    async load(sessionId) { return readJson<RunCheckpoint>(filePath(sessionId)); },
    async save(checkpoint) { await writeJsonAtomic(filePath(checkpoint.sessionId), checkpoint); },
    async remove(sessionId) { await rm(filePath(sessionId), { force: true }); },
    async markInterrupted(finishedAt = new Date().toISOString()) {
      const files = await readdir(runDir).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      await Promise.all(files.filter((file) => file.endsWith(".json")).map(async (file) => {
        const checkpoint = await readJson<RunCheckpoint>(join(runDir, file));
        if (!checkpoint || (checkpoint.status !== "queued" && checkpoint.status !== "running")) return;
        await writeJsonAtomic(join(runDir, file), { ...checkpoint, messages: undefined, status: "interrupted", finishedAt });
      }));
    },
  };
}

function assertSessionId(sessionId: string): string {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(sessionId)) throw new Error("会话 ID 格式不正确");
  return sessionId;
}
