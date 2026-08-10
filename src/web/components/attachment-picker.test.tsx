import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AttachmentPicker, type AttachmentUploadItem } from "./attachment-picker";

describe("AttachmentPicker", () => {
  it("选择合法文件并展示上传状态", () => {
    const onFilesSelected = vi.fn();
    const item: AttachmentUploadItem = {
      localId: "local-1",
      file: new File(["hello"], "说明.txt", { type: "text/plain" }),
      status: "uploading",
    };
    render(
      <AttachmentPicker
        items={[item]}
        onFilesSelected={onFilesSelected}
        onRemove={vi.fn()}
        onError={vi.fn()}
      />,
    );

    expect(screen.getByText("说明.txt")).toBeInTheDocument();
    expect(screen.getByText("上传中")).toBeInTheDocument();
    const file = new File(["image"], "图片.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("添加附件"), { target: { files: [file] } });
    expect(onFilesSelected).toHaveBeenCalledWith([file]);
  });

  it("拒绝超过数量或大小限制的选择", () => {
    const onFilesSelected = vi.fn();
    const onError = vi.fn();
    const existing = Array.from({ length: 5 }, (_, index): AttachmentUploadItem => ({
      localId: `local-${index}`,
      file: new File(["x"], `${index}.txt`),
      status: "uploaded",
    }));
    const { rerender } = render(
      <AttachmentPicker items={existing} onFilesSelected={onFilesSelected} onRemove={vi.fn()} onError={onError} />,
    );
    fireEvent.change(screen.getByLabelText("添加附件"), { target: { files: [new File(["x"], "extra.txt")] } });
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("5"));

    rerender(<AttachmentPicker items={[]} maxFileSize={3} onFilesSelected={onFilesSelected} onRemove={vi.fn()} onError={onError} />);
    fireEvent.change(screen.getByLabelText("添加附件"), { target: { files: [new File(["1234"], "large.txt")] } });
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("large.txt"));
    expect(onFilesSelected).not.toHaveBeenCalled();
  });
});
