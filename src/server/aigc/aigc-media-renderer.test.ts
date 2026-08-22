// @vitest-environment node

import { describe, expect, it } from "vitest";

import { buildFfmpegArguments, parseProbeOutput } from "./aigc-media-renderer";

describe("AIGC 轻剪辑媒体参数", () => {
  it("解析时长、画面尺寸和音轨存在性", () => {
    expect(parseProbeOutput(JSON.stringify({
      format: { duration: "12.345" },
      streams: [{ codec_type: "video", width: 1920, height: 1080 }, { codec_type: "audio" }],
    }))).toEqual({ durationMs: 12345, hasAudio: true, width: 1920, height: 1080 });
    expect(() => parseProbeOutput("not-json")).toThrow("媒体元数据无法解析");
  });

  it("视频工程为图片和静音视频补齐音轨并限制单线程", () => {
    const args = buildFfmpegArguments({
      kind: "video",
      outputPath: "/data/output.mp4",
      clips: [
        { path: "/data/image.png", kind: "image", trimStartMs: 0, durationMs: 3000, muted: false, hasAudio: false },
        { path: "/data/video.mp4", kind: "video", trimStartMs: 1000, durationMs: 5000, muted: true, hasAudio: true },
      ],
    });

    expect(args.filter((value) => value === "anullsrc=r=48000:cl=stereo")).toHaveLength(2);
    expect(args).toContain("libx264");
    expect(args).toContain("veryfast");
    expect(args.slice(-4)).toEqual(["-threads", "1", "-progress", "pipe:1", "/data/output.mp4"].slice(-4));
    expect(args.join(" ")).toContain("concat=n=2:v=1:a=1[outv][outa]");
  });

  it("音频工程统一采样并输出 MP3", () => {
    const args = buildFfmpegArguments({
      kind: "audio",
      outputPath: "/data/output.mp3",
      clips: [{ path: "/data/voice.wav", kind: "audio", trimStartMs: 500, durationMs: 2500, muted: false, hasAudio: true }],
    });

    expect(args).toContain("libmp3lame");
    expect(args.join(" ")).toContain("concat=n=1:v=0:a=1[outa]");
    expect(args).not.toContain("libx264");
  });
});
