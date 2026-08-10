// @vitest-environment node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentStore } from "../agents/agent-store";
import { createDataPaths } from "../paths";
import { DiagnosticsService } from "./diagnostics-service";

describe("DiagnosticsService", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("聚合模型、凭证、目录、挂载、资源和版本诊断且不泄露秘密", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-diagnostics-"));
    roots.push(root);
    const paths = await createDataPaths(root);
    const agents = new AgentStore(paths);
    const agent = await agents.create({ name: "诊断 Agent" });
    await mkdir(join(paths.piDir, "sessions"), { recursive: true });
    await writeFile(
      join(paths.piDir, "models.json"),
      JSON.stringify({ providers: { broken: { baseUrl: "https://api.example.test", apiKey: "model-secret", models: [{ id: "" }] } } }),
      "utf8",
    );
    await writeFile(join(paths.piDir, "auth.json"), JSON.stringify({ other: { type: "api_key", key: "auth-secret" } }), "utf8");

    const service = new DiagnosticsService({
      paths,
      agents,
      version: "0.1.0-test",
      checkWritable: vi.fn(async (path) => path !== agent.profile.cwd && path !== join(paths.piDir, "sessions")),
      readMounts: vi.fn(async () => [{ source: "/dev/test", target: paths.rootDir, writable: true }]),
      loadResources: vi.fn(async () => ({
        diagnostics: [{ type: "error", message: "Authorization: Bearer resource-secret", path: "/tmp/broken.ts" }],
      })),
      operationalStatus: () => ({
        database: { quickCheck: "ok", journalMode: "wal" },
        runtime: { activeLeases: 2, trackedAgents: 1 },
        limits: { runtimeSessionsPerAgent: 256, sseQueueEntries: 512 },
      }),
    });

    const report = await service.run();
    const serialized = JSON.stringify(report);
    expect(report.version.app).toBe("0.1.0-test");
    expect(report.mounts).toEqual(expect.arrayContaining([expect.objectContaining({ target: paths.rootDir, writable: true })]));
    expect(report.operational).toEqual(expect.objectContaining({
      database: { quickCheck: "ok", journalMode: "wal" },
      runtime: { activeLeases: 2, trackedAgents: 1 },
    }));
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "PI_MODELS_INVALID", source: "models" }),
      expect.objectContaining({ code: "PROVIDER_CREDENTIAL_MISSING", source: "auth" }),
      expect.objectContaining({ code: "AGENT_CWD_NOT_WRITABLE", source: "runtime" }),
      expect.objectContaining({ code: "SESSION_DIR_NOT_WRITABLE", source: "runtime" }),
      expect.objectContaining({ code: "RESOURCE_LOAD_ERROR", source: "resource" }),
    ]));
    expect(serialized).not.toContain("model-secret");
    expect(serialized).not.toContain("auth-secret");
    expect(serialized).not.toContain("resource-secret");
  });
});
