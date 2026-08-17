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
  ],
  edges: [],
  inputMappings: [],
  outputMappings: [],
  createdAt: "2026-08-17T00:00:00.000Z",
  updatedAt: "2026-08-17T00:00:00.000Z",
};

describe("AigcWorkflowComposer", () => {
  it("可通过点选节点和字段新增一条入参映射", () => {
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

    fireEvent.click(screen.getByRole("button", { name: /CLIPTextEncode/i }));
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
