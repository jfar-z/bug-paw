import { useState } from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowBindingEditor } from "./workflow-fields";
import { WorkflowNodeEditor } from "./workflow-node-editor";
import {
  WorkflowScriptAssist,
  scriptInputDefinitions,
} from "./workflow-script-assist";
import { WorkflowValueView } from "./workflow-value-view";
import { ApiTaskProvider } from "../../api-task-provider";
import { ErrorToastProvider } from "../../error-toast-provider";
import { api, ApiClientError } from "../../api";
import {
  emptyWorkflow,
  newWorkflowNode,
  type WorkflowBinding,
  type WorkflowCatalog,
} from "../../../shared/workflow-contracts";

/** 使用真实任务提供器验证错误可见，模型请求仅使用假响应。 */
function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <ErrorToastProvider>
      <ApiTaskProvider onAuthenticationRequired={() => {}}>
        {children}
      </ApiTaskProvider>
    </ErrorToastProvider>
  );
}
const catalog: WorkflowCatalog = {
  models: [
    {
      provider: "test",
      id: "script",
      name: "测试模型",
      reasoning: false,
      images: false,
    },
  ],
  agents: [],
  interfaces: [],
};
afterEach(() => vi.restoreAllMocks());
describe("工作流编辑增强", () => {
  it("枚举固定值保留数字和布尔类型，失效选项明确标错，引用不显示类型选择", () => {
    const change = vi.fn();
    const validity = vi.fn();
    const props = {
      label: "质量",
      nodes: emptyWorkflow().nodes,
      nodeId: "aigc",
      onChange: change,
      onValidity: validity,
      field: {
        name: "quality",
        type: "float" as const,
        enumValues: [10, 20, false],
        defaultValue: 20,
      },
    };
    const { rerender } = render(<WorkflowBindingEditor {...props} />);
    fireEvent.change(screen.getByLabelText("质量 值来源"), {
      target: { value: "literal" },
    });
    expect(change).toHaveBeenLastCalledWith({ kind: "literal", value: 20 });
    rerender(
      <WorkflowBindingEditor
        {...props}
        binding={{ kind: "literal", value: 20 }}
      />,
    );
    expect(screen.queryByLabelText("质量 常量类型")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("quality"), {
      target: { value: "2" },
    });
    expect(change).toHaveBeenLastCalledWith({ kind: "literal", value: false });
    rerender(
      <WorkflowBindingEditor
        {...props}
        binding={{ kind: "literal", value: "20" }}
      />,
    );
    expect(screen.getByLabelText("quality")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(validity).toHaveBeenLastCalledWith(false);
    rerender(
      <WorkflowBindingEditor
        {...props}
        binding={{ kind: "reference", nodeId: "input", field: "prompt" }}
      />,
    );
    expect(screen.getByText(/上游值按字符串/)).toBeVisible();
    expect(screen.queryByLabelText("quality")).not.toBeInTheDocument();
  });
  it("AIGC 整数和枚举使用完整定义，参数分组可独立定位", () => {
    const initial = newWorkflowNode("aigc", "aigc");
    initial.config.interfaceId = "a";
    function Editor() {
      const [node, setNode] = useState(initial);
      return (
        <WorkflowNodeEditor
          node={node}
          nodes={emptyWorkflow().nodes}
          catalog={{
            ...catalog,
            interfaces: [
              {
                id: "a",
                name: "测试接口",
                fields: [
                  { name: "steps", type: "integer", min: 1, max: 50 },
                  {
                    name: "quality",
                    type: "string",
                    enumValues: ["low", "high"],
                  },
                ],
                outputs: [],
              },
            ],
          }}
          onChange={setNode}
          onValidity={() => {}}
          onClose={() => {}}
          onCopy={() => {}}
          onDelete={() => {}}
        />
      );
    }
    render(
      <Wrapper>
        <Editor />
      </Wrapper>,
    );
    fireEvent.change(screen.getByLabelText("steps 值来源"), {
      target: { value: "literal" },
    });
    const step = within(screen.getByRole("region", { name: "steps 参数配置" }));
    expect(step.getByLabelText("steps")).toHaveAttribute("step", "1");
    expect(step.getByLabelText("steps")).toHaveAttribute("min", "1");
    expect(step.getByLabelText("steps")).toHaveAttribute("max", "50");
    expect(step.queryByLabelText(/常量类型/)).not.toBeInTheDocument();
  });
  it("脚本输入推导保留上游类型、数组和固定 0/false", () => {
    const node = newWorkflowNode("javascript", "js");
    node.inputs = {
      value: { kind: "literal", value: 0 },
      flag: { kind: "literal", value: false },
      names: { kind: "literal", value: ["a", "b"] },
      ref: { kind: "reference", nodeId: "input", field: "prompt" },
    };
    expect(scriptInputDefinitions(node, emptyWorkflow().nodes)).toMatchObject([
      { name: "value", type: "integer" },
      { name: "flag", type: "boolean" },
      { name: "names", type: "string", multiple: true },
      { name: "ref", type: "string" },
    ]);
  });
  it("生成候选不会改脚本，显式应用只接受未变化上下文", async () => {
    const assist = vi
      .spyOn(api, "assistWorkflowScript")
      .mockResolvedValue({ script: 'return { result: "generated" };' });
    const apply = vi.fn();
    const node = newWorkflowNode("javascript", "js");
    const props = {
      node,
      nodes: emptyWorkflow().nodes,
      catalog,
      onApply: apply,
    };
    const { rerender } = render(
      <Wrapper>
        <WorkflowScriptAssist {...props} />
      </Wrapper>,
    );
    fireEvent.click(screen.getByRole("button", { name: "AI 辅助" }));
    fireEvent.change(screen.getByLabelText("脚本辅助模型"), {
      target: { value: "test\tscript" },
    });
    fireEvent.change(screen.getByLabelText("脚本生成需求"), {
      target: { value: "生成脚本" },
    });
    fireEvent.click(screen.getByRole("button", { name: "生成脚本" }));
    await screen.findByLabelText("候选脚本");
    expect(apply).not.toHaveBeenCalled();
    expect(assist.mock.calls[0][0]).toMatchObject({
      script: node.config.script,
      outputs: node.outputs,
      inputs: [{ name: "value", type: "string" }],
    });
    rerender(
      <Wrapper>
        <WorkflowScriptAssist
          {...props}
          node={{
            ...node,
            config: { ...node.config, script: 'return { result: "manual" };' },
          }}
        />
      </Wrapper>,
    );
    expect(screen.getByRole("button", { name: "应用到脚本" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "应用到脚本" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "应用到脚本" }));
    expect(apply).toHaveBeenCalledWith('return { result: "generated" };');
  });
  it("关闭辅助取消请求；生成异常进入错误弹窗", async () => {
    const assist = vi
      .spyOn(api, "assistWorkflowScript")
      .mockImplementation(() => new Promise(() => {}));
    const node = newWorkflowNode("javascript", "js");
    render(
      <Wrapper>
        <WorkflowScriptAssist
          node={node}
          nodes={[]}
          catalog={catalog}
          onApply={() => {}}
        />
      </Wrapper>,
    );
    fireEvent.click(screen.getByRole("button", { name: "AI 辅助" }));
    fireEvent.change(screen.getByLabelText("脚本辅助模型"), {
      target: { value: "test\tscript" },
    });
    fireEvent.change(screen.getByLabelText("脚本生成需求"), {
      target: { value: "需求" },
    });
    fireEvent.click(screen.getByRole("button", { name: "生成脚本" }));
    fireEvent.click(screen.getByRole("button", { name: "取消生成并关闭" }));
    expect(assist.mock.calls[0][1]?.aborted).toBe(true);
    assist.mockRejectedValue(
      new ApiClientError(
        "REQUEST_FAILED",
        "测试模型输出被截断",
        502,
        "trace-test",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "AI 辅助" }));
    fireEvent.click(screen.getByRole("button", { name: "生成脚本" }));
    await waitFor(() =>
      expect(screen.getAllByText(/测试模型输出被截断/).length).toBeGreaterThan(
        0,
      ),
    );
    expect(screen.getByRole("button", { name: "应用到脚本" })).toBeDisabled();
  });
  it("嵌套产物去重展示图片、音视频和下载，并显示加载异常", async () => {
    const image = {
      assetId: "image",
      name: "图片.png",
      mediaType: "image/png",
      size: 8,
    };
    render(
      <Wrapper>
        <WorkflowValueView
          value={{
            files: [image],
            nested: {
              copies: [image],
              video: {
                ...image,
                assetId: "video",
                name: "视频.mp4",
                mediaType: "video/mp4",
              },
              audio: {
                ...image,
                assetId: "audio",
                name: "音频.wav",
                mediaType: "audio/wav",
              },
            },
          }}
        />
      </Wrapper>,
    );
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(screen.getByLabelText("视频.mp4")).toHaveAttribute("controls");
    expect(screen.getByLabelText("音频.wav")).toHaveAttribute(
      "src",
      "/api/v1/workflow-files/audio?preview=1",
    );
    expect(screen.getAllByRole("link", { name: "下载" })).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "查看大图 图片.png" }));
    expect(screen.getByRole("dialog")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "关闭图片预览" }));
    fireEvent.error(screen.getByRole("img"));
    await waitFor(() =>
      expect(screen.getAllByText(/加载或解码失败/).length).toBeGreaterThan(0),
    );
  });
});
