import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KnowledgeRetrievalPage } from "./knowledge-retrieval-page";

describe("KnowledgeRetrievalPage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("让手动重建与保存按钮使用同一操作栏体系", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      revision: "r1",
      config: { baseUrl: "https://example.test/v1", model: "embedding", batchSize: 16, hasApiKey: true },
    }), { status: 200 })));

    render(<KnowledgeRetrievalPage />);

    expect(await screen.findByRole("button", { name: "手动重建索引" })).toHaveClass("configuration-secondary-action");
    expect(screen.getByRole("button", { name: "保存配置" })).toHaveClass("configuration-primary-action");
  });

  it("受管内置模型无需 API Key 也可以重建", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      revision: "r1",
      config: { baseUrl: "http://bug-paw-embedding:80/v1", model: "BAAI/bge-small-zh-v1.5", batchSize: 8, hasApiKey: false, isManaged: true },
    }), { status: 200 })));

    render(<KnowledgeRetrievalPage />);

    expect(await screen.findByRole("button", { name: "手动重建索引" })).toBeEnabled();
    expect(screen.getByText("内置服务无需 API Key；保存可改为外部服务")).toBeInTheDocument();
  });

  it("展示语义检索开关并保存关闭状态", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      revision: "r1",
      config: { baseUrl: "http://bug-paw-embedding:80/v1", model: "BAAI/bge-small-zh-v1.5", batchSize: 8, hasApiKey: false, isManaged: true, enabled: true },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<KnowledgeRetrievalPage />);

    const toggle = await screen.findByRole("checkbox", { name: "启用语义检索" });
    expect(toggle).toBeChecked();
    expect(screen.getByText("上传资料会自动建立全文和语义索引。更换模型后请手动重建。")).toBeInTheDocument();
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    const update = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(JSON.parse(String(update?.[1]?.body))).toMatchObject({ config: { enabled: false } });
  });
});
