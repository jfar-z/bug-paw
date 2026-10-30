import { createTestDatabase } from "../database/test-database";
// @vitest-environment node
import Fastify from "fastify";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { registerWorkflowRoutes } from "./workflows";
import { WorkflowService } from "../workflows/workflow-service";
import { WorkflowRepository } from "../workflows/workflow-repository";
import { emptyWorkflow } from "../../shared/workflow-contracts";
import { DomainError } from "../core/errors";
/** 路由使用实际存储，确保管理、运行与产物入口都要求登录。 */
describe("工作流 HTTP API", () => {
  it("认证保护所有入口，登录后保存、运行、查询与删除保留历史", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-http-")),
      service = new WorkflowService(new WorkflowRepository(root, createTestDatabase()), {
        execute: async () => ({}),
      });
    await service.initialize();
    const app = Fastify();
    let authenticated = false;
    app.setErrorHandler((error, request, reply) => {
      if (error instanceof DomainError)
        return reply
          .code(error.code === "NOT_FOUND" ? 404 : 400)
          .send(error.toDocument(request.id));
      return reply.code(500).send({ message: "测试未预期异常" });
    });
    registerWorkflowRoutes(app, {
      authService: { isAuthenticated: async () => authenticated } as never,
      service,
      executor: {
        catalog: async () => ({ models: [], agents: [], interfaces: [] }),
      } as never,
      files: {} as never,
    });
    try {
      for (const [method, url] of [
        ["GET", "/api/workflows"],
        ["GET", "/api/workflows/catalog"],
        ["POST", "/api/workflows"],
        ["GET", "/api/workflows/unknown"],
        ["PUT", "/api/workflows/unknown"],
        ["DELETE", "/api/workflows/unknown"],
        ["POST", "/api/workflows/validate"],
        ["POST", "/api/workflows/script-assist"],
        ["POST", "/api/workflows/unknown/run"],
        ["GET", "/api/workflow-runs"],
        ["GET", "/api/workflow-runs/unknown"],
        ["POST", "/api/workflow-runs/unknown/cancel"],
        ["POST", "/api/workflow-files"],
        ["GET", "/api/workflow-files/unknown"],
      ] as const) {
        const r = await app.inject({ method, url });
        expect(r.statusCode, `${method} ${url}`).toBe(401);
      }
      authenticated = true;
      const invalidBody = await app.inject({
        method: "POST", url: "/api/workflows/validate",
        headers: { "content-type": "application/json" }, payload: "null",
      });
      expect(invalidBody.statusCode).toBe(400);
      expect(invalidBody.json().error).toMatchObject({ code: "VALIDATION_FAILED", requestId: expect.any(String) });
      const saved = await app.inject({
        method: "POST",
        url: "/api/workflows",
        payload: emptyWorkflow(),
      });
      expect(saved.statusCode).toBe(201);
      expect(saved.headers["cache-control"]).toBe("no-store");
      const definition = saved.json();
      const started = await app.inject({
        method: "POST",
        url: `/api/workflows/${definition.id}/run`,
        payload: { inputs: { prompt: "http" }, requestKey: "http-run" },
      });
      expect(started.statusCode).toBe(202);
      await service.wait(started.json().id);
      const detail = await app.inject(
        `/api/workflow-runs/${started.json().id}`,
      );
      expect(detail.json()).toMatchObject({
        status: "succeeded",
        outputs: { result: "http" },
      });
      const bad = await app.inject({
        method: "POST",
        url: "/api/workflows/validate",
        payload: { ...emptyWorkflow(), edges: [] },
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error).toMatchObject({
        code: "VALIDATION_FAILED",
        requestId: expect.any(String),
      });
      expect(
        (
          await app.inject({
            method: "DELETE",
            url: `/api/workflows/${definition.id}`,
            payload: { revision: definition.revision },
          })
        ).statusCode,
      ).toBe(204);
      expect(
        (await app.inject(`/api/workflow-runs/${started.json().id}`))
          .statusCode,
      ).toBe(200);
    } finally {
      await app.close();
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("媒体预览支持 Range、默认下载和安全响应头，辅助接口沿用登录保护", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-media-http-"));
    const path = join(root, "fixture.mp4");
    await writeFile(path, "0123456789", "utf8");
    const app = Fastify();
    let authenticated = true;
    let mediaType = "video/mp4";
    const assistScript = vi.fn(async () => ({ script: "return {};" }));
    registerWorkflowRoutes(app, {
      authService: { isAuthenticated: async () => authenticated } as never,
      service: {} as never,
      executor: { assistScript } as never,
      files: {
        resolve: async () => ({
          file: { assetId: "fixture", name: "产物.mp4", mediaType, size: 10 },
          path,
        }),
      } as never,
    });
    try {
      const preview = await app.inject({
        url: "/api/workflow-files/fixture?preview=1",
        headers: { range: "bytes=2-5" },
      });
      expect(preview.statusCode).toBe(206);
      expect(preview.body).toBe("2345");
      expect(preview.headers["content-range"]).toBe("bytes 2-5/10");
      expect(preview.headers["content-disposition"]).toBeUndefined();
      expect(preview.headers["cache-control"]).toBe("no-store");
      expect(preview.headers["x-content-type-options"]).toBe("nosniff");
      expect(preview.headers["x-bugpaw-file-path"]).toBe("fixture");
      const suffix = await app.inject({
        url: "/api/workflow-files/fixture?preview=1",
        headers: { range: "bytes=-3" },
      });
      expect(suffix.body).toBe("789");
      expect(
        (
          await app.inject({
            url: "/api/workflow-files/fixture?preview=1",
            headers: { range: "bytes=99-" },
          })
        ).statusCode,
      ).toBe(416);
      const download = await app.inject("/api/workflow-files/fixture");
      expect(download.headers["content-disposition"]).toContain("attachment;");
      expect(download.body).toBe("0123456789");
      mediaType = "image/svg+xml";
      expect(
        (await app.inject("/api/workflow-files/fixture?preview=1")).headers[
          "content-security-policy"
        ],
      ).toContain("sandbox");
      mediaType = "text/html";
      expect(
        (await app.inject("/api/workflow-files/fixture?preview=1")).headers[
          "content-disposition"
        ],
      ).toContain("attachment;");
      const generated = await app.inject({
        method: "POST",
        url: "/api/workflows/script-assist",
        payload: { requirement: "test" },
      });
      expect(generated.json()).toEqual({ script: "return {};" });
      expect(assistScript.mock.calls[0]).toHaveLength(2);
      authenticated = false;
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/workflows/script-assist",
            payload: {},
          })
        ).statusCode,
      ).toBe(401);
      expect(assistScript).toHaveBeenCalledTimes(1);
      expect(
        (await app.inject("/api/workflow-files/fixture?preview=1")).statusCode,
      ).toBe(401);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
