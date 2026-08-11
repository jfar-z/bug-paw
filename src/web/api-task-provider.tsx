import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import type { ApiErrorCode } from "../shared/api/common";
import { ApiClientError } from "./api";
import { isCancelledError, toUnexpectedErrorNotice } from "./api-error-policy";
import { useErrorToast } from "./error-toast-provider";

export type ApiTaskResult<T> =
  | { status: "success"; data: T }
  | { status: "handled"; error: ApiClientError }
  | { status: "cancelled" }
  | { status: "unexpected"; toastId: string };

export interface ApiTaskPolicy {
  operation: string;
  expected?: Partial<Record<ApiErrorCode, (error: ApiClientError) => void | Promise<void>>>;
}

export type OptionalApiTaskResult<T> =
  | { status: "success"; data: T }
  | { status: "fallback"; data: T; reason: string }
  | { status: "handled"; error: ApiClientError }
  | { status: "cancelled" }
  | { status: "unexpected"; toastId: string };

export interface OptionalApiTaskPolicy<T> {
  operation: string;
  fallbackReason: string;
  fallback: (error: unknown) => T | Promise<T>;
}

interface ApiTaskController {
  runApiTask<T>(task: () => Promise<T>, policy: ApiTaskPolicy): Promise<ApiTaskResult<T>>;
  runOptionalApiTask<T>(
    task: () => Promise<T>,
    policy: OptionalApiTaskPolicy<T>,
  ): Promise<OptionalApiTaskResult<T>>;
}

const ApiTaskContext = createContext<ApiTaskController | undefined>(undefined);

/** 为页面 API 操作提供统一业务错误分发入口。 */
export function ApiTaskProvider({
  children,
  onAuthenticationRequired,
}: {
  children: ReactNode;
  onAuthenticationRequired: () => void | Promise<void>;
}) {
  const toast = useErrorToast();
  const runApiTask = useCallback(async <T,>(task: () => Promise<T>, policy: ApiTaskPolicy): Promise<ApiTaskResult<T>> => {
    try {
      return { status: "success", data: await task() };
    } catch (error) {
      if (isCancelledError(error)) return { status: "cancelled" };
      if (error instanceof ApiClientError) {
        if (error.code === "AUTH_REQUIRED" || error.code === "UNAUTHENTICATED") {
          toast.clear();
          await onAuthenticationRequired();
          return { status: "handled", error };
        }

        const handler = Object.entries(policy.expected ?? {}).find(([code]) => code === error.code)?.[1];
        if (handler) {
          try {
            await handler(error);
            return { status: "handled", error };
          } catch (handlerError) {
            // 业务错误处理器失败意味着原本可恢复的流程已不可控，应升级为意外错误。
            return {
              status: "unexpected",
              toastId: toast.push(toUnexpectedErrorNotice(handlerError, policy.operation)),
            };
          }
        }
      }
      return { status: "unexpected", toastId: toast.push(toUnexpectedErrorNotice(error, policy.operation)) };
    }
  }, [onAuthenticationRequired, toast]);
  const runOptionalApiTask = useCallback(async <T,>(
    task: () => Promise<T>,
    policy: OptionalApiTaskPolicy<T>,
  ): Promise<OptionalApiTaskResult<T>> => {
    try {
      return { status: "success", data: await task() };
    } catch (error) {
      if (isCancelledError(error)) return { status: "cancelled" };
      if (error instanceof ApiClientError && (error.code === "AUTH_REQUIRED" || error.code === "UNAUTHENTICATED")) {
        toast.clear();
        await onAuthenticationRequired();
        return { status: "handled", error };
      }
      try {
        // 仅允许可选读取使用显式降级，避免写操作失败后伪装成成功。
        return { status: "fallback", data: await policy.fallback(error), reason: policy.fallbackReason };
      } catch (fallbackError) {
        return {
          status: "unexpected",
          toastId: toast.push(toUnexpectedErrorNotice(fallbackError, policy.operation)),
        };
      }
    }
  }, [onAuthenticationRequired, toast]);
  const controller = useMemo<ApiTaskController>(
    () => ({ runApiTask, runOptionalApiTask }),
    [runApiTask, runOptionalApiTask],
  );
  return <ApiTaskContext.Provider value={controller}>{children}</ApiTaskContext.Provider>;
}

/** 获取当前应用的 API 任务执行器。 */
export function useApiTask(): ApiTaskController {
  const controller = useContext(ApiTaskContext);
  if (!controller) throw new Error("useApiTask 必须在 ApiTaskProvider 内使用");
  return controller;
}
