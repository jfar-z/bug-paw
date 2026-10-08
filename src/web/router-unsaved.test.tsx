import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiTaskProvider } from "./api-task-provider";
import { ErrorToastProvider } from "./error-toast-provider";
import { useUnsavedChanges } from "./components/configuration/unsaved-changes";
import { navigateTo, useBrowserRoute } from "./router";

/** 用真实 History API 与配置守卫验证路由恢复，不模拟路由实现。 */
function RouterHarness({ save }: { save: () => Promise<boolean> }) {
  const route = useBrowserRoute();
  return <><span data-testid="route">{route.page}</span>{route.page === "providers" ? <Editor save={save} /> : <button onClick={() => navigateTo({ page: "providers" })}>进入配置</button>}</>;
}
function Editor({ save }: { save: () => Promise<boolean> }) {
  const [dirty, setDirty] = useState(false);
  const guard = useUnsavedChanges({ dirty, busy: false, label: "测试配置", save });
  return <>{guard.dialog}<button onClick={() => setDirty(true)}>修改配置</button><button onClick={() => navigateTo({ page: "diagnostics" }, true)}>替换导航</button></>;
}
function setup(save = vi.fn(async () => true)) {
  render(<ErrorToastProvider><ApiTaskProvider onAuthenticationRequired={vi.fn()}><RouterHarness save={save} /></ApiTaskProvider></ErrorToastProvider>);
  fireEvent.click(screen.getByText("进入配置"));
  fireEvent.click(screen.getByText("修改配置"));
  return save;
}
beforeEach(() => window.history.replaceState({}, "", "/settings"));
afterEach(() => vi.restoreAllMocks());

describe("配置草稿与 History 导航", () => {
  it("取消浏览器返回恢复地址与路由，随后放弃可返回且保留前进目标", async () => {
    setup();
    act(() => window.history.back());
    await screen.findByRole("dialog", { name: "还有未保存的修改" });
    await waitFor(() => expect(window.location.pathname).toBe("/settings/providers"));
    expect(screen.getByTestId("route")).toHaveTextContent("providers");
    fireEvent.click(screen.getByText("继续编辑"));
    act(() => window.history.back());
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByText("放弃并切换"));
    await waitFor(() => expect(screen.getByTestId("route")).toHaveTextContent("configuration-overview"));
    expect(window.location.pathname).toBe("/settings");
    act(() => window.history.forward());
    await waitFor(() => expect(screen.getByTestId("route")).toHaveTextContent("providers"));
  });

  it("浏览器返回时保存失败不离开，重试成功才重放原始返回", async () => {
    const save = setup(vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true));
    act(() => window.history.back());
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByText("保存并切换"));
    await screen.findByText(/尚未完成保存/);
    expect(screen.getByTestId("route")).toHaveTextContent("providers");
    fireEvent.click(screen.getByText("保存并切换"));
    await waitFor(() => expect(screen.getByTestId("route")).toHaveTextContent("configuration-overview"));
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("保存后恢复 replace 导航而不是增加新的历史条目", async () => {
    setup();
    const length = window.history.length;
    fireEvent.click(screen.getByText("替换导航"));
    fireEvent.click(screen.getByText("保存并切换"));
    await waitFor(() => expect(screen.getByTestId("route")).toHaveTextContent("diagnostics"));
    expect(window.history.length).toBe(length);
  });
});
