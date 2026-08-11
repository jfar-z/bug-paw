import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReferenceComposer } from "./reference-composer";

const emptyCatalog = {
  skills: [],
  commands: [],
  knowledgeBases: [],
  workspaceEntries: [],
};

describe("ReferenceComposer", () => {
  it("同一个 @ 引用会话只读取一次目录并通过 Tab 选中候选", async () => {
    const loadCatalog = vi.fn(async () => ({
      skills: [{ name: "knowledge-base", description: "检索资料" }],
      commands: [],
      knowledgeBases: [{ id: "kb-1", name: "产品资料" }],
      workspaceEntries: [],
    }));
    const onReferencesChange = vi.fn();
    render(<ReferenceComposer value="" references={[]} disabled={false} loadCatalog={loadCatalog} onChange={vi.fn()} onReferencesChange={onReferencesChange} />);

    const textbox = screen.getByRole("textbox");
    fireEvent.change(textbox, { target: { value: "@know" } });
    await screen.findByRole("option", { name: /技能 knowledge-base/i });
    fireEvent.change(textbox, { target: { value: "@knowl" } });
    fireEvent.keyDown(textbox, { key: "Tab" });

    expect(loadCatalog).toHaveBeenCalledTimes(1);
    expect(onReferencesChange).toHaveBeenCalledWith([{ type: "skill", name: "knowledge-base" }]);
  });

  it("引用与命令候选均最多显示二十项", async () => {
    const loadCatalog = vi.fn(async () => ({
      ...emptyCatalog,
      skills: Array.from({ length: 25 }, (_, index) => ({ name: `skill-${index + 1}`, description: "测试技能" })),
      commands: Array.from({ length: 25 }, (_, index) => ({ name: `command-${index + 1}`, description: "测试命令", source: "extension" as const })),
    }));
    const { rerender } = render(<ReferenceComposer value="" references={[]} disabled={false} loadCatalog={loadCatalog} onChange={vi.fn()} onReferencesChange={vi.fn()} />);

    const textbox = screen.getByRole("textbox");
    fireEvent.change(textbox, { target: { value: "@" } });
    expect(await screen.findAllByRole("option")).toHaveLength(20);

    rerender(<ReferenceComposer value="" references={[]} disabled={false} loadCatalog={loadCatalog} onChange={vi.fn()} onReferencesChange={vi.fn()} />);
    fireEvent.change(textbox, { target: { value: "/" } });
    expect(await screen.findAllByRole("option")).toHaveLength(20);
  });

  it("加号菜单可通过页面空白处关闭，且附件控件与加号共用操作轨", async () => {
    render(
      <ReferenceComposer
        value=""
        references={[]}
        disabled={false}
        loadCatalog={async () => emptyCatalog}
        onChange={vi.fn()}
        onReferencesChange={vi.fn()}
        attachmentControl={<button type="button" aria-label="添加附件">附件</button>}
        bottomControls={<div className="composer-actions"><span /><button type="button" aria-label="发送消息">发送</button></div>}
      />,
    );

    const referenceButton = screen.getByRole("button", { name: "添加引用" });
    const attachmentButton = screen.getByRole("button", { name: "添加附件" });
    const sendButton = screen.getByRole("button", { name: "发送消息" });
    expect(referenceButton.closest(".reference-composer__footer")).toBe(attachmentButton.closest(".reference-composer__footer"));
    expect(referenceButton.closest(".reference-composer__footer")).toBe(sendButton.closest(".reference-composer__footer"));

    fireEvent.click(referenceButton);
    await screen.findByRole("menu");
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("方向键选择候选时会将活动项滚入可视范围", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    const loadCatalog = vi.fn(async () => ({
      ...emptyCatalog,
      skills: [{ name: "first", description: "第一项" }, { name: "second", description: "第二项" }],
    }));
    render(<ReferenceComposer value="" references={[]} disabled={false} loadCatalog={loadCatalog} onChange={vi.fn()} onReferencesChange={vi.fn()} />);

    const textbox = screen.getByRole("textbox");
    fireEvent.change(textbox, { target: { value: "@" } });
    await screen.findAllByRole("option");
    fireEvent.keyDown(textbox, { key: "ArrowDown" });

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("粘贴剪贴板图片时转为附件并过滤图片占位文本", () => {
    const onChange = vi.fn();
    const onFilesInput = vi.fn();
    render(<ReferenceComposer value="" references={[]} disabled={false} loadCatalog={async () => emptyCatalog} onChange={onChange} onReferencesChange={vi.fn()} onFilesInput={onFilesInput} />);
    const image = new File(["image"], "clipboard.png", { type: "image/png" });

    fireEvent.paste(screen.getByRole("textbox"), {
      clipboardData: clipboardData([image], "[图片]"),
    });

    expect(onFilesInput).toHaveBeenCalledWith([image]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("粘贴图片与真实文本时在光标位置保留真实文本", () => {
    const onChange = vi.fn();
    const onFilesInput = vi.fn();
    render(<ReferenceComposer value="开头结尾" references={[]} disabled={false} loadCatalog={async () => emptyCatalog} onChange={onChange} onReferencesChange={vi.fn()} onFilesInput={onFilesInput} />);
    const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;
    textbox.setSelectionRange(2, 2);
    const image = new File(["image"], "clipboard.png", { type: "image/png" });

    fireEvent.paste(textbox, {
      clipboardData: clipboardData([image], "说明文字\n[Image]"),
    });

    expect(onChange).toHaveBeenCalledWith("开头说明文字结尾");
    expect(onFilesInput).toHaveBeenCalledWith([image]);
  });

  it("过滤图片占位行时不裁剪真实文本的空白", () => {
    const onChange = vi.fn();
    const image = new File(["image"], "clipboard.png", { type: "image/png" });
    render(<ReferenceComposer value="前后" references={[]} disabled={false} loadCatalog={async () => emptyCatalog} onChange={onChange} onReferencesChange={vi.fn()} onFilesInput={vi.fn()} />);
    const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;
    textbox.setSelectionRange(1, 1);

    fireEvent.paste(textbox, {
      clipboardData: clipboardData([image], " 说明文字 \n[图片]"),
    });

    expect(onChange).toHaveBeenCalledWith("前 说明文字 后");
  });

  it("拖入本地图片添加附件，拖入纯文本则插入当前光标", () => {
    const onChange = vi.fn();
    const onFilesInput = vi.fn();
    const { rerender } = render(<ReferenceComposer value="前后" references={[]} disabled={false} loadCatalog={async () => emptyCatalog} onChange={onChange} onReferencesChange={vi.fn()} onFilesInput={onFilesInput} />);
    const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;
    textbox.setSelectionRange(1, 1);
    const image = new File(["image"], "drop.png", { type: "image/png" });

    fireEvent.drop(textbox, { dataTransfer: transferData([image], "") });
    expect(onFilesInput).toHaveBeenCalledWith([image]);

    rerender(<ReferenceComposer value="前后" references={[]} disabled={false} loadCatalog={async () => emptyCatalog} onChange={onChange} onReferencesChange={vi.fn()} onFilesInput={onFilesInput} />);
    textbox.setSelectionRange(1, 1);
    fireEvent.drop(textbox, { dataTransfer: transferData([], "插入") });
    expect(onChange).toHaveBeenLastCalledWith("前插入后");
  });

  it("拖入远程图片地址仅作为文本插入，不主动获取远程资源", () => {
    const onChange = vi.fn();
    const onFilesInput = vi.fn();
    render(<ReferenceComposer value="" references={[]} disabled={false} loadCatalog={async () => emptyCatalog} onChange={onChange} onReferencesChange={vi.fn()} onFilesInput={onFilesInput} />);

    fireEvent.drop(screen.getByRole("textbox"), {
      dataTransfer: transferData([], "https://example.com/image.png"),
    });

    expect(onChange).toHaveBeenCalledWith("https://example.com/image.png");
    expect(onFilesInput).not.toHaveBeenCalled();
  });

  it("在输入组件附件区释放本地图片也会添加附件", () => {
    const onFilesInput = vi.fn();
    render(
      <ReferenceComposer
        value=""
        references={[]}
        disabled={false}
        loadCatalog={async () => emptyCatalog}
        onChange={vi.fn()}
        onReferencesChange={vi.fn()}
        onFilesInput={onFilesInput}
        attachmentContent={<div>附件区</div>}
      />,
    );
    const image = new File(["image"], "drop.png", { type: "image/png" });

    fireEvent.drop(screen.getByText("附件区"), { dataTransfer: transferData([image], "") });

    expect(onFilesInput).toHaveBeenCalledWith([image]);
  });
});

function clipboardData(files: File[], text: string) {
  return {
    items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
    getData: (type: string) => type === "text/plain" ? text : "",
  };
}

function transferData(files: File[], text: string) {
  return {
    files,
    types: files.length > 0 ? ["Files"] : ["text/plain"],
    getData: (type: string) => type === "text/plain" ? text : "",
  };
}
