import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiTaskProvider } from "../api-task-provider";
import { ErrorToastProvider } from "../error-toast-provider";
import { AigcWorkbenchPage } from "./aigc-workbench-page";

function renderAigcRunPage() {
  return render(
    <ErrorToastProvider>
      <ApiTaskProvider onAuthenticationRequired={vi.fn()}>
        <AigcWorkbenchPage route={{ page: "aigc-run" }} />
      </ApiTaskProvider>
    </ErrorToastProvider>,
  );
}

describe("AigcWorkbenchPage 创作台", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("选择已启用接口后展示提示词表单并提交生成任务", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/aigc/interfaces") {
        return new Response(JSON.stringify({
          revision: "r1",
          interfaces: [{
            id: "interface-1",
            name: "OpenAI 文生图",
            description: "标准文生图",
            protocol: "openai",
            capability: "text-to-image",
            channelId: "channel-1",
            enabled: true,
            toolPublishEnabled: false,
            config: { model: "gpt-image-1" },
            createdAt: "2026-08-17T00:00:00.000Z",
            updatedAt: "2026-08-17T00:00:00.000Z",
          }],
        }));
      }
      if (String(input) === "/api/v1/aigc/tasks" && init?.method === "POST") {
        return new Response(JSON.stringify({
          id: "task-1",
          interfaceId: "interface-1",
          interfaceName: "OpenAI 文生图",
          channelId: "channel-1",
          status: "queued",
          inputs: { prompt: "一只在太空中的猫" },
          assets: [],
          createdAt: "2026-08-17T00:00:00.000Z",
          updatedAt: "2026-08-17T00:00:00.000Z",
        }), { status: 202 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderAigcRunPage();

    expect(await screen.findByLabelText("AIGC 接口")).toHaveValue("interface-1");
    expect(await screen.findByLabelText("提示词")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "开始生成" }));
    expect(await screen.findByText("请填写 提示词")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);

    fireEvent.change(screen.getByLabelText("提示词"), { target: { value: "一只在太空中的猫" } });
    fireEvent.click(screen.getByRole("button", { name: "开始生成" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST" && String(init.body).includes("一只在太空中的猫"))).toBe(true));
    expect(await screen.findByText("查看任务详情")).toHaveAttribute("href", "/aigc/tasks/task-1");
  });
});
