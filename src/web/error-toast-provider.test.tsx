import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";

it("最多展示三条 Toast 并在关闭后补入排队项", async () => {
  const modulePath = "./error-toast-provider";
  const module = await import(/* @vite-ignore */ modulePath).catch(() => undefined);

  expect(module).toBeDefined();
  if (!module) return;

  function Probe() {
    const toast = module.useErrorToast();
    return <button type="button" onClick={() => {
      for (let index = 1; index <= 4; index += 1) {
        toast.push({ operation: `操作 ${index}`, title: `错误 ${index}`, summary: `摘要 ${index}` });
      }
    }}>产生错误</button>;
  }

  render(<module.ErrorToastProvider><Probe /></module.ErrorToastProvider>);
  fireEvent.click(screen.getByRole("button", { name: "产生错误" }));

  expect(screen.getAllByRole("group")).toHaveLength(3);
  expect(screen.queryByRole("group", { name: "错误 4" })).not.toBeInTheDocument();
  fireEvent.click(within(screen.getByRole("group", { name: "错误 1" })).getByRole("button", { name: "关闭错误通知" }));
  expect(screen.getByRole("group", { name: "错误 4" })).toBeInTheDocument();
});

it("在展示时长耗尽后自动关闭 Toast", async () => {
  vi.useFakeTimers();
  const { ErrorToastProvider, useErrorToast } = await import("./error-toast-provider");
  function Probe() {
    const toast = useErrorToast();
    return <button type="button" onClick={() => toast.push({ operation: "保存", title: "自动关闭", summary: "请求失败", durationMs: 1000 })}>产生错误</button>;
  }
  render(<ErrorToastProvider><Probe /></ErrorToastProvider>);
  fireEvent.click(screen.getByRole("button", { name: "产生错误" }));

  act(() => vi.advanceTimersByTime(999));
  expect(screen.getByRole("group", { name: "自动关闭" })).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.queryByRole("group", { name: "自动关闭" })).not.toBeInTheDocument();
  vi.useRealTimers();
});

it("悬停期间暂停耗尽计时并从剩余时间继续", async () => {
  vi.useFakeTimers();
  const { ErrorToastProvider, useErrorToast } = await import("./error-toast-provider");
  function Probe() {
    const toast = useErrorToast();
    return <button type="button" onClick={() => toast.push({ operation: "保存", title: "暂停计时", summary: "请求失败", durationMs: 1000 })}>产生错误</button>;
  }
  render(<ErrorToastProvider><Probe /></ErrorToastProvider>);
  fireEvent.click(screen.getByRole("button", { name: "产生错误" }));
  act(() => vi.advanceTimersByTime(500));
  fireEvent.mouseEnter(screen.getByRole("group", { name: "暂停计时" }));
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.getByRole("group", { name: "暂停计时" })).toBeInTheDocument();
  fireEvent.mouseLeave(screen.getByRole("group", { name: "暂停计时" }));
  act(() => vi.advanceTimersByTime(499));
  expect(screen.getByRole("group", { name: "暂停计时" })).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.queryByRole("group", { name: "暂停计时" })).not.toBeInTheDocument();
  vi.useRealTimers();
});

it("合并同一请求的重复错误并允许统一清空", async () => {
  const { ErrorToastProvider, useErrorToast } = await import("./error-toast-provider");
  function Probe() {
    const toast = useErrorToast();
    const input = { operation: "保存", title: "重复错误", summary: "请求失败", code: "INTERNAL_ERROR", requestId: "request-same" };
    return <><button type="button" onClick={() => { toast.push(input); toast.push(input); }}>产生重复错误</button><button type="button" onClick={toast.clear}>清空错误</button></>;
  }
  render(<ErrorToastProvider><Probe /></ErrorToastProvider>);
  fireEvent.click(screen.getByRole("button", { name: "产生重复错误" }));
  expect(screen.getAllByRole("group", { name: "重复错误" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "清空错误" }));
  expect(screen.queryByRole("group", { name: "重复错误" })).not.toBeInTheDocument();
});
