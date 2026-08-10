// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CredentialService } from "./configuration/credential-service";
import type { ModelConfigService } from "./configuration/model-config-service";
import { ProviderModelDiscoveryError, createProviderModelDiscovery } from "./provider-model-discovery";

function createModels(providers: Record<string, Record<string, unknown>>) {
  return {
    read: vi.fn(async () => ({ revision: "models-r1", value: { providers }, diagnostics: [] })),
  } as unknown as ModelConfigService;
}

function createCredentials(apiKey = "key-from-auth") {
  return {
    getApiKey: vi.fn(async () => apiKey),
  } as unknown as CredentialService;
}

function exampleProvider(overrides: Record<string, unknown> = {}) {
  return {
    name: "Example",
    api: "openai-completions",
    baseUrl: "https://gateway.example",
    authHeader: true,
    headers: { "X-Tenant": "acme" },
    models: [{ id: "a", name: "已有模型" }],
    ...overrides,
  };
}

describe("ProviderModelDiscovery", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("以保存的 OpenAI Provider 配置请求模型目录并标记已有模型", async () => {
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      expect(String(url)).toBe("https://gateway.example/v1/models");
      expect(init?.method).toBe("GET");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer key-from-auth", "X-Tenant": "acme" });
      return Response.json({ data: [{ id: "z" }, { id: "a" }, { id: "a" }, { id: "" }, { id: 1 }] });
    });
    const service = createProviderModelDiscovery({
      models: createModels({ example: exampleProvider() }),
      credentials: createCredentials(),
      fetch: fetchMock as typeof fetch,
    });

    await expect(service.discover("example")).resolves.toEqual({
      providerId: "example",
      models: [
        { id: "a", name: "a", exists: true },
        { id: "z", name: "z", exists: false },
      ],
    });
  });

  it.each([
    ["https://host/v1/", "https://host/v1/models"],
    ["https://host/api", "https://host/api/v1/models"],
  ])("规范化模型目录 URL: %s", async (baseUrl, expectedUrl) => {
    const fetchMock = vi.fn(async (_url: URL | string, _init?: RequestInit) => Response.json({ data: [] }));
    const service = createProviderModelDiscovery({
      models: createModels({ example: exampleProvider({ baseUrl }) }),
      credentials: createCredentials(),
      fetch: fetchMock as typeof fetch,
    });

    await service.discover("example");
    expect(fetchMock).toHaveBeenCalledWith(expectedUrl, expect.any(Object));
  });

  it("认证关闭或用户配置 Authorization 时不覆盖请求头", async () => {
    const fetchMock = vi.fn(async (_url: URL | string, _init?: RequestInit) => Response.json({ data: [] }));
    const service = createProviderModelDiscovery({
      models: createModels({
        withoutAuth: exampleProvider({ authHeader: false }),
        customAuth: exampleProvider({ headers: { authorization: "Custom saved-auth" } }),
      }),
      credentials: createCredentials(),
      fetch: fetchMock as typeof fetch,
    });

    await service.discover("withoutAuth");
    await service.discover("customAuth");

    expect(fetchMock.mock.calls[0]?.[1]).not.toMatchObject({ headers: expect.objectContaining({ Authorization: expect.anything() }) });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ headers: { authorization: "Custom saved-auth" } });
  });

  it("丢弃把实际请求凭证裸回显为模型 ID 的恶意目录项", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      data: [
        { id: "real-model" },
        { id: "key-from-auth" },
        { id: "prefix-key-from-auth-suffix" },
        { id: "tenant-secret" },
      ],
    }));
    const service = createProviderModelDiscovery({
      models: createModels({ example: exampleProvider({ headers: { "X-Tenant": "tenant-secret" } }) }),
      credentials: createCredentials("key-from-auth"),
      fetch: fetchMock as typeof fetch,
    });

    await expect(service.discover("example")).resolves.toEqual({
      providerId: "example",
      models: [{ id: "real-model", name: "real-model", exists: false }],
    });
  });

  it.each([
    ["missing", "PROVIDER_NOT_FOUND"],
    ["anthropic", "UNSUPPORTED_PROVIDER_API"],
  ])("拒绝不可发现的 Provider: %s", async (providerId, code) => {
    const service = createProviderModelDiscovery({
      models: createModels({ anthropic: exampleProvider({ api: "anthropic-messages" }) }),
      credentials: createCredentials(),
      fetch: vi.fn() as typeof fetch,
    });

    await expect(service.discover(providerId)).rejects.toMatchObject({ code });
  });

  it("同一 Provider 并发发现返回稳定冲突错误", async () => {
    let resolveFetch: (response: Response) => void = () => undefined;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    const service = createProviderModelDiscovery({
      models: createModels({ example: exampleProvider() }),
      credentials: createCredentials(),
      fetch: fetchMock as typeof fetch,
    });

    const first = service.discover("example");
    await expect(service.discover("example")).rejects.toMatchObject({ code: "MODEL_DISCOVERY_IN_PROGRESS" });
    resolveFetch(Response.json({ data: [] }));
    await expect(first).resolves.toEqual({ providerId: "example", models: [] });
  });

  it("超时和失败信息不会泄露凭证或 URL 用户信息", async () => {
    vi.useFakeTimers();
    const secret = "Bearer top-secret";
    const fetchMock = vi.fn((_url: URL | string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const service = createProviderModelDiscovery({
      models: createModels({ example: exampleProvider({ baseUrl: "https://user:password@gateway.example" }) }),
      credentials: createCredentials(secret),
      fetch: fetchMock as typeof fetch,
    });

    const pending = service.discover("example");
    const timeoutExpectation = expect(pending).rejects.toMatchObject({ code: "MODEL_DISCOVERY_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(20_000);
    await timeoutExpectation;

    const failed = createProviderModelDiscovery({
      models: createModels({ example: exampleProvider() }),
      credentials: createCredentials(secret),
      fetch: vi.fn(async () => { throw new Error("Authorization: Bearer top-secret Cookie: secret https://user:password@gateway.example"); }) as typeof fetch,
    });
    await expect(failed.discover("example")).rejects.toSatisfy((error: ProviderModelDiscoveryError) => {
      return error.code === "MODEL_DISCOVERY_FAILED"
        && !error.message.includes("top-secret")
        && !error.message.includes("password")
        && !error.message.includes("Cookie:")
        && Array.from(error.message).length <= 500;
    });
  });

  it("响应头已返回后仍对无限慢的响应主体执行硬截止", async () => {
    vi.useFakeTimers();
    const body = new ReadableStream<Uint8Array>({
      start() {
        // 故意永不发送数据或关闭，用于验证主体读取截止时间。
      },
    });
    const service = createProviderModelDiscovery({
      models: createModels({ example: exampleProvider() }),
      credentials: createCredentials(),
      fetch: vi.fn(async () => new Response(body)) as typeof fetch,
    });

    const pending = service.discover("example");
    const expectation = expect(pending).rejects.toMatchObject({ code: "MODEL_DISCOVERY_TIMEOUT" });
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(20_000);
    await expectation;
  });
});
