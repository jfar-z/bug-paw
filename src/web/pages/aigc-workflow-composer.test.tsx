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
});
