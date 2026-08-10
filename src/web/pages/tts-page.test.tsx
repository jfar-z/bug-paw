import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TtsPage } from "./tts-page";

describe("TtsPage", () => {
  it("说明 PCM 低延时播放需要上游流式支持", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ revision: "r1", profiles: [] }))));
    render(<TtsPage />);

    expect(screen.getByText(/仅对 PCM 启用边接收边播放/)).toBeInTheDocument();
    expect(screen.getByText(/上游接口.*分块流式响应/)).toBeInTheDocument();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("让删除与保存按钮使用相同的操作栏尺寸体系", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      revision: "r1",
      profiles: [{ id: "profile-1", name: "默认语音", baseUrl: "https://example.test/v1", model: "speech", voice: "alloy", responseFormat: "mp3", hasApiKey: true }],
    }), { status: 200 })));

    render(<TtsPage />);

    expect(await screen.findByRole("button", { name: "删除" })).toHaveClass("configuration-secondary-action", "configuration-secondary-action--danger");
    expect(screen.getByRole("button", { name: "保存配置" })).toHaveClass("configuration-primary-action");
  });
});
