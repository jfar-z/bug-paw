import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AigcWorkflowDetail } from "../../shared/aigc-contracts";
import { AigcWorkflowComposer } from "./aigc-workflow-composer";

const workflow: AigcWorkflowDetail = {
  id: "workflow-1",
  name: "文生图",
  fileName: "text-to-image.json",
  originalHash: "hash",
  nodes: [
    {
      id: "1",
      type: "CLIPTextEncode",
      title: "正向提示词",
      fields: [
        { name: "inputs.text", kind: "input", valueType: "string" },
        { name: "outputs.CONDITIONING", kind: "output" },
      ],
    },
    {
      id: "2",
      type: "SaveImage",
      title: "保存图片",
      fields: [{ name: "outputs.images", kind: "output" }],
    },
    {
      id: "3",
      type: "LoadImage",
      title: "参考图片",
      fields: [{ name: "inputs.image", kind: "input", valueType: "image" }],
    },
  ],
  edges: [
    { id: "edge-1-2", sourceNodeId: "1", sourceField: "outputs.CONDITIONING", targetNodeId: "2", targetField: "inputs.images" },
    { id: "edge-3-1", sourceNodeId: "3", sourceField: "outputs.IMAGE", targetNodeId: "1", targetField: "inputs.image" },
  ],
  inputMappings: [],
  outputMappings: [],
  createdAt: "2026-08-17T00:00:00.000Z",
  updatedAt: "2026-08-17T00:00:00.000Z",
};

