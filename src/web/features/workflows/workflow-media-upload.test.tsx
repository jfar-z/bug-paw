import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiClientError } from "../../api";
import { ApiTaskProvider } from "../../api-task-provider";
import { ErrorToastProvider } from "../../error-toast-provider";
import { WorkflowsPage } from "../../pages/workflows-page";
import { WorkflowValue } from "./workflow-fields";
import {
  emptyWorkflow,
  type WorkflowInputField,
} from "../../../shared/workflow-contracts";

vi.mock("./workflow-canvas", () => ({ WorkflowCanvas: () => null }));
afterEach(() => vi.restoreAllMocks());

/** 同时覆盖运行表单与编辑器固定值，使用真实组件状态和任务错误弹窗。 */
async function fixture(surface: "run" | "editor", field: WorkflowInputField) {
  const changed = vi.fn();
  const run = vi
    .spyOn(api, "runWorkflow")
    .mockImplementation(() => new Promise(() => {}));
  const upload = vi
    .spyOn(api, "uploadWorkflowFile")
    .mockImplementation(async (file) => ({
      assetId: file.name,
      name: file.name,
      mediaType: file.type,
      size: file.size,
    }));
  const definition = {
    ...emptyWorkflow(),
    id: "media-run",
    revision: 1,
    createdAt: "",
    updatedAt: "",
  };
  definition.nodes[0].outputs = [field];
  vi.spyOn(api, "getWorkflow").mockResolvedValue(definition);
  vi.spyOn(api, "listWorkflows").mockResolvedValue({ workflows: [{ id: definition.id, name: definition.name, description: definition.description, published: definition.published, revision: definition.revision, createdAt: definition.createdAt, updatedAt: definition.updatedAt, nodeCount: definition.nodes.length }] });
  function Editor() {
    const [value, setValue] = useState<unknown>(field.defaultValue);
    return (
      <WorkflowValue
        field={field}
        value={value}
        onChange={(next) => {
          changed(next);
          setValue(next);
        }}
      />
    );
  }
  render(
    <ErrorToastProvider>
      <ApiTaskProvider onAuthenticationRequired={() => {}}>
        {surface === "run" ? (
          <WorkflowsPage
            route={{ page: "workflow-run", workflowId: definition.id }}
          />
        ) : (
          <Editor />
        )}
      </ApiTaskProvider>
    </ErrorToastProvider>,
  );
  const input = (await screen.findByLabelText(
    "上传 media",
  )) as HTMLInputElement;
  // 运行表单在定义加载后通过 effect 填入默认值，等待其显示再模拟用户上传。
  if (Array.isArray(field.defaultValue) && field.defaultValue.length)
    await screen.findByText(
      field.defaultValue.map((file) => file.name).join("、"),
    );
  return {
    input,
    upload,
    async select(files: File[]) {
      fireEvent.change(input, { target: { files } });
      await waitFor(() => expect(input).toBeEnabled());
    },
    async value() {
      if (surface === "editor")
        return changed.mock.calls.length
          ? changed.mock.lastCall![0]
          : field.defaultValue;
      fireEvent.click(screen.getByRole("button", { name: "运行工作流" }));
      await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
      return run.mock.calls[0][1].media;
    },
  };
}

/** 分批上传必须保留历史引用和选择顺序，单文件字段仍遵循替换语义。 */
describe.each(["run", "editor"] as const)("%s 媒体上传", (surface) => {
  it.each(["image", "audio", "video", "file"] as const)(
    "%s 数组连续单选和多选追加，取消选择不清空",
    async (type) => {
      const f = await fixture(surface, { name: "media", type, multiple: true });
      const mediaType = type === "file" ? "application/pdf" : `${type}/test`;
      const files = ["first", "second", "third", "fourth"].map(
        (name) => new File([name], name, { type: mediaType }),
      );
      expect(f.input).toHaveAttribute("multiple");
      await f.select([files[0]]);
      await screen.findByText("first");
      await f.select([files[1]]);
      await screen.findByText("first、second");
      await f.select(files.slice(2));
      await screen.findByText("first、second、third、fourth");
      await f.select([]);
      expect(f.upload).toHaveBeenCalledTimes(4);
      expect(f.input).toHaveValue("");
      expect(await f.value()).toEqual(
        files.map((file) => ({
          assetId: file.name,
          name: file.name,
          mediaType,
          size: file.size,
        })),
      );
    },
  );

  it("单文件第二次上传替换第一次，不提交数组", async () => {
    const f = await fixture(surface, { name: "media", type: "image" });
    expect(f.input).not.toHaveAttribute("multiple");
    await f.select([new File(["a"], "first.png", { type: "image/png" })]);
    await f.select([new File(["b"], "second.png", { type: "image/png" })]);
    await screen.findByText("second.png");
    expect(screen.queryByText("first.png")).not.toBeInTheDocument();
    expect(await f.value()).toMatchObject({ assetId: "second.png" });
  });

  it("追加失败显示错误并保留旧数组，同一文件可重试追加", async () => {
    const f = await fixture(surface, {
      name: "media",
      type: "image",
      multiple: true,
    });
    const first = new File(["a"], "first.png", { type: "image/png" });
    const second = new File(["b"], "second.png", { type: "image/png" });
    await f.select([first]);
    f.upload.mockRejectedValueOnce(
      new ApiClientError(
        "REQUEST_FAILED",
        "媒体上传存储失败",
        500,
        "upload-test",
      ),
    );
    await f.select([second]);
    expect(screen.getAllByText(/媒体上传存储失败/).length).toBeGreaterThan(0);
    expect(screen.getByText("first.png")).toBeInTheDocument();
    await f.select([second]);
    await screen.findByText("first.png、second.png");
    expect(await f.value()).toMatchObject([
      { assetId: "first.png" },
      { assetId: "second.png" },
    ]);
  });

  it("按累计数量限制上传，拒绝前不发送请求且不丢已有文件", async () => {
    const limit = surface === "run" ? 100 : 2;
    const existing = Array.from({ length: limit }, (_, index) => ({
      assetId: `old-${index}`,
      name: `old-${index}.png`,
      mediaType: "image/png",
      size: 1,
    }));
    const f = await fixture(surface, {
      name: "media",
      type: "image",
      multiple: true,
      maxItems: limit,
      defaultValue: existing,
    });
    await f.select([new File(["a"], "overflow.png", { type: "image/png" })]);
    expect(
      screen.getAllByText(new RegExp(`最多上传 ${limit} 个文件`)).length,
    ).toBeGreaterThan(0);
    expect(f.upload).not.toHaveBeenCalled();
    expect(
      screen.getByText(existing.map((file) => file.name).join("、")),
    ).toBeInTheDocument();
    expect(await f.value()).toEqual(existing);
  });
});
