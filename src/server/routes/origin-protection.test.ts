// @vitest-environment node

import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerOriginProtection } from "./origin-protection";
import { registerApiV1Namespace } from "../http/api-versioning";

describe("修改请求来源保护", () => {
  it("HTTPS 在反向代理终止时允许浏览器确认的同源请求", async () => {
    const app = Fastify();
    registerOriginProtection(app);
    app.post("/api/agents", async () => ({ created: true }));

    const response = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: {
        host: "agent.nightbane.cn",
        origin: "https://agent.nightbane.cn",
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ created: true });
    await app.close();
  });

  it("允许同源和非浏览器客户端，拒绝跨源及缺少来源的浏览器修改请求", async () => {
    const app = Fastify();
    registerOriginProtection(app);
    app.get("/healthz", async () => ({ ok: true }));
    app.post("/api/configuration/global", async () => ({ saved: true }));

    const sameOrigin = await app.inject({ method: "POST", url: "/api/configuration/global", headers: { host: "agent.example.test", origin: "http://agent.example.test", cookie: "session=value", "sec-fetch-site": "same-origin" } });
    expect(sameOrigin.statusCode).toBe(200);
    expect(sameOrigin.headers["cache-control"]).toBe("no-store");
    const crossOrigin = await app.inject({ method: "POST", url: "/api/configuration/global", headers: { host: "agent.example.test", origin: "https://evil.example.test", cookie: "session=value", "sec-fetch-site": "cross-site" } });
    expect(crossOrigin.statusCode).toBe(403);
    expect(crossOrigin.json()).toMatchObject({ error: { code: "ORIGIN_REJECTED" } });
    const missingBrowserOrigin = await app.inject({ method: "POST", url: "/api/configuration/global", headers: { host: "agent.example.test", cookie: "session=value", "sec-fetch-site": "same-origin" } });
    expect(missingBrowserOrigin.statusCode).toBe(403);
    const cli = await app.inject({ method: "POST", url: "/api/configuration/global", headers: { host: "agent.example.test" } });
    expect(cli.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/healthz", headers: { origin: "https://evil.example.test" } })).statusCode).toBe(200);
    await app.close();
  });

  it("版本化 API 的敏感响应同样禁止缓存", async () => {
    const app = Fastify();
    registerApiV1Namespace(app);
    registerOriginProtection(app);
    app.get("/api/agents/:id/prompts", async () => ({ prompt: "private" }));
    app.get("/api/providers", async () => ({ providers: [] }));
    app.get("/api/knowledge-bases/:id/documents", async () => ({ documents: [] }));

    for (const url of [
      "/api/v1/agents/agent-1/prompts",
      "/api/v1/providers",
      "/api/v1/knowledge-bases/kb-1/documents",
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    await app.close();
  });
});
