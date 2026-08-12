import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiTaskProvider } from "../api-task-provider";
import { ErrorToastProvider } from "../error-toast-provider";
import { KnowledgeRetrievalPage } from "./knowledge-retrieval-page";

function renderKnowledgeRetrievalPage() {
  return render(<ErrorToastProvider><ApiTaskProvider onAuthenticationRequired={vi.fn()}><KnowledgeRetrievalPage /></ApiTaskProvider></ErrorToastProvider>);
}

describe("KnowledgeRetrievalPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("让手动重建与保存按钮使用同一操作栏体系", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      revision: "r1",
      config: { baseUrl: "https://example.test/v1", model: "embedding", batchSize: 16, hasApiKey: true },
    }), { status: 200 })));

    renderKnowledgeRetrievalPage();

    expect(await screen.findByRole("button", { name: "手动重建索引" })).toHaveClass("configuration-secondary-action");
    expect(screen.getByRole("button", { name: "保存配置" })).toHaveClass("configuration-primary-action");
  });

  it("受管内置模型无需 API Key 也可以重建", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      revision: "r1",
      config: { baseUrl: "http://bug-paw-embedding:80/v1", model: "BAAI/bge-small-zh-v1.5", batchSize: 8, hasApiKey: false, isManaged: true },
    }), { status: 200 })));

    renderKnowledgeRetrievalPage();

    expect(await screen.findByRole("button", { name: "手动重建索引" })).toBeEnabled();
    expect(screen.getByText("内置服务无需 API Key；保存可改为外部服务")).toBeInTheDocument();
  });

  it("受管内置模型将每批切片数限制为 4", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      revision: "r1",
      config: { baseUrl: "http://bug-paw-embedding:80/v1", model: "BAAI/bge-small-zh-v1.5", batchSize: 4, hasApiKey: false, isManaged: true },
    }), { status: 200 })));

    renderKnowledgeRetrievalPage();

    expect(await screen.findByLabelText("每批切片数")).toHaveAttribute("max", "4");
    expect(screen.getByText("内置服务单次最多处理 4 个切片。" )).toBeInTheDocument();
  });

  it("展示语义检索开关并保存关闭状态", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      revision: "r1",
      config: { baseUrl: "http://bug-paw-embedding:80/v1", model: "BAAI/bge-small-zh-v1.5", batchSize: 8, hasApiKey: false, isManaged: true, enabled: true },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    renderKnowledgeRetrievalPage();

    const embeddingCard = screen.getByRole("heading", { name: "Embedding 模型" }).closest("section");
    expect(embeddingCard).not.toBeNull();
    const enableToggle = embeddingCard!.querySelector<HTMLLabelElement>(":scope > label");
    expect(enableToggle).not.toBeNull();
    expect(enableToggle).toHaveClass("configuration-capability-toggle");
    expect(within(enableToggle!).getByRole("checkbox")).toHaveAccessibleName("启用语义检索");
    const toggle = await screen.findByRole("checkbox", { name: "启用语义检索" });
    expect(toggle).toBeChecked();
    expect(screen.getByText("上传资料会自动建立全文和语义索引。更换模型后请手动重建。")).toBeInTheDocument();
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    const update = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(JSON.parse(String(update?.[1]?.body))).toMatchObject({ config: { enabled: false } });
  });

  it("显示外部 Embedding API Key 时按需填入输入框", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/v1/capabilities/knowledge-retrieval/credential") {
        return new Response(JSON.stringify({ apiKey: "embedding-secret" }), { status: 200 });
      }
      return new Response(JSON.stringify({ revision: "r1", config: { baseUrl: "https://example.test/v1", model: "embedding", batchSize: 16, hasApiKey: true, isManaged: false } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderKnowledgeRetrievalPage();

    await screen.findByLabelText("Embedding API Key");
    fireEvent.click(screen.getByRole("button", { name: "显示Embedding API Key" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/capabilities/knowledge-retrieval/credential", expect.anything()));
    expect(screen.getByLabelText("Embedding API Key")).toHaveAttribute("type", "text");
    expect(screen.getByLabelText("Embedding API Key")).toHaveValue("embedding-secret");
  });

  it("没有缓存时将意外加载错误交给全局 Toast", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network detail"); }));
    renderKnowledgeRetrievalPage();

    expect(await screen.findByRole("group", { name: "操作未完成" })).toBeInTheDocument();
    expect(screen.queryByText("network detail")).not.toBeInTheDocument();
  });
});
