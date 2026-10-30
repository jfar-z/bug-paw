import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiTaskProvider } from "../../api-task-provider";
import { ErrorToastProvider } from "../../error-toast-provider";
import { WorkflowValueView } from "./workflow-value-view";

/** 用真实错误出口验证完整参数与媒体共存，复制结果必须保留原始类型。 */
function Wrapper({ children }: { children: ReactNode }) {
  return <ErrorToastProvider><ApiTaskProvider onAuthenticationRequired={() => {}}>{children}</ApiTaskProvider></ErrorToastProvider>;
}

const image = { assetId: "image", name: "result.png", mediaType: "image/png", size: 8 };
const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const execCommand = Object.getOwnPropertyDescriptor(document, "execCommand");
afterEach(() => {
  vi.restoreAllMocks();
  if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
  if (execCommand) Object.defineProperty(document, "execCommand", execCommand);
  else Reflect.deleteProperty(document, "execCommand");
});

describe("工作流参数与媒体展示", () => {
  it("媒体与普通字段默认同时可见，保留 0、false、空字符串、null 和空容器", () => {
    render(<WorkflowValueView value={{ prompt: "一只在草地上的猫", seed: 0, success: false, empty: "", absent: null, list: [], object: {}, image }} />, { wrapper: Wrapper });
    for (const text of ["一只在草地上的猫", "0", "false", '\"\"（空字符串）', "null", "[]", "{}"])
      expect(screen.getByText(text)).toBeVisible();
    expect(screen.getByRole("img")).toBeVisible();
    expect(screen.getByText("查看完整输出数据").closest("details")).not.toHaveAttribute("open");
    expect(screen.getByText("文件信息").closest("details")).not.toHaveAttribute("open");
  });

  it("同一文件在不同字段和数组位置分别预览，文件内附加业务参数也可见", () => {
    const { container } = render(<WorkflowValueView value={{ first: image, nested: [{ picture: { ...image, caption: "对应第二个参数" }, count: 2 }] }} />, { wrapper: Wrapper });
    expect(screen.getAllByRole("img")).toHaveLength(2);
    const first = [...container.querySelectorAll("dt")].find((el) => el.textContent === "first")!.parentElement!;
    expect(within(first).getByRole("img")).toHaveAttribute("src", "/api/v1/workflow-files/image?preview=1");
    expect(screen.getByText("[0]")).toBeVisible();
    expect(screen.getByText("对应第二个参数")).toBeVisible();
    const group = screen.getByText("数组 · 1 项").closest("details")!;
    expect(group).toHaveAttribute("open");
    fireEvent.click(within(group).getByText("数组 · 1 项"));
    expect(group).not.toHaveAttribute("open");
  });

  it.each([null, false, 0, "", [], {}])("根值 %j 不会被替换为空对象，复制 JSON 保留类型", async (value) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<WorkflowValueView value={value} label="输入" />, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole("button", { name: "复制输入 JSON" }));
    await screen.findByText("已复制");
    expect(writeText).toHaveBeenCalledWith(JSON.stringify(value, null, 2));
    expect(screen.getByText("查看完整输入数据")).toBeVisible();
  });

  it("复制完整 JSON 包含全部嵌套数据和文件元信息，未提供值明确标记且不允许复制", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const value = { prompt: "test", nested: [image, { count: 0, ok: false }] };
    const { rerender } = render(<WorkflowValueView value={value} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole("button", { name: "复制输出 JSON" }));
    await screen.findByText("已复制");
    expect(writeText).toHaveBeenCalledWith(JSON.stringify(value, null, 2));
    rerender(<WorkflowValueView value={undefined} />);
    expect(screen.getByText("未提供", { selector: ".wf-value-scalar" })).toBeVisible();
    expect(screen.getByRole("button", { name: "复制输出 JSON" })).toBeDisabled();
  });

  it("普通 URL 和不完整文件对象保持参数展示", () => {
    render(<WorkflowValueView value={{ url: "https://example.test/image.png", file: { assetId: "plain", caption: "不是媒体引用" } }} />, { wrapper: Wrapper });
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("https://example.test/image.png")).toBeVisible();
    expect(screen.getByText("不是媒体引用")).toBeVisible();
  });

  it("局域网 HTTP 使用临时文本框复制，复制后清理并恢复焦点", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    const copy = vi.fn(() => {
      expect(document.querySelector("textarea")?.value).toBe(JSON.stringify({ seed: 0 }, null, 2));
      return true;
    });
    Object.defineProperty(document, "execCommand", { configurable: true, value: copy });
    render(<WorkflowValueView value={{ seed: 0 }} />, { wrapper: Wrapper });
    const button = screen.getByRole("button", { name: "复制输出 JSON" });
    button.focus();
    fireEvent.click(button);
    await screen.findByText("已复制");
    expect(copy).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
    expect(button).toHaveFocus();
  });

  it("复制失败进入全局错误弹窗，不显示成功且清理临时文本框", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    Object.defineProperty(document, "execCommand", { configurable: true, value: () => false });
    render(<WorkflowValueView value={{ seed: 0 }} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByRole("button", { name: "复制输出 JSON" }));
    await waitFor(() => expect(screen.getAllByText(/浏览器未能写入剪贴板/).length).toBeGreaterThan(0));
    expect(screen.queryByText("已复制")).not.toBeInTheDocument();
    expect(document.querySelector("textarea")).toBeNull();
  });
});
