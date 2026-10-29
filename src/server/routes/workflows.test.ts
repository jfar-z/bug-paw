// @vitest-environment node
import Fastify from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { registerWorkflowRoutes } from "./workflows";
import { WorkflowService } from "../workflows/workflow-service";
import { WorkflowRepository } from "../workflows/workflow-repository";
import { emptyWorkflow } from "../../shared/workflow-contracts";
import { DomainError } from "../core/errors";
/** 路由使用实际存储，确保管理、运行与产物入口都要求登录。 */
describe("工作流 HTTP API", () => {
  it("认证保护所有入口，登录后保存、运行、查询与删除保留历史", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-http-")),
      service = new WorkflowService(new WorkflowRepository(root), {
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
});
