// @vitest-environment node

import Fastify from "fastify";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDataPaths } from "../paths";
import { registerSetupRoutes } from "./setup";
import { openDatabase } from "../database/database";
import { runMigrations } from "../database/migrator";
import { createIdentityRepository } from "../identity/identity-repository";

describe("首次初始化路由", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("只保存初始化配置而不创建默认 Agent", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-agent-setup-"));
    roots.push(root);
    const paths = await createDataPaths(root);
    const app = Fastify();
    const database = openDatabase(paths.databaseFile);
    runMigrations(database);
    const identities = createIdentityRepository(database);
    app.addHook("onClose", async () => database.close());
    registerSetupRoutes(app, { paths, identityRepository: identities, now: () => new Date("2026-08-06T00:00:00.000Z") });

    const legacyResponse = await app.inject({
      method: "POST",
      url: "/api/setup",
      payload: {
        username: "admin",
        password: "correct horse battery staple",
        confirmPassword: "correct horse battery staple",
        provider: {
          type: "openai-compatible",
          apiKey: "test-key",
          baseUrl: "https://llm.example.test/v1",
          defaultModel: "test-model",
        },
      },
    });
    expect(legacyResponse.statusCode).toBe(400);

    const response = await app.inject({
      method: "POST",
      url: "/api/setup",
      payload: {
        password: "correct horse battery staple",
        confirmPassword: "correct horse battery staple",
        provider: {
          type: "openai-compatible",
          apiKey: "test-key",
          baseUrl: "https://llm.example.test/v1",
          defaultModel: "test-model",
        },
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ initialized: true });
    await expect(identities.getUser("owner")).resolves.toMatchObject({ id: "owner", revision: "1" });
    await expect(stat(join(paths.appDir, "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(paths.agentsDir, "default", "profile.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(join(paths.piDir, "settings.json"), "utf8"))).toMatchObject({
      defaultProvider: "openai-compatible",
      defaultModel: "test-model",
    });
    await app.close();
  });
});
