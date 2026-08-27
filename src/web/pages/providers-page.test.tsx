import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiTaskProvider } from "../api-task-provider";
import { ErrorToastProvider } from "../error-toast-provider";
import { ProvidersPage } from "./providers-page";

function renderProvidersPage() {
  return render(<ErrorToastProvider><ApiTaskProvider onAuthenticationRequired={vi.fn()}><ProvidersPage /></ApiTaskProvider></ErrorToastProvider>);
}

describe("ProvidersPage", () => {

it("创建成功后自动选中新 Provider 并可立即保存 API Key", async () => {
    const example = { name: "Example", baseUrl: "https://api.example.com/v1", api: "openai-completions", models: [] };
    const created = { name: "Created", baseUrl: "https://created.example.test/v1", api: "openai-completions", authHeader: true, models: [] };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/providers" && init?.method === "POST") {
        return new Response(JSON.stringify({ revision: "r2", diagnostics: [], value: { providers: { example, created } } }), { status: 200 });
      }
      if (url === "/api/v1/providers/created/credential" && init?.method === "PUT") {
        return new Response(JSON.stringify({ credentialRevision: "c2", status: { providerId: "created", type: "api_key", configured: true } }), { status: 200 });
      }
      return new Response(JSON.stringify({ revision: "r1", credentialRevision: "c1", credentials: [], diagnostics: [], value: { providers: { example } } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderProvidersPage();

    fireEvent.click(await screen.findByRole("button", { name: "新建 Provider" }));
    const dialog = screen.getByRole("dialog", { name: "新建 Provider" });
    fireEvent.change(within(dialog).getByLabelText("Provider ID"), { target: { value: "created" } });
    fireEvent.change(within(dialog).getByLabelText("显示名称"), { target: { value: "Created" } });
    fireEvent.change(within(dialog).getByLabelText("Base URL"), { target: { value: "https://created.example.test/v1" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建 Provider" }));

    expect(await screen.findByText("Provider 已创建，请继续配置 API Key")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "新建 Provider" })).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("Created")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "test-provider-key" } });
    fireEvent.click(screen.getByRole("button", { name: "保存凭证" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/providers/created/credential", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ revision: "c1", apiKey: "test-provider-key" }),
    })));
  });

});
