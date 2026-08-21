import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AigcWorkflowDetail } from "../../shared/aigc-contracts";
import { AigcWorkflowComposer, reorderInputMappings } from "./aigc-workflow-composer";

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
  it("按顶层参数排序并保持参考组成员顺序", () => {
    const mappings = [
      { id: "prompt", name: "prompt", nodeId: "1", field: "inputs.text", type: "string" as const, required: true },
      { id: "video-1", name: "video_1", nodeId: "3", field: "inputs.video", type: "video" as const, required: false },
      { id: "video-2", name: "video_2", nodeId: "4", field: "inputs.video", type: "video" as const, required: false },
      { id: "width", name: "width", nodeId: "1", field: "inputs.width", type: "int" as const, required: true },
    ];
    const result = reorderInputMappings(mappings, [{ id: "videos", label: "参考视频", type: "video", mappingIds: ["video-1", "video-2"], boundaryNodeId: "9", targetFieldPrefix: "inputs.references" }], "videos", "prompt");
    expect(result.map((mapping) => mapping.id)).toEqual(["video-1", "video-2", "prompt", "width"]);
  });

  it("拖动输出参数可逐项改变顺序", () => {
    const onOutputMappingsChange = vi.fn();
    render(<AigcWorkflowComposer workflow={workflow} name="文生图" onNameChange={vi.fn()} inputMappings={[]} outputMappings={[{ id: "preview", name: "预览图", nodeId: "2", field: "outputs.images", mediaType: "image" }, { id: "final", name: "成品图", nodeId: "2", field: "outputs.images", mediaType: "image" }]} onInputMappingsChange={vi.fn()} onOutputMappingsChange={onOutputMappingsChange} />);

    fireEvent.dragStart(screen.getByRole("button", { name: "拖动调整成品图顺序" }));
    const target = screen.getByRole("button", { name: "拖动调整预览图顺序" }).closest("article");
    expect(target).not.toBeNull();
    fireEvent.dragOver(target!);
    fireEvent.drop(target!);
    expect(onOutputMappingsChange.mock.calls[0][0].map((mapping: { id: string }) => mapping.id)).toEqual(["final", "preview"]);
  });

  it("从汇总接口倒推视频加载链并使用用户指定类型", () => {
    const onInputMappingsChange = vi.fn();
    const onInputGroupsChange = vi.fn();
    const videoWorkflow: AigcWorkflowDetail = {
      ...workflow,
      nodes: [
        { id: "10", type: "LoadVideo", title: "视频一", fields: [{ name: "inputs.file", kind: "input" }] },
        { id: "11", type: "GetVideoComponents", fields: [] },
        { id: "20", type: "LoadVideo", title: "视频二", fields: [{ name: "inputs.file", kind: "input" }] },
        { id: "21", type: "GetVideoComponents", fields: [] },
        { id: "30", type: "ReferenceInputs", title: "参考汇总", fields: [{ name: "inputs.ref_videos.ref_video_0", kind: "input" }, { name: "inputs.ref_videos.ref_video_1", kind: "input" }] },
      ],
      edges: [
        { id: "a", sourceNodeId: "10", sourceField: "outputs.video", targetNodeId: "11", targetField: "inputs.video" },
        { id: "b", sourceNodeId: "11", sourceField: "outputs.frames", targetNodeId: "30", targetField: "inputs.ref_videos.ref_video_0" },
        { id: "c", sourceNodeId: "20", sourceField: "outputs.video", targetNodeId: "21", targetField: "inputs.video" },
        { id: "d", sourceNodeId: "21", sourceField: "outputs.frames", targetNodeId: "30", targetField: "inputs.ref_videos.ref_video_1" },
      ],
    };
    render(<AigcWorkflowComposer workflow={videoWorkflow} name="视频" onNameChange={vi.fn()} inputMappings={[]} inputGroups={[]} outputMappings={[]} onInputMappingsChange={onInputMappingsChange} onInputGroupsChange={onInputGroupsChange} onOutputMappingsChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "创建参考组" }));
    fireEvent.change(screen.getByLabelText("搜索参考组汇总节点"), { target: { value: "ReferenceInputs" } });
    expect(screen.getByRole("option", { name: "#30 参考汇总 · ReferenceInputs" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("搜索参考组汇总节点"), { target: { value: "不存在的节点" } });
    expect(screen.getByRole("option", { name: "没有匹配的节点" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("搜索参考组汇总节点"), { target: { value: "30" } });
    fireEvent.change(screen.getByLabelText("参考组汇总节点"), { target: { value: "30" } });
    expect(screen.getByLabelText("搜索参考组汇总节点")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("参考组名称"), { target: { value: "参考视频" } });
    fireEvent.change(screen.getByLabelText("参考组参数前缀"), { target: { value: "reference_video" } });
    fireEvent.change(screen.getByLabelText("参考组输入类型"), { target: { value: "video" } });
    fireEvent.click(screen.getAllByRole("button", { name: "创建参考组" })[1]);

    const nextMappings = onInputMappingsChange.mock.calls[0][0];
    expect(nextMappings).toEqual([
      expect.objectContaining({ nodeId: "10", field: "inputs.file", type: "video", activation: { when: "provided", nodeIds: ["10", "11"] } }),
      expect.objectContaining({ nodeId: "20", field: "inputs.file", type: "video", activation: { when: "provided", nodeIds: ["20", "21"] } }),
    ]);
    expect(onInputGroupsChange).toHaveBeenCalledWith([expect.objectContaining({ label: "参考视频", type: "video", mappingIds: nextMappings.map((mapping: { id: string }) => mapping.id) })]);
  });
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

  it("节点超过十二个时仍可通过滚动列表访问全部可映射节点", () => {
    const extendedNodes: AigcWorkflowDetail["nodes"] = Array.from({ length: 13 }, (_, index) => {
      const id = String(index + 4);
      return {
        id,
        type: "CustomInputNode",
        title: `扩展节点 ${id}`,
        fields: [{ name: "inputs.value", kind: "input", valueType: "string" }],
      };
    });
    const largeWorkflow: AigcWorkflowDetail = {
      ...workflow,
      nodes: [...workflow.nodes, ...extendedNodes],
    };

    render(
      <AigcWorkflowComposer
        workflow={largeWorkflow}
        name="大型工作流"
        onNameChange={vi.fn()}
        inputMappings={[]}
        outputMappings={[]}
        onInputMappingsChange={vi.fn()}
        onOutputMappingsChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "新增入参" }));

    expect(screen.getByText("16 节点")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "浏览节点 扩展节点 16" })).toBeInTheDocument();
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

  it("媒体输出只选择节点并自动识别输出槽位", () => {
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
    fireEvent.click(screen.getByRole("button", { name: "选为映射节点" }));

    expect(screen.getByText(/自动扫描该节点的输出槽位/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /outputs.images/i })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("输出名称"), { target: { value: "result" } });
    fireEvent.click(screen.getByRole("button", { name: "添加输出" }));

    expect(onOutputMappingsChange).toHaveBeenCalledWith([
      expect.objectContaining({ name: "result", nodeId: "2", field: "outputs.images", mediaType: "image" }),
    ]);
  });

  it("文本或 JSON 输出仍需要选择具体字段", () => {
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

    fireEvent.click(screen.getByRole("button", { name: "新增输出" }));
    fireEvent.change(screen.getByLabelText("搜索工作流节点"), { target: { value: "SaveImage" } });
    fireEvent.click(screen.getByRole("button", { name: "浏览节点 保存图片" }));
    fireEvent.click(screen.getByRole("button", { name: "选为映射节点" }));
    fireEvent.change(screen.getByLabelText("输出媒体类型"), { target: { value: "json" } });

    expect(screen.getByRole("button", { name: /outputs.images/i })).toBeInTheDocument();
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

  it("按节点元数据选择浮点类型并保留数值草稿到提交", () => {
    const onInputMappingsChange = vi.fn();
    const metadataWorkflow: AigcWorkflowDetail = {
      ...workflow,
      nodes: [...workflow.nodes, { id: "4", type: "KSampler", title: "采样器", fields: [{ name: "inputs.cfg", kind: "input", valueType: "int" }] }],
      nodeMetadata: { KSampler: { fields: { "inputs.cfg": { comfyType: "FLOAT", valueType: "double", min: -1, max: 20, step: 0.1 } } } },
    };
    render(
      <AigcWorkflowComposer
        workflow={metadataWorkflow}
        name="文生图"
        onNameChange={vi.fn()}
        inputMappings={[]}
        outputMappings={[]}
        onInputMappingsChange={onInputMappingsChange}
        onOutputMappingsChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "新增入参" }));
    fireEvent.change(screen.getByLabelText("搜索工作流节点"), { target: { value: "KSampler" } });
    fireEvent.click(screen.getByRole("button", { name: "浏览节点 采样器" }));
    fireEvent.click(screen.getByRole("button", { name: "选为映射节点" }));
    expect(screen.getByLabelText("入参类型")).toHaveValue("double");
    expect(screen.getByText("FLOAT · -1–20 · 步进 0.1")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("入参默认值"), { target: { value: "-" } });
    expect(screen.getByLabelText("入参默认值")).toHaveValue("-");
    fireEvent.change(screen.getByLabelText("入参默认值"), { target: { value: "-0.5" } });
    fireEvent.click(screen.getByRole("button", { name: "添加映射" }));
    expect(onInputMappingsChange).toHaveBeenCalledWith([expect.objectContaining({ type: "double", defaultValue: -0.5 })]);
  });

  it("编辑旧字符串映射时可改为节点定义提供的枚举类型", () => {
    const onInputMappingsChange = vi.fn();
    const metadataWorkflow: AigcWorkflowDetail = {
      ...workflow,
      nodes: [{ id: "1", type: "ResolutionSelector", title: "分辨率", fields: [{ name: "inputs.aspect_ratio", kind: "input", valueType: "string" }] }],
      nodeMetadata: { ResolutionSelector: { fields: { "inputs.aspect_ratio": { comfyType: "COMBO", valueType: "enum", enumOptions: ["1:1", "16:9"] } } } },
      inputMappings: [{ id: "ratio", name: "比例", nodeId: "1", field: "inputs.aspect_ratio", type: "string", required: true }],
    };
    render(
      <AigcWorkflowComposer
        workflow={metadataWorkflow}
        name="文生图"
        onNameChange={vi.fn()}
        inputMappings={metadataWorkflow.inputMappings}
        outputMappings={[]}
        onInputMappingsChange={onInputMappingsChange}
        onOutputMappingsChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.change(screen.getByLabelText("入参类型"), { target: { value: "enum" } });
    fireEvent.change(screen.getByLabelText("入参默认值"), { target: { value: "string:16:9" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));

    expect(onInputMappingsChange).toHaveBeenCalledWith([expect.objectContaining({
      id: "ratio",
      type: "enum",
      enumOptions: ["1:1", "16:9"],
      defaultValue: "16:9",
    })]);
  });

  it("选择 Primitive 实例时自动使用下游推导的枚举值域", () => {
    const onInputMappingsChange = vi.fn();
    const primitiveWorkflow: AigcWorkflowDetail = {
      ...workflow,
      nodes: [{
        id: "144",
        type: "PrimitiveNode",
        title: "宽高比",
        fields: [
          { name: "outputs.COMBO", kind: "output" },
          { name: "widgets_values.0", kind: "widget", valueType: "string" },
        ],
      }],
      edges: [],
      resolvedFieldMetadata: {
        "144": {
          "widgets_values.0": {
            comfyType: "COMBO",
            valueType: "enum",
            enumOptions: ["1:1", "16:9"],
            source: "inferred",
            inferredFrom: [{ nodeId: "57", field: "inputs.aspect_ratio" }],
          },
        },
      },
    };
    render(
      <AigcWorkflowComposer
        workflow={primitiveWorkflow}
        name="动态宽高比"
        onNameChange={vi.fn()}
        inputMappings={[]}
        outputMappings={[]}
        onInputMappingsChange={onInputMappingsChange}
        onOutputMappingsChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "新增入参" }));
    fireEvent.click(screen.getByRole("button", { name: "浏览节点 宽高比" }));
    fireEvent.click(screen.getByRole("button", { name: "选为映射节点" }));
    expect(screen.getByLabelText("入参类型")).toHaveValue("enum");
    fireEvent.change(screen.getByLabelText("入参名称"), { target: { value: "aspect_ratio" } });
    fireEvent.change(screen.getByLabelText("入参默认值"), { target: { value: "string:16:9" } });
    fireEvent.click(screen.getByRole("button", { name: "添加映射" }));

    expect(onInputMappingsChange).toHaveBeenCalledWith([expect.objectContaining({
      nodeId: "144",
      field: "widgets_values.0",
      type: "enum",
      enumOptions: ["1:1", "16:9"],
      defaultValue: "16:9",
    })]);
  });
});
