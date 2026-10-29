import { Worker } from "node:worker_threads";
import { DomainError } from "../core/errors";
import { checkValueSize } from "./workflow-validation";

/** 每次脚本使用独立 Worker 和 WASM 堆，超时或取消时精确销毁。 */
export async function runWorkflowScript(
  script: string,
  inputs: Record<string, unknown>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ output: Record<string, unknown>; logs: string[] }> {
  signal.throwIfAborted();
  checkValueSize(inputs);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./script-worker.mjs", import.meta.url), {
      workerData: { script, inputs, timeoutMs },
      resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 2 },
      execArgv: [],
    });
    let settled = false;
    const done = (
      error?: Error,
      result?: { output: Record<string, unknown>; logs: string[] },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      void worker.terminate();
      if (error) reject(error);
      else resolve(result!);
    };
    const abort = () =>
      done(new DomainError("OPERATION_ABORTED", "JS 脚本执行已取消"));
    const timer = setTimeout(
      () =>
        done(
          new DomainError(
            "REQUEST_FAILED",
            "JS 脚本执行环境启动或执行超过截止时间",
          ),
        ),
      timeoutMs + 10_000,
    );
    signal.addEventListener("abort", abort, { once: true });
    worker.on("message", (data) => {
      if (data.error)
        return done(new DomainError("REQUEST_FAILED", String(data.error)));
      try {
        checkValueSize(data.output);
        done(undefined, data);
      } catch (error) {
        done(error as Error);
      }
    });
    worker.on("error", (error) => done(error));
    worker.on("exit", () => {
      if (!settled)
        done(
          new DomainError("REQUEST_FAILED", "JS 脚本执行进程在返回结果前退出"),
        );
    });
    if (signal.aborted) abort();
  });
}
