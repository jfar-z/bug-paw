import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

const expandedItem = {
  id: "toast-copy",
  operation: "保存 Provider",
  title: "操作未完成",
  summary: "请稍后重试",
  code: "INTERNAL_ERROR",
  requestId: "request-copy",
  durationMs: 8000,
  remainingMs: 8000,
  expanded: true,
  paused: true,
};

it("展示意外错误并允许在卡片内展开详情", async () => {
  const modulePath = "./error-toast-viewport";
  const module = await import(/* @vite-ignore */ modulePath).catch(() => undefined);

  expect(module).toBeDefined();
  if (!module) return;

  const setExpanded = vi.fn();
  const item = {
    id: "toast-1",
    operation: "保存 Provider",
    title: "操作未完成",
    summary: "请稍后重试",
    code: "INTERNAL_ERROR",
    status: 500,
    requestId: "request-1",
    safeDetail: "服务暂时不可用",
    durationMs: 8000,
    remainingMs: 8000,
    expanded: false,
    paused: false,
  };
  const { rerender } = render(<module.ErrorToastViewport
    items={[item]}
    announcement="操作未完成。请稍后重试"
    onDismiss={vi.fn()}
    onExpandedChange={setExpanded}
    onPauseChange={vi.fn()}
  />);

  expect(screen.getByRole("alert")).toHaveTextContent("操作未完成。请稍后重试");
  expect(screen.getByRole("group", { name: "操作未完成" })).toBeInTheDocument();
  expect(screen.queryByText("request-1")).not.toBeInTheDocument();
  expect(screen.getByTestId("error-toast-progress")).toHaveAttribute("aria-hidden", "true");

  fireEvent.click(screen.getByRole("button", { name: "查看错误详情" }));
  expect(setExpanded).toHaveBeenCalledWith("toast-1", true);

  rerender(<module.ErrorToastViewport
    items={[{ ...item, expanded: true, paused: true }]}
    announcement="操作未完成。请稍后重试"
    onDismiss={vi.fn()}
    onExpandedChange={setExpanded}
    onPauseChange={vi.fn()}
  />);
  expect(screen.getByText("request-1")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "收起错误详情" })).toHaveAttribute("aria-expanded", "true");
});

it("允许复制请求标识并在卡片内反馈成功", async () => {
  const { ErrorToastViewport } = await import("./error-toast-viewport");
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  render(<ErrorToastViewport
    items={[expandedItem]}
    announcement=""
    onDismiss={vi.fn()}
    onExpandedChange={vi.fn()}
    onPauseChange={vi.fn()}
  />);

  fireEvent.click(screen.getByRole("button", { name: "复制请求标识" }));

  expect(writeText).toHaveBeenCalledWith("request-copy");
  expect(await screen.findByText("已复制")).toBeInTheDocument();
});
