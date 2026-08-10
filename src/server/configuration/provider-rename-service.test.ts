// @vitest-environment node

import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AgentStore } from "../agents/agent-store";
import { createAgentProfile } from "../agents/agent-profile";
import { createDataPaths } from "../paths";
import { CredentialService } from "./credential-service";
import { ModelConfigService } from "./model-config-service";
import { ProviderRenameService, recoverPendingProviderRenames } from "./provider-rename-service";
import { writeJsonAtomic } from "../storage";

describe("ProviderRenameService", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("在单个事务中迁移模型、凭证、Agent 默认模型和会话模型引用", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-provider-rename-"));
    roots.push(root);
    const paths = await createDataPaths(root);
    const modelsPath = join(paths.piDir, "models.json");
    const authPath = join(paths.piDir, "auth.json");
    await writeFile(modelsPath, '{"providers":{"old":{"name":"旧 Provider","baseUrl":"http://localhost:11434","api":"openai-completions","models":[{"id":"m1","name":"M1"}]},"other":{"name":"保留","baseUrl":"http://localhost:11434","api":"openai-completions","models":[]}}}\n', "utf8");
    await writeFile(authPath, '{"old":{"type":"api_key","key":"secret"}}\n', "utf8");
    const agents = new AgentStore(paths);
    const agent = await agents.create({
      name: "引用者",
      defaultModel: { provider: "old", id: "m1" },
      titleGeneration: {
        modelSource: "custom",
        model: { provider: "old", id: "title-m1" },
        thinkingEnabled: false,
      },
    });
    const sessionDir = join(paths.piDir, "sessions", agent.profile.id);
    const sessionPath = join(sessionDir, "session.jsonl");
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      sessionPath,
      `${JSON.stringify({ type: "model_change", provider: "old", modelId: "m1" })}\n${JSON.stringify({ type: "message", message: { role: "assistant", provider: "old", model: "m1" } })}\n`,
      "utf8",
    );
    const models = new ModelConfigService({ modelsPath, authPath });
    const service = new ProviderRenameService({
      paths,
      models,
      agents,
    });

    const result = await service.rename("old", "new", (await models.read()).revision);

    expect(result.value.providers).toMatchObject({
      new: { name: "旧 Provider" },
      other: { name: "保留" },
    });
    expect((result.value.providers as Record<string, unknown> | undefined)?.old).toBeUndefined();
    expect(await new CredentialService(authPath).getApiKey("new")).toBe("secret");
    expect(await new CredentialService(authPath).getApiKey("old")).toBeUndefined();
    expect((await agents.get(agent.profile.id))?.profile.defaultModel).toEqual({ provider: "new", id: "m1" });
    expect((await agents.get(agent.profile.id))?.profile.titleGeneration?.model).toEqual({ provider: "new", id: "title-m1" });
    expect(await readFile(sessionPath, "utf8")).toContain('"provider":"new"');
    expect(await readFile(sessionPath, "utf8")).not.toContain('"provider":"old"');
  });

  it("启动时根据已提交的模型配置幂等续跑 Agent 引用并删除 Saga 清单", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-provider-rename-recovery-"));
    roots.push(root);
    const paths = await createDataPaths(root);
    const modelsPath = join(paths.piDir, "models.json");
    const authPath = join(paths.piDir, "auth.json");
    await writeFile(modelsPath, '{"providers":{"new":{"name":"新 Provider","baseUrl":"http://localhost:11434","api":"openai-completions","models":[]}}}\n', "utf8");
    const agents = new AgentStore(paths);
    const agent = await agents.create({
      name: "待恢复",
      defaultModel: { provider: "old", id: "m1" },
      titleGeneration: {
        modelSource: "custom",
        model: { provider: "old", id: "title-m1" },
        thinkingEnabled: true,
      },
    });
    const manifestPath = join(paths.transactionDir, "provider-renames", "rename-1.json");
    await writeJsonAtomic(manifestPath, {
      version: 1,
      id: "rename-1",
      sourceId: "old",
      targetId: "new",
      agentIds: [agent.profile.id],
      createdAt: "2026-08-07T00:00:00.000Z",
    });

    await recoverPendingProviderRenames(paths, new ModelConfigService({ modelsPath, authPath }), agents);

    expect((await agents.get(agent.profile.id))?.profile.defaultModel?.provider).toBe("new");
    expect((await agents.get(agent.profile.id))?.profile.titleGeneration?.model?.provider).toBe("new");
    await expect(access(manifestPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("会话历史文件数超过预算时在写入任何 Saga 状态前拒绝改名", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-provider-rename-limit-"));
    roots.push(root);
    const paths = await createDataPaths(root);
    const modelsPath = join(paths.piDir, "models.json");
    const authPath = join(paths.piDir, "auth.json");
    await writeFile(modelsPath, '{"providers":{"old":{"name":"旧 Provider","baseUrl":"http://localhost:11434","api":"openai-completions","models":[]}}}\n', "utf8");
    const sessionDirectory = join(paths.piDir, "sessions", "agent-a");
    await mkdir(sessionDirectory, { recursive: true });
    await Promise.all(Array.from({ length: 501 }, (_, index) => writeFile(join(sessionDirectory, `${index}.jsonl`), "{}\n", "utf8")));
    const models = new ModelConfigService({ modelsPath, authPath });
    const service = new ProviderRenameService({ paths, models, agents: new AgentStore(paths) });

    await expect(service.rename("old", "new", (await models.read()).revision)).rejects.toMatchObject({
      code: "PROVIDER_RENAME_HISTORY_LIMIT",
    });
    await expect(access(join(paths.transactionDir, "provider-renames"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("引用 Agent 数量超过恢复清单上限时在提交配置前拒绝改名", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-provider-rename-agent-limit-"));
    roots.push(root);
    const paths = await createDataPaths(root);
    const modelsPath = join(paths.piDir, "models.json");
    const authPath = join(paths.piDir, "auth.json");
    await writeFile(modelsPath, '{"providers":{"old":{"name":"旧 Provider","baseUrl":"http://localhost:11434","api":"openai-completions","models":[]}}}\n', "utf8");
    const now = new Date().toISOString();
    const agents = {
      list: async () => Array.from({ length: 501 }, (_, index) => ({
        profile: createAgentProfile(`agent-${index}`, join(paths.workspaceDir, `agent-${index}`), {
          name: `Agent ${index}`,
          defaultModel: { provider: "old", id: "model" },
        }, now),
        revision: `revision-${index}`,
      })),
    } as unknown as AgentStore;
    const models = new ModelConfigService({ modelsPath, authPath });
    const service = new ProviderRenameService({ paths, models, agents });

    await expect(service.rename("old", "new", (await models.read()).revision)).rejects.toMatchObject({
      code: "PROVIDER_RENAME_HISTORY_LIMIT",
    });
    expect((await models.read()).value.providers).toHaveProperty("old");
    await expect(access(join(paths.transactionDir, "provider-renames"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
