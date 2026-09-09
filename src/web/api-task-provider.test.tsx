import { render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";

import { ApiClientError } from "./api";
import { ApiTaskProvider, useApiTask } from "./api-task-provider";
import { ErrorToastProvider } from "./error-toast-provider";

/** 可选读取降级时仍然必须展示原始错误。 */
describe("ApiTaskProvider", () => {
  it("显示错误 Toast 后返回缓存数据", async () => {
    const onResult = vi.fn();
    render(
      <ErrorToastProvider>
        <ApiTaskProvider onAuthenticationRequired={vi.fn()}>
          <OptionalReadHarness onResult={onResult} />
        </ApiTaskProvider>
      </ErrorToastProvider>,
    );

    expect(await screen.findByText("加载缓存配置失败")).toBeInTheDocument();
    expect(screen.getByText("配置接口返回 HTTP 502")).toBeInTheDocument();
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ status: "fallback", data: "cached" })));
  });
});

/** 启动一次带缓存降级的读取。 */
function OptionalReadHarness({ onResult }: { onResult: (value: unknown) => void }) {
  const { runOptionalApiTask } = useApiTask();
  useEffect(() => {
    void runOptionalApiTask(
      async () => { throw new ApiClientError("UPSTREAM_BAD_GATEWAY", "配置接口返回 HTTP 502", 502, "req-cache"); },
      { operation: "加载缓存配置", fallbackReason: "显示本地缓存", fallback: () => "cached" },
    ).then(onResult);
  }, [onResult, runOptionalApiTask]);
  return null;
}
