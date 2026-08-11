import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionActionsMenu } from "./session-actions-menu";

const session = {
  id: "session-1",
  name: "研究记录",
  firstMessage: "第一条消息",
  modified: "2026-08-05T08:00:00.000Z",
  messageCount: 3,
};

/** 构造测试所需的元素边界，避免依赖 JSDOM 不存在的真实布局。 */
function rect({ top, right, bottom, left, width, height }: Pick<DOMRect, "top" | "right" | "bottom" | "left" | "width" | "height">): DOMRect {
  return {
    top,
    right,
    bottom,
    left,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

/** 按菜单元素类型返回确定的触发器和浮层尺寸。 */
function mockMenuGeometry(triggerRect: DOMRect, getMenuHeight = () => 150) {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.classList.contains("session-actions__trigger")) {
      return triggerRect;
    }
    if (this.classList.contains("session-actions__popover")) {
      const height = getMenuHeight();
      return rect({ top: 0, right: 174, bottom: height, left: 0, width: 174, height });
    }
    return rect({ top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SessionActionsMenu", () => {
  it("支持重命名和归档会话", () => {
    const onRename = vi.fn();
    const onArchive = vi.fn();
    render(<SessionActionsMenu session={session} onRename={onRename} onArchive={onArchive} onDelete={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "管理会话：研究记录" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    const input = screen.getByRole("textbox", { name: "重命名会话" });
    fireEvent.change(input, { target: { value: "新的名称" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith("新的名称");

    fireEvent.click(screen.getByRole("button", { name: "管理会话：研究记录" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "归档" }));
    expect(onArchive).toHaveBeenCalledOnce();
  });

  it("永久删除前要求二次确认，并可禁用危险操作", () => {
    const onDelete = vi.fn();
    const { rerender } = render(
      <SessionActionsMenu session={session} onRename={vi.fn()} onArchive={vi.fn()} onDelete={onDelete} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "管理会话：研究记录" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    expect(onDelete).toHaveBeenCalledWith(false);

    rerender(<SessionActionsMenu session={session} disabled onRename={vi.fn()} onArchive={vi.fn()} onDelete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "管理会话：研究记录" }));
    expect(screen.getByRole("menuitem", { name: "归档" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "删除" })).toBeDisabled();
  });

  it("删除绑定定时任务的会话时明确要求停用并保留任务", () => {
    const onDelete = vi.fn();
    render(<SessionActionsMenu session={{ ...session, scheduledTaskCount: 2 }} onRename={vi.fn()} onArchive={vi.fn()} onDelete={onDelete} />);
    fireEvent.click(screen.getByRole("button", { name: "管理会话：研究记录" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    const warning = screen.getByText(/绑定的 2 个定时任务将同步停用/);
    expect(warning).toHaveClass("session-actions__task-warning");
    expect(warning).toHaveTextContent("任务记录会保留");
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    expect(onDelete).toHaveBeenCalledWith(true);
  });

  it("接收到新的展开请求时打开菜单", () => {
    const { rerender } = render(
      <SessionActionsMenu session={session} openRequestId={0} onRename={vi.fn()} onArchive={vi.fn()} onDelete={vi.fn()} />,
    );

    rerender(<SessionActionsMenu session={session} openRequestId={1} onRename={vi.fn()} onArchive={vi.fn()} onDelete={vi.fn()} />);

    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("可从三点菜单进入多选模式", () => {
    const onSelectMultiple = vi.fn();
    render(<SessionActionsMenu session={session} onRename={vi.fn()} onArchive={vi.fn()} onDelete={vi.fn()} onSelectMultiple={onSelectMultiple} />);

    fireEvent.click(screen.getByRole("button", { name: "管理会话：研究记录" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "多选" }));

    expect(onSelectMultiple).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("底部空间不足时通过顶层浮层向上展开", () => {
    vi.stubGlobal("innerWidth", 1024);
    vi.stubGlobal("innerHeight", 768);
    mockMenuGeometry(rect({ top: 720, right: 260, bottom: 750, left: 230, width: 30, height: 30 }));

    render(<SessionActionsMenu session={session} onRename={vi.fn()} onArchive={vi.fn()} onDelete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "管理会话：研究记录" }));

    const menu = screen.getByRole("menu");
    expect(menu.parentElement).toBe(document.body);
    expect(menu).toHaveStyle({ top: "566px", left: "86px" });
  });

  it("空间充足时保持向下展开", () => {
    vi.stubGlobal("innerWidth", 1024);
    vi.stubGlobal("innerHeight", 768);
    mockMenuGeometry(rect({ top: 100, right: 260, bottom: 130, left: 230, width: 30, height: 30 }));

    render(<SessionActionsMenu session={session} onRename={vi.fn()} onArchive={vi.fn()} onDelete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "管理会话：研究记录" }));

    expect(screen.getByRole("menu")).toHaveStyle({ top: "134px", left: "86px" });
  });

  it("菜单内容变高后重新定位并正确区分 Portal 内外点击", () => {
    vi.stubGlobal("innerWidth", 1024);
    vi.stubGlobal("innerHeight", 768);
    let menuHeight = 150;
    mockMenuGeometry(
      rect({ top: 720, right: 260, bottom: 750, left: 230, width: 30, height: 30 }),
      () => menuHeight,
    );

    render(<SessionActionsMenu session={session} onRename={vi.fn()} onArchive={vi.fn()} onDelete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "管理会话：研究记录" }));
    const deleteButton = screen.getByRole("menuitem", { name: "删除" });
    fireEvent.pointerDown(deleteButton);
    expect(screen.getByRole("menu")).toBeInTheDocument();

    menuHeight = 220;
    fireEvent.click(deleteButton);
    expect(screen.getByRole("menu")).toHaveStyle({ top: "496px" });

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
