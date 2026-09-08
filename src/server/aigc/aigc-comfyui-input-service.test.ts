import { describe, expect, it } from "vitest";

import { parseNodeMetadata } from "./aigc-comfyui-input-service";

describe("ComfyUI 节点定义解析", () => {
  it.each([
    { flag: "image_upload", expectedType: "image", comfyType: "IMAGE" },
    { flag: "video_upload", expectedType: "video", comfyType: "VIDEO" },
    { flag: "audio_upload", expectedType: "audio", comfyType: "AUDIO" },
  ] as const)("识别 $flag 媒体上传字段", ({ flag, expectedType, comfyType }) => {
    const metadata = parseNodeMetadata({
      LoadMedia: {
        input: {
          required: {
            file: ["COMBO", { options: ["default.mp4"], [flag]: true }],
          },
        },
      },
    }, "LoadMedia");

    expect(metadata?.fields["inputs.file"]).toMatchObject({ comfyType, valueType: expectedType, required: true });
    expect(metadata?.widgetInputs).toEqual([{ name: "file" }]);
  });
});
