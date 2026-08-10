// @vitest-environment node

import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { AuthService } from "./auth";
import { registerModelRoutes } from "./models";

describe("模型查询路由", () => {
  it("从注入的最新模型目录返回模型", async () => {
    const app = Fastify();
    const listModels = vi.fn(async () => [{ provider: "provider-2", id: "gpt-5.6-terra", name: "GPT 5.6 Terra" }]);
    const authService = {
      isAuthenticated: vi.fn(async () => true),
    } as unknown as AuthService;
    registerModelRoutes(app, { authService, listModels });

    const response = await app.inject({ method: "GET", url: "/api/models" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      models: [{ provider: "provider-2", id: "gpt-5.6-terra", name: "GPT 5.6 Terra" }],
    });
    expect(listModels).toHaveBeenCalledOnce();
    await app.close();
  });
});
