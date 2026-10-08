// @vitest-environment node

import Fastify from "fastify";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { registerAigcMcpRoutes } from "./aigc-mcp";

/** 验证对外入口使用真实 MCP JSON-RPC 协议且先检查专用令牌。 */
describe("AIGC MCP 路由", () => {
  it("无令牌时拒绝初始化和文件访问", async () => {
    const app = Fastify();
    registerAigcMcpRoutes(app, {
      authService: { isAuthenticated: async () => false } as never,
      service: { authenticate: () => undefined } as never,
    });
    const initialize = await app.inject({ method: "POST", url: "/api/aigc/mcp",
      payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } } });
    expect(initialize.statusCode).toBe(401);
    expect(initialize.json().error.code).toBe("MCP_AUTH_REQUIRED");
    const download = await app.inject({ method: "GET", url: "/api/aigc/mcp/tasks/task/assets/file" });
    expect(download.statusCode).toBe(401);
    await app.close();
  });

  it("只有登录管理员能编辑授权，响应不包含令牌且错误携带请求标识", async () => {
    const update = vi.fn(async (_id, input) => ({ id: "client-1", ...input, createdAt: "2026-10-08T00:00:00.000Z" }));
    let authenticated = false;
    const app = Fastify();
    registerAigcMcpRoutes(app, { authService: { isAuthenticated: async () => authenticated } as never, service: { update } as never });
    const payload = { name: "新名称", interfaceIds: ["interface-2"], operations: ["list"] };
    try {
      expect((await app.inject({ method: "PATCH", url: "/api/aigc/mcp/clients/client-1", payload })).statusCode).toBe(401);
      expect(update).not.toHaveBeenCalled();
      authenticated = true;
      const invalid = await app.inject({ method: "PATCH", url: "/api/aigc/mcp/clients/client-1", payload: { ...payload, operations: ["invalid"] } });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error).toMatchObject({ code: "MCP_CLIENT_INPUT_INVALID", message: "请提供客户端名称、接口和操作范围", requestId: expect.any(String) });
      const response = await app.inject({ method: "PATCH", url: "/api/aigc/mcp/clients/client-1", payload });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual({ client: { id: "client-1", ...payload, createdAt: "2026-10-08T00:00:00.000Z" } });
      expect(update).toHaveBeenCalledWith("client-1", payload);
    } finally { await app.close(); }
  });

  it("发现获授权工具并执行调用", async () => {
    const list = vi.fn(async () => ({ interfaces: [{ id: "interface-1", name: "图片" }], total: 1 }));
    const upload = vi.fn(async () => ({ inputId: "input-1", mediaType: "image/png" }));
    const readSmallOutput = vi.fn(async () => ({ id: "output-1", mediaType: "image/png", base64: "b3V0cHV0" }));
    const client = { id: "client-1", name: "test", interfaceIds: ["interface-1"], operations: ["list", "upload", "download"], createdAt: "2026-10-03T00:00:00.000Z" };
    const app = Fastify();
    registerAigcMcpRoutes(app, {
      authService: { isAuthenticated: async () => false } as never,
      service: { authenticate: (token: string) => token === "test-token" ? client : undefined, list, upload, readSmallOutput } as never,
    });
    const headers = { authorization: "Bearer test-token", accept: "application/json, text/event-stream" };
    const initialize = await app.inject({ method: "POST", url: "/api/aigc/mcp", headers,
      payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } } });
    expect(initialize.statusCode).toBe(200);
    expect(initialize.json().result.serverInfo.name).toBe("bugpaw-aigc");
    const tools = await app.inject({ method: "POST", url: "/api/aigc/mcp", headers,
      payload: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} } });
    expect(tools.statusCode).toBe(200);
    expect(tools.json().result.tools.map((tool: { name: string }) => tool.name)).toEqual(["aigc_list_interfaces", "aigc_upload_input", "aigc_read_output"]);
    const call = await app.inject({ method: "POST", url: "/api/aigc/mcp", headers,
      payload: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "aigc_list_interfaces",
        arguments: { action: "list", interfaceId: null, offset: 0 } } } });
    expect(call.statusCode).toBe(200);
    expect(JSON.parse(call.json().result.content[0].text).data.total).toBe(1);
    expect(list).toHaveBeenCalledWith(client, { offset: 0 });
    const uploaded = await app.inject({ method: "POST", url: "/api/aigc/mcp", headers,
      payload: { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "aigc_upload_input",
        arguments: { name: "reference.png", mediaType: "image/png", base64: "aW1hZ2U=" } } } });
    expect(JSON.parse(uploaded.json().result.content[0].text).data.inputId).toBe("input-1");
    expect(upload).toHaveBeenCalledTimes(1);
    const output = await app.inject({ method: "POST", url: "/api/aigc/mcp", headers,
      payload: { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "aigc_read_output",
        arguments: { taskId: "task-1", assetId: "output-1" } } } });
    expect(JSON.parse(output.json().result.content[0].text).data.base64).toBe("b3V0cHV0");
    await app.close();
  });

  it("经 Bearer 认证下载产物并禁止缓存", async () => {
    const root = await mkdtemp(join(tmpdir(), "bugpaw-mcp-route-"));
    const path = join(root, "result.bin");
    await writeFile(path, Buffer.from("media"));
    const app = Fastify();
    registerAigcMcpRoutes(app, { authService: { isAuthenticated: async () => false } as never,
      service: { authenticate: (token: string) => token === "test-token" ? { id: "client-1" } : undefined,
        output: async () => ({ asset: { name: "result.png", mediaType: "image/png" }, path }) } as never });
    try {
      const result = await app.inject({ method: "GET", url: "/api/aigc/mcp/tasks/task-1/assets/output-1",
        headers: { authorization: "Bearer test-token" } });
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe("media");
      expect(result.headers["cache-control"]).toBe("private, no-store");
      expect(result.headers["content-disposition"]).toContain("result.png");
    } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
  });
});
