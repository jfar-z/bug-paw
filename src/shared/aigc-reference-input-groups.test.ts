import { describe, expect, it } from "vitest";

import type { AigcWorkflowDetail } from "./aigc-contracts";
import { commonReferenceInputFields, referenceInputFamilies, traceReferenceInputBranches } from "./aigc-reference-input-groups";

describe("AIGC 参考输入组拓扑", () => {
  it("按汇总接口顺序识别图片、视频和音频系列", () => {
    const workflow = referenceWorkflow();
    expect(referenceInputFamilies(workflow, "73")).toEqual([
      { prefix: "inputs.ref_images", targetFields: ["inputs.ref_images.0", "inputs.ref_images.1"] },
      { prefix: "inputs.ref_videos", targetFields: ["inputs.ref_videos.0", "inputs.ref_videos.1"] },
      { prefix: "inputs.ref_video_audios", targetFields: ["inputs.ref_video_audios.0", "inputs.ref_video_audios.1"] },
      { prefix: "inputs.ref_audios", targetFields: ["inputs.ref_audios.0"] },
    ]);
  });

  it("把视频加载与元素提取识别为同一私有分支", () => {
    const workflow = referenceWorkflow();
    const branches = traceReferenceInputBranches(workflow, "73", "inputs.ref_videos");
    expect(branches).toEqual([
      { rootNodeId: "136", targetField: "inputs.ref_videos.0", activationNodeIds: ["136", "137"] },
      { rootNodeId: "138", targetField: "inputs.ref_videos.1", activationNodeIds: ["138", "139"] },
    ]);
    expect(commonReferenceInputFields(workflow, branches)).toEqual(["inputs.file"]);
  });

  it("拒绝汇总节点之前已经交叉的分支", () => {
    const workflow = referenceWorkflow();
    workflow.edges.push({ id: "shared", sourceNodeId: "137", sourceField: "outputs.images", targetNodeId: "139", targetField: "inputs.video" });
    expect(() => traceReferenceInputBranches(workflow, "73", "inputs.ref_videos")).toThrow("多个上游");
  });
});

function referenceWorkflow(): AigcWorkflowDetail {
  return {
    id: "reference-workflow",
    name: "参考生视频",
    fileName: "reference.json",
    originalHash: "hash",
    nodes: [
      { id: "75", type: "LoadImage", fields: [{ name: "outputs.IMAGE", kind: "output" }] },
      { id: "76", type: "LoadImage", fields: [{ name: "outputs.IMAGE", kind: "output" }] },
      { id: "136", type: "LoadVideo", fields: [{ name: "outputs.VIDEO", kind: "output" }] },
      { id: "137", type: "GetVideoComponents", fields: [{ name: "inputs.video", kind: "input" }, { name: "outputs.images", kind: "output" }, { name: "outputs.audio", kind: "output" }] },
      { id: "138", type: "LoadVideo", fields: [{ name: "outputs.VIDEO", kind: "output" }] },
      { id: "139", type: "GetVideoComponents", fields: [{ name: "inputs.video", kind: "input" }, { name: "outputs.images", kind: "output" }, { name: "outputs.audio", kind: "output" }] },
      { id: "78", type: "LoadAudio", fields: [{ name: "outputs.AUDIO", kind: "output" }] },
      { id: "73", type: "ReferenceInputs", fields: [
        { name: "inputs.ref_images.0", kind: "input" }, { name: "inputs.ref_images.1", kind: "input" },
        { name: "inputs.ref_videos.0", kind: "input" }, { name: "inputs.ref_videos.1", kind: "input" },
        { name: "inputs.ref_video_audios.0", kind: "input" }, { name: "inputs.ref_video_audios.1", kind: "input" },
        { name: "inputs.ref_audios.0", kind: "input" },
      ] },
    ],
    edges: [
      { id: "image-0", sourceNodeId: "75", sourceField: "outputs.IMAGE", targetNodeId: "73", targetField: "inputs.ref_images.0" },
      { id: "image-1", sourceNodeId: "76", sourceField: "outputs.IMAGE", targetNodeId: "73", targetField: "inputs.ref_images.1" },
      { id: "video-load-0", sourceNodeId: "136", sourceField: "outputs.VIDEO", targetNodeId: "137", targetField: "inputs.video" },
      { id: "video-0", sourceNodeId: "137", sourceField: "outputs.images", targetNodeId: "73", targetField: "inputs.ref_videos.0" },
      { id: "video-audio-0", sourceNodeId: "137", sourceField: "outputs.audio", targetNodeId: "73", targetField: "inputs.ref_video_audios.0" },
      { id: "video-load-1", sourceNodeId: "138", sourceField: "outputs.VIDEO", targetNodeId: "139", targetField: "inputs.video" },
      { id: "video-1", sourceNodeId: "139", sourceField: "outputs.images", targetNodeId: "73", targetField: "inputs.ref_videos.1" },
      { id: "video-audio-1", sourceNodeId: "139", sourceField: "outputs.audio", targetNodeId: "73", targetField: "inputs.ref_video_audios.1" },
      { id: "audio-0", sourceNodeId: "78", sourceField: "outputs.AUDIO", targetNodeId: "73", targetField: "inputs.ref_audios.0" },
    ],
    inputMappings: [],
    inputGroups: [],
    outputMappings: [],
    nodeMetadata: {
      LoadImage: { fields: { "inputs.image": { comfyType: "IMAGE", valueType: "image" } } },
      LoadVideo: { fields: { "inputs.file": { comfyType: "COMBO", valueType: "enum", enumOptions: ["sample.mp4"] } } },
      LoadAudio: { fields: { "inputs.audio": { comfyType: "COMBO", valueType: "enum", enumOptions: ["sample.wav"] } } },
    },
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
  };
}
