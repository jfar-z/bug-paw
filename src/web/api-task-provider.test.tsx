import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { ApiClientError } from "./api";
import { ErrorToastProvider } from "./error-toast-provider";

it("等待调用点声明的业务错误处理器且不显示 Toast", async () => {
  const modulePath = "./api-task-provider";
  const module = await import(/* @vite-ignore */ modulePath).catch(() => undefined);

  expect(module).toBeDefined();
  if (!module) return;

  const handled = vi.fn(async () => undefined);
  function Probe() {
    const { runApiTask } = module.useApiTask();
    return <button type="button" onClick={() => void runApiTask(
      async () => { throw new ApiClientError("VERSION_CONFLICT", "版本冲突", 409); },
      { operation: "保存配置", expected: { VERSION_CONFLICT: handled } },
    )}>保存</button>;
  }
  render(<ErrorToastProvider><module.ApiTaskProvider onAuthenticationRequired={vi.fn()}><Probe /></module.ApiTaskProvider></ErrorToastProvider>);
  fireEvent.click(screen.getByRole("button", { name: "保存" }));

  await waitFor(() => expect(handled).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("group", { name: "操作未完成" })).not.toBeInTheDocument();
});

it("将调用点未声明的错误转换为全局 Toast", async () => {
  const { ApiTaskProvider, useApiTask } = await import("./api-task-provider");
  function Probe() {
    const { runApiTask } = useApiTask();
    const [status, setStatus] = useState("");
    return <><button type="button" onClick={() => void runApiTask(
      async () => { throw new ApiClientError("INTERNAL_ERROR", "服务暂时不可用", 500, "request-toast"); },
      { operation: "保存配置" },
    ).then((result) => setStatus(result.status)).catch(() => setStatus("rejected"))}>保存</button><output>{status}</output></>;
  }
  render(<ErrorToastProvider><ApiTaskProvider onAuthenticationRequired={vi.fn()}><Probe /></ApiTaskProvider></ErrorToastProvider>);
  fireEvent.click(screen.getByRole("button", { name: "保存" }));

  expect(await screen.findByRole("group", { name: "操作未完成" })).toBeInTheDocument();
  expect(screen.getByText("unexpected")).toBeInTheDocument();
});

it("请求取消时静默返回 cancelled", async () => {
  const { ApiTaskProvider, useApiTask } = await import("./api-task-provider");
  function Probe() {
    const { runApiTask } = useApiTask();
    const [status, setStatus] = useState("");
    return <><button type="button" onClick={() => void runApiTask(
      async () => { throw new DOMException("aborted", "AbortError"); },
      { operation: "加载配置" },
    ).then((result) => setStatus(result.status))}>加载</button><output>{status}</output></>;
  }
  render(<ErrorToastProvider><ApiTaskProvider onAuthenticationRequired={vi.fn()}><Probe /></ApiTaskProvider></ErrorToastProvider>);
  fireEvent.click(screen.getByRole("button", { name: "加载" }));

  expect(await screen.findByText("cancelled")).toBeInTheDocument();
  expect(screen.queryByRole("group", { name: "操作未完成" })).not.toBeInTheDocument();
});

it("认证失效时转交应用处理且不显示 Toast", async () => {
  const { ApiTaskProvider, useApiTask } = await import("./api-task-provider");
  const onAuthenticationRequired = vi.fn();
  function Probe() {
    const { runApiTask } = useApiTask();
    return <button type="button" onClick={() => void runApiTask(
      async () => { throw new ApiClientError("AUTH_REQUIRED", "请先登录", 401); },
      { operation: "加载配置" },
    )}>加载</button>;
  }
  render(<ErrorToastProvider><ApiTaskProvider onAuthenticationRequired={onAuthenticationRequired}><Probe /></ApiTaskProvider></ErrorToastProvider>);
  fireEvent.click(screen.getByRole("button", { name: "加载" }));

  await waitFor(() => expect(onAuthenticationRequired).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("group", { name: "操作未完成" })).not.toBeInTheDocument();
});

it("业务错误处理器自身失败时升级为意外错误 Toast", async () => {
  const { ApiTaskProvider, useApiTask } = await import("./api-task-provider");
  function Probe() {
    const { runApiTask } = useApiTask();
    const [status, setStatus] = useState("");
    return <><button type="button" onClick={() => void runApiTask(
      async () => { throw new ApiClientError("VERSION_CONFLICT", "版本冲突", 409); },
      {
        operation: "保存配置",
        expected: { VERSION_CONFLICT: async () => { throw new Error("处理冲突失败"); } },
      },
    ).then((result) => setStatus(result.status)).catch(() => setStatus("rejected"))}>保存</button><output>{status}</output></>;
  }
  render(<ErrorToastProvider><ApiTaskProvider onAuthenticationRequired={vi.fn()}><Probe /></ApiTaskProvider></ErrorToastProvider>);
  fireEvent.click(screen.getByRole("button", { name: "保存" }));

  expect(await screen.findByRole("group", { name: "操作未完成" })).toBeInTheDocument();
  expect(screen.getByText("unexpected")).toBeInTheDocument();
});

it("可选读取失败时返回调用点提供的降级数据", async () => {
  const { ApiTaskProvider, useApiTask } = await import("./api-task-provider");
  function Probe() {
    const { runOptionalApiTask } = useApiTask();
    const [result, setResult] = useState("");
    return <><button type="button" onClick={() => void runOptionalApiTask(
      async () => { throw new ApiClientError("INTERNAL_ERROR", "服务暂时不可用", 500); },
      {
        operation: "加载可选推荐",
        fallbackReason: "推荐服务暂不可用",
        fallback: () => ["默认推荐"],
      },
    ).then((value) => setResult(`${value.status}:${value.status === "fallback" ? value.data[0] : ""}`))}>加载</button><output>{result}</output></>;
  }
  render(<ErrorToastProvider><ApiTaskProvider onAuthenticationRequired={vi.fn()}><Probe /></ApiTaskProvider></ErrorToastProvider>);
  fireEvent.click(screen.getByRole("button", { name: "加载" }));

  expect(await screen.findByText("fallback:默认推荐")).toBeInTheDocument();
  expect(screen.queryByRole("group", { name: "操作未完成" })).not.toBeInTheDocument();
});