describe("AigcWorkflowComposer", () => {
  it("搜索和浏览节点后需明确选为映射目标", () => {
    const onInputMappingsChange = vi.fn();
    render(
      <AigcWorkflowComposer
        workflow={workflow}
        name="文生图"
        onNameChange={vi.fn()}
        inputMappings={[]}
        outputMappings={[]}
        onInputMappingsChange={onInputMappingsChange}
        onOutputMappingsChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "新增入参" }));
    expect(screen.getByLabelText("入参名称")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("搜索工作流节点"), { target: { value: "CLIPTextEncode" } });
    fireEvent.click(screen.getByRole("button", { name: "浏览节点 正向提示词" }));
    expect(screen.getByLabelText("当前映射目标")).toHaveTextContent("尚未选择");
    fireEvent.click(screen.getByRole("button", { name: "选为映射节点" }));
    fireEvent.click(screen.getByRole("button", { name: /inputs.text/i }));
    fireEvent.change(screen.getByLabelText("入参名称"), { target: { value: "prompt" } });
    fireEvent.click(screen.getByRole("button", { name: "添加映射" }));

    expect(onInputMappingsChange).toHaveBeenCalledTimes(1);
    const mappings = onInputMappingsChange.mock.calls[0][0] as typeof workflow.inputMappings;
    expect(mappings).toHaveLength(1);
    expect(mappings[0]).toMatchObject({
      name: "prompt",
      nodeId: "1",
      field: "inputs.text",
      type: "string",
      required: true,
    });
  });

  it("点击上下游节点只改变当前浏览节点", () => {
    render(
      <AigcWorkflowComposer
        workflow={workflow}
        name="文生图"
        onNameChange={vi.fn()}
        inputMappings={[{ id: "prompt", name: "prompt", nodeId: "1", field: "inputs.text", type: "string", required: true }]}
        outputMappings={[]}
        onInputMappingsChange={vi.fn()}
        onOutputMappingsChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(screen.getByLabelText("当前映射目标")).toHaveTextContent("正向提示词");
    fireEvent.click(screen.getByRole("button", { name: "浏览节点 保存图片" }));

    expect(screen.getByLabelText("当前浏览节点详情")).toHaveTextContent("保存图片");
    expect(screen.getByLabelText("当前映射目标")).toHaveTextContent("正向提示词");
    expect(screen.getByRole("button", { name: "选为映射节点" })).toBeDisabled();
  });

  it("进入节点浏览后可以返回节点列表且保留映射目标", () => {
    render(
      <AigcWorkflowComposer
        workflow={workflow}
        name="文生图"
        onNameChange={vi.fn()}
        inputMappings={[{ id: "prompt", name: "prompt", nodeId: "1", field: "inputs.text", type: "string", required: true }]}
        outputMappings={[]}
        onInputMappingsChange={vi.fn()}
        onOutputMappingsChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect(screen.getByLabelText("当前浏览节点详情")).toHaveTextContent("正向提示词");

    fireEvent.click(screen.getByRole("button", { name: "节点列表" }));

    expect(screen.queryByLabelText("当前浏览节点详情")).not.toBeInTheDocument();
    expect(screen.getByLabelText("节点搜索结果")).toHaveTextContent("正向提示词");
    expect(screen.getByLabelText("当前映射目标")).toHaveTextContent("正向提示词");
  });

  it("保存参数有值时启用的条件节点组", () => {
    const onInputMappingsChange = vi.fn();
    render(
      <AigcWorkflowComposer
        workflow={workflow}
        name="文生图"
        onNameChange={vi.fn()}
        inputMappings={[]}
        outputMappings={[]}
        onInputMappingsChange={onInputMappingsChange}
        onOutputMappingsChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "新增入参" }));
    fireEvent.change(screen.getByLabelText("搜索工作流节点"), { target: { value: "CLIPTextEncode" } });
    fireEvent.click(screen.getByRole("button", { name: "浏览节点 正向提示词" }));
    fireEvent.click(screen.getByRole("button", { name: "选为映射节点" }));
    fireEvent.click(screen.getByLabelText("有值时启用分支"));
    fireEvent.change(screen.getByLabelText("搜索工作流节点"), { target: { value: "LoadImage" } });
    fireEvent.click(screen.getByRole("button", { name: "浏览节点 参考图片" }));
    fireEvent.click(screen.getByLabelText("条件节点 参考图片"));
    fireEvent.change(screen.getByLabelText("入参名称"), { target: { value: "reference_image" } });
    fireEvent.click(screen.getByRole("button", { name: "添加映射" }));

    const mappings = onInputMappingsChange.mock.calls[0][0] as typeof workflow.inputMappings;
    expect(mappings[0]).toMatchObject({
      name: "reference_image",
      required: false,
      activation: { when: "provided", nodeIds: ["1", "3"] },
    });
  });

  it("删除映射前先说明对运行产物的影响", () => {
    const onOutputMappingsChange = vi.fn();
    render(
      <AigcWorkflowComposer
        workflow={workflow}
        name="文生图"
        onNameChange={vi.fn()}
        inputMappings={[]}
        outputMappings={[{ id: "output-1", name: "成品图", nodeId: "2", field: "outputs.images", mediaType: "image" }]}
        onInputMappingsChange={vi.fn()}
        onOutputMappingsChange={onOutputMappingsChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(screen.getByRole("dialog", { name: "删除输出“成品图”？" })).toBeInTheDocument();
    expect(onOutputMappingsChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "删除输出" }));
    expect(onOutputMappingsChange).toHaveBeenCalledWith([]);
  });

  it("输出映射复用拓扑浏览且需明确选择目标", () => {
    const onOutputMappingsChange = vi.fn();
    render(
      <AigcWorkflowComposer
        workflow={workflow}
        name="文生图"
        onNameChange={vi.fn()}
        inputMappings={[]}
        outputMappings={[]}
        onInputMappingsChange={vi.fn()}
        onOutputMappingsChange={onOutputMappingsChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "新增输出" }));
    fireEvent.change(screen.getByLabelText("搜索工作流节点"), { target: { value: "SaveImage" } });
    fireEvent.click(screen.getByRole("button", { name: "浏览节点 保存图片" }));
    expect(screen.getByLabelText("当前映射目标")).toHaveTextContent("尚未选择");
    fireEvent.click(screen.getByRole("button", { name: "选为映射节点" }));
    fireEvent.change(screen.getByLabelText("输出名称"), { target: { value: "result" } });
    fireEvent.click(screen.getByRole("button", { name: "添加输出" }));

    expect(onOutputMappingsChange).toHaveBeenCalledWith([
      expect.objectContaining({ name: "result", nodeId: "2", field: "outputs.images", mediaType: "image" }),
    ]);
  });

  it("输入和输出映射均提供音频类型", () => {
    render(
      <AigcWorkflowComposer
        workflow={workflow}
        name="文生图"
        onNameChange={vi.fn()}
        inputMappings={[]}
        outputMappings={[]}
        onInputMappingsChange={vi.fn()}
        onOutputMappingsChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "新增入参" }));
    expect(screen.getByLabelText("入参类型")).toContainHTML('<option value="audio">音频（audio）</option>');
    fireEvent.click(screen.getByRole("button", { name: "关闭入参编辑" }));
    fireEvent.click(screen.getByRole("button", { name: "新增输出" }));
    expect(screen.getByLabelText("输出媒体类型")).toContainHTML('<option value="audio">音频（audio）</option>');
  });
});
