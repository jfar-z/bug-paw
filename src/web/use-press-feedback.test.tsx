import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { usePressFeedback } from "./use-press-feedback";

function PressFeedbackController() {
  usePressFeedback();
  return null;
}

describe("usePressFeedback", () => {
  it("只为可用交互控件维护按下状态并在释放时清理", () => {
    render(
      <>
        <PressFeedbackController />
        <button type="button">普通按钮</button>
        <button type="button" disabled>禁用按钮</button>
        <a href="/help">帮助链接</a>
        <label className="attachment-picker__button">附件<input type="file" /></label>
      </>,
    );

    const button = screen.getByRole("button", { name: "普通按钮" });
    fireEvent.pointerDown(button);
    expect(button).toHaveClass("is-pressing");
    fireEvent.pointerUp(window);
    expect(button).not.toHaveClass("is-pressing");

    const disabled = screen.getByRole("button", { name: "禁用按钮" });
    fireEvent.pointerDown(disabled);
    expect(disabled).not.toHaveClass("is-pressing");

    const link = screen.getByRole("link", { name: "帮助链接" });
    fireEvent.pointerDown(link);
    expect(link).toHaveClass("is-pressing");
    fireEvent.pointerCancel(window);
    expect(link).not.toHaveClass("is-pressing");

    const attachment = screen.getByText("附件").closest("label")!;
    fireEvent.pointerDown(attachment);
    expect(attachment).toHaveClass("is-pressing");
  });

  it("卸载后移除全局监听和遗留按下状态", () => {
    const controller = render(<PressFeedbackController />);
    render(<button type="button">外部按钮</button>);
    const button = screen.getByRole("button", { name: "外部按钮" });
    fireEvent.pointerDown(button);
    expect(button).toHaveClass("is-pressing");

    controller.unmount();
    expect(button).not.toHaveClass("is-pressing");
    fireEvent.pointerDown(button);
    expect(button).not.toHaveClass("is-pressing");
  });

  it("点击会话正文或管理按钮时为整个会话行提供按下反馈", () => {
    render(
      <>
        <PressFeedbackController />
        <div className="session-row" data-testid="session-row">
          <button type="button">会话正文</button>
          <button type="button" aria-label="管理会话">•••</button>
        </div>
      </>,
    );

    const row = screen.getByTestId("session-row");
    const openButton = screen.getByRole("button", { name: "会话正文" });
    const actionButton = screen.getByRole("button", { name: "管理会话" });

    fireEvent.pointerDown(openButton);
    expect(row).toHaveClass("is-pressing");
    expect(openButton).not.toHaveClass("is-pressing");
    fireEvent.pointerUp(window);
    expect(row).not.toHaveClass("is-pressing");

    fireEvent.pointerDown(actionButton);
    expect(row).toHaveClass("is-pressing");
    expect(actionButton).not.toHaveClass("is-pressing");
  });
});
