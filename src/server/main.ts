import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { access, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createDataPaths, type DataPaths } from "./paths";
import {
  createSdkPiRuntimeGateway,
  type PiRuntimeGateway,
} from "./pi-runtime";
import { registerAuthRoutes, createAuthService } from "./routes/auth";
import { registerChatRoutes } from "./routes/chat";
import { registerModelRoutes } from "./routes/models";
import { registerSessionRoutes } from "./routes/sessions";
import { registerSetupRoutes } from "./routes/setup";
import { registerStatusRoutes } from "./routes/status";
import { createWorkspaceFileService, DEFAULT_UPLOAD_LIMITS } from "./attachments";
import { registerAttachmentRoutes } from "./routes/attachments";
import { createWorkspaceFileManager } from "./workspace-files";
import { registerWorkspaceFileRoutes } from "./routes/workspace-files";
import { registerAgentRoutes } from "./routes/agents";
import { createRunCheckpointStore } from "./runtime/checkpoint-store";
import { createSessionMetadataStore } from "./session-metadata";
import { recoverPendingTransactions } from "./configuration/config-transaction";
import { createAgentService } from "./agents/agent-service";
import { AgentPromptStore } from "./agents/agent-prompt-store";
import { createEditOwnPromptsTool } from "./agents/agent-prompt-tool";
import { createRuntimeCoordinator, type RuntimeCoordinator } from "./runtime-coordinator";
import { RuntimeSupervisor } from "./runtime/runtime-supervisor";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentProfile } from "../shared/agent-contracts";
import { SYSTEM_TOOL_NAMES } from "../shared/tool-catalog";
import { ModelConfigService } from "./configuration/model-config-service";
import { CredentialService } from "./configuration/credential-service";
import { ProviderRenameService, recoverPendingProviderRenames } from "./configuration/provider-rename-service";
import { createProviderModelDiscovery } from "./provider-model-discovery";
import { registerProviderRoutes } from "./routes/providers";
import { registerConfigurationRoutes } from "./routes/configuration";
import { registerResourceRoutes } from "./routes/resources";
import { ResourceService, ResourceTaskManager } from "./resources/resource-service";
import { registerOriginProtection } from "./routes/origin-protection";
import { createScheduledTaskRepository } from "./scheduled-tasks/scheduled-task-repository";
import { createScheduledTaskService } from "./scheduled-tasks/scheduled-task-service";
import { registerScheduledTaskRoutes } from "./routes/scheduled-tasks";
import { ensureScheduledTaskSkill } from "./scheduled-tasks/global-skill";
import { createScheduledTasksTool } from "./scheduled-tasks/scheduled-task-tool";
import { WebResearchConfigService } from "./web-research/web-research-config-service";
import { EgressProfileRegistry } from "./web-research/egress-profile-registry";
import { createWebResearchService } from "./web-research/web-research-service";
import { createWebOpenTool, createWebSearchTool } from "./web-research/web-research-tools";
import { registerWebResearchRoutes } from "./routes/web-research";
import { TtsConfigService } from "./tts/tts-config-service";
import { TtsSynthesisService } from "./tts/tts-synthesis-service";
import { registerTtsRoutes } from "./routes/tts";
import { EmbeddingConfigService } from "./knowledge-base/embedding-config-service";
import { OpenAiEmbeddingClient } from "./knowledge-base/openai-embedding-client";
import { registerKnowledgeRetrievalRoutes } from "./routes/knowledge-retrieval";
import { createKnowledgeRepository } from "./knowledge-base/knowledge-repository";
import { createKnowledgeBaseService } from "./knowledge-base/knowledge-base-service";
import { registerKnowledgeBaseRoutes } from "./routes/knowledge-bases";
import { createGetKnowledgeDocumentTool, createManageKnowledgeBaseTool, createSearchKnowledgeTool } from "./knowledge-base/knowledge-tools";
import { ensureKnowledgeBaseSkill } from "./knowledge-base/global-skill";
import { createAgentReferenceResolver } from "./agent-references";
import { ComposerCatalogService } from "./composer-catalog";
import { registerComposerCatalogRoutes } from "./routes/composer-catalog";
import { openDatabase } from "./database/database";
import { runMigrations } from "./database/migrator";
import { createIdentityRepository } from "./identity/identity-repository";
import { createAgentRepository } from "./agents/agent-repository";
import { createSessionRepository } from "./sessions/session-repository";
import { hasPersistedSessionFile, reconcileUnpersistedSessions } from "./sessions/session-reconciliation";
import { acquireInstanceLock } from "./instance-lock";
import { createConfigurationHistoryRepository } from "./configuration/configuration-history-repository";
import { ChatApplicationService } from "./chat/chat-service";
import { resolveSessionAgentId } from "./session-agent";
import { registerApiV1Namespace } from "./http/api-versioning";
import { exposeRequestId, registerApiErrorHandler } from "./http/error-handler";
import { sendApiError } from "./routes/http";
import { BackgroundErrorRegistry } from "./observability/background-errors";
import { SYSTEM_LIMITS } from "./core/limits";
import { AgentLifecycleGate } from "./core/agent-lifecycle-gate";
import { DurableDeletionCoordinator } from "./core/durable-deletion";
import { KeyedMutex } from "./core/keyed-mutex";
import { readDeploymentCapabilities } from "./deployment-capabilities";

export interface BuildServerOptions {
  dataRoot?: string;
  staticRoot?: string;
  logger?: boolean;
  runtimeFactory?: (paths: DataPaths) => Promise<PiRuntimeGateway>;
}

/** 为 Agent 解析隔离的会话存储目录。 */
export function resolveAgentSessionDir(paths: DataPaths, agentId: string): string {
  // 所有 Agent（含 default）使用相同隔离规则，删除单个 Agent 时不会误伤其他会话目录。
  return resolve(paths.piDir, "sessions", agentId);
}

/**
 * 装配 HTTP、认证、pi SDK API 与前端静态资源。
 */
export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const paths = await createDataPaths(options.dataRoot ?? process.env.PI_AGENT_DATA_ROOT ?? "/data");
  const deploymentCapabilities = readDeploymentCapabilities(process.env);
  const instanceLock = await acquireInstanceLock(paths.appDir);
  let database: ReturnType<typeof openDatabase> | undefined;
  try {
    database = openDatabase(paths.databaseFile);
    runMigrations(database);
    const applicationDatabase = database;
    const durableDeletions = new DurableDeletionCoordinator(paths.rootDir, paths.deletionTransactionDir, applicationDatabase);
    await durableDeletions.recover();
    await recoverPendingTransactions({ rootDir: paths.rootDir, transactionDir: paths.transactionDir });
    // 上传 staging 不属于业务事实源，启动时清理崩溃遗留的敏感临时资料。
    await rm(join(paths.knowledgeDir, "staging"), { recursive: true, force: true });
    await mkdir(join(paths.knowledgeDir, "staging"), { recursive: true, mode: 0o700 });
    const staticRoot = resolve(options.staticRoot ?? "dist/web");
    await access(staticRoot);

  const app = Fastify({ logger: options.logger ?? false });
  const backgroundErrors = new BackgroundErrorRegistry();
  registerApiV1Namespace(app);
  registerApiErrorHandler(app);
  await app.register(cookie);
  await app.register(multipart, {
    limits: { files: DEFAULT_UPLOAD_LIMITS.maxFiles, fileSize: DEFAULT_UPLOAD_LIMITS.maxFileSize },
  });
  const identities = createIdentityRepository(applicationDatabase);
  const authService = createAuthService(paths, { identityRepository: identities });
  registerOriginProtection(app);
  const sessionRepository = createSessionRepository(applicationDatabase);
  await reconcileUnpersistedSessions(paths, applicationDatabase);
  const agentLifecycle = new AgentLifecycleGate();
  const modelMutations = new KeyedMutex();
  const sessionMetadataStore = createSessionMetadataStore(sessionRepository);
  const scheduledTaskStore = createScheduledTaskRepository(applicationDatabase);
  const agentStore = createAgentService(paths, {
    stageRemoval: async (agentId, profile, options) => {
      const sessionIds = options.removeSessions ? await sessionMetadataStore.listIdsByAgent(agentId) : [];
      return durableDeletions.stage("agent", agentId, [
        join(paths.agentsDir, agentId),
        ...(options.removeWorkspace ? [profile.cwd] : []),
        ...(options.removeSessions ? [resolveAgentSessionDir(paths, agentId)] : []),
        ...sessionIds.map((sessionId) => join(paths.runDir, `${sessionId}.json`)),
      ]);
    },
    stageSessions: async (agentId) => {
      const source = resolveAgentSessionDir(paths, agentId);
      const staged = join(paths.trashDir, "sessions", `${Date.now()}-${agentId}-${randomUUID()}`);
      let moved = false;
      try {
        await access(source);
        await mkdir(dirname(staged), { recursive: true, mode: 0o700 });
        await rename(source, staged);
        moved = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return {
        async commit() {
          if (moved) await rm(staged, { recursive: true, force: true });
        },
        async rollback() {
          if (moved) await rename(staged, source);
        },
      };
    },
  }, createAgentRepository(applicationDatabase));
  const agentPrompts = new AgentPromptStore(paths.agentsDir);
  const embeddingConfigs = new EmbeddingConfigService(join(paths.appDir, "embedding.json"), {
    managedAvailable: deploymentCapabilities.managedEmbeddingAvailable,
  });
  const embeddingClient = new OpenAiEmbeddingClient(embeddingConfigs);
  const knowledgeBases = createKnowledgeBaseService({
    paths,
    store: createKnowledgeRepository(applicationDatabase),
    agentExists: async (agentId) => Boolean(await agentStore.get(agentId)),
    embeddingClient,
    isSemanticSearchEnabled: async () => (await embeddingConfigs.getPrivate())?.enabled ?? false,
    stageDeletion: (kind, entityId, targets) => durableDeletions.stage(kind, entityId, targets),
  });
  const workspaceFiles = createWorkspaceFileService(paths, agentStore);
  const workspaceFileManager = createWorkspaceFileManager(agentStore);
  const referenceResolver = createAgentReferenceResolver(async (agentId) => {
    const agent = await agentStore.get(agentId);
    if (!agent) {
      return { skills: [], knowledgeBases: [], workspaceEntries: [] };
    }
    const resources = await new ResourceService({ agentDir: paths.piDir, cwd: agent.profile.cwd }).catalog();
    const [knowledgeBasesForAgent, workspaceEntries] = await Promise.all([
      knowledgeBases.listBasesForAgent(agentId),
      workspaceFileManager.listReferences(agentId),
    ]);
    return {
      skills: resources.resources
        .filter((resource) => resource.type === "skill" && resource.enabled)
        .map((resource) => ({ name: resource.name })),
      knowledgeBases: knowledgeBasesForAgent.map((base) => ({ id: base.id, name: base.name })),
      workspaceEntries,
    };
  });
  const models = new ModelConfigService({
    modelsPath: resolve(paths.piDir, "models.json"),
    authPath: resolve(paths.piDir, "auth.json"),
  });
  const webResearchEgressProfiles = new EgressProfileRegistry(
    process.env.WEB_RESEARCH_EGRESS_PROFILES_PATH,
    process.env.WEB_RESEARCH_TRUSTED_FAKE_IP_CIDRS,
  );
  const webResearchConfigs = new WebResearchConfigService(join(paths.appDir, "web-research.json"), webResearchEgressProfiles);
  await webResearchConfigs.migrateLegacyInternalHost();
  const webResearch = createWebResearchService(webResearchConfigs, webResearchEgressProfiles);
  const ttsConfigs = new TtsConfigService(join(paths.appDir, "tts.json"));
  const ttsSynthesis = new TtsSynthesisService(ttsConfigs);
  await recoverPendingProviderRenames(paths, models, agentStore);
  const credentials = new CredentialService(resolve(paths.piDir, "auth.json"));
  const providerModelDiscovery = createProviderModelDiscovery({ models, credentials });
  const createSharedModelRuntime = () => ModelRuntime.create({
    authPath: resolve(paths.piDir, "auth.json"),
    modelsPath: resolve(paths.piDir, "models.json"),
    allowModelNetwork: false,
  });
  let sharedModelRuntime = await createSharedModelRuntime();
  let scheduledTasks: ReturnType<typeof createScheduledTaskService> | undefined;
  const runtimeSupervisor = new RuntimeSupervisor({
      modelRuntime: sharedModelRuntime,
      resolveAgent: async (agentId) => {
        await agentStore.assertCanCreateSession(agentId);
        return { cwd: await agentStore.resolveWorkspace(agentId) };
      },
      createRuntime: async ({ agentId, cwd, modelRuntime }) => {
        if (options.runtimeFactory) {
          return options.runtimeFactory(paths);
        }
        const profile = await agentStore.get(agentId);
        if (!profile) {
          throw new Error("Agent 不存在");
        }
        const readInstructionPrompts = async () => {
          const latest = await agentStore.get(agentId);
          if (!latest) throw new Error("Agent 不存在");
          const bootsharp = await agentPrompts.read(agentId, "bootsharp");
          return buildAgentInstructionPrompts(latest.profile, bootsharp);
        };
        const webResearchConfig = (await webResearchConfigs.read()).config;
        return createSdkPiRuntimeGateway({
          cwd,
          agentDir: paths.piDir,
          modelRuntime,
          defaultModel: profile.profile.defaultModel,
          defaultThinkingLevel: profile.profile.defaultThinkingLevel,
          titleGeneration: profile.profile.titleGeneration,
          allowedTools: profile.profile.allowedTools,
          customTools: [
            createSearchKnowledgeTool(agentId, knowledgeBases),
            createGetKnowledgeDocumentTool(agentId, knowledgeBases),
            createManageKnowledgeBaseTool(agentId, knowledgeBases, workspaceFileManager),
            createEditOwnPromptsTool(agentId, agentPrompts, async () => {
              await runtimeSupervisor?.refreshAgentPromptContext(agentId);
            }),
            ...(scheduledTasks ? [createScheduledTasksTool(agentId, scheduledTasks)] : []),
            ...(webResearchConfig.enabled && profile.profile.allowedTools.includes("web_search") ? [createWebSearchTool(webResearch)] : []),
            ...(webResearchConfig.enabled && profile.profile.allowedTools.includes("web_open") ? [createWebOpenTool(webResearch)] : []),
          ],
          appendSystemPrompt: await readInstructionPrompts(),
          refreshAppendSystemPrompt: readInstructionPrompts,
          sessionDir: resolveAgentSessionDir(paths, agentId),
          checkpointStore: createRunCheckpointStore(paths.runDir),
          sessionMetadataStore,
          stageSessionDeletion: (sessionId, sessionFile) => durableDeletions.stage("session", sessionId, [
            sessionFile,
            join(paths.runDir, `${sessionId}.json`),
          ]),
          onBackgroundError: (error) => {
            backgroundErrors.record(error.code, error.sessionId ? { sessionId: error.sessionId } : undefined);
            app.log.error(error, "Runtime 后台任务失败");
          },
          onSessionTitleGenerated: (event) => {
            app.log.info(event, "自动会话标题任务完成");
          },
        });
      },
    });
  const runtimeCoordinator: RuntimeCoordinator = createRuntimeCoordinator({
      modelRuntime: sharedModelRuntime,
      runtimeSupervisor,
      recreateModelRuntime: createSharedModelRuntime,
      onModelRuntimeReplaced: (modelRuntime) => { sharedModelRuntime = modelRuntime; },
    });
  const providerRenameService = new ProviderRenameService({
    paths,
    models,
    agents: agentStore,
    beginRuntimeMaintenance: () => runtimeSupervisor.beginMaintenance(),
    refreshModels: () => runtimeCoordinator.refreshModels(),
  });
  scheduledTasks = createScheduledTaskService({
    store: scheduledTaskStore,
    acquireRuntime: async (agentId) => {
      const lease = await runtimeSupervisor.acquire(agentId);
      return { runtime: lease.runtime, release: lease.release };
    },
    assignSession: (sessionId, agentId) => sessionMetadataStore.assignAgent(sessionId, agentId),
    archiveSession: (sessionId) => sessionMetadataStore.archive(sessionId),
    sessionIsPersisted: (agentId, sessionId) => hasPersistedSessionFile(paths, agentId, sessionId),
    onBackgroundError: (error) => {
      backgroundErrors.record(error.code, { taskId: error.taskId });
      app.log.error(error, "定时任务后台执行失败");
    },
  });
  const chatService = new ChatApplicationService({
    runtimeSupervisor,
    sessionAgent: (sessionId) => resolveSessionAgentId(sessionId, sessionMetadataStore),
    workspaceFiles,
    referenceResolver,
  });
  await agentStore.ensureSystemToolPermissions(SYSTEM_TOOL_NAMES);
  if (scheduledTasks) await ensureScheduledTaskSkill(paths.piDir);
  await ensureKnowledgeBaseSkill(paths.piDir);
  await scheduledTasks?.start();
  const composerCatalog = new ComposerCatalogService({
    agents: agentStore,
    agentDir: paths.piDir,
    knowledgeBases,
    workspaceFiles: workspaceFileManager,
    listCommandsForAgent: async (agentId) => {
      const lease = await runtimeSupervisor.acquire(agentId);
      try {
        return await lease.runtime.listCommands();
      } finally {
        lease.release();
      }
    },
  });

  app.get("/healthz", async () => ({ status: "ok" }));
  registerStatusRoutes(app, { paths, authService });
  registerSetupRoutes(app, {
    paths,
    identityRepository: identities,
    onInitialized: async () => {
      try {
        await runtimeCoordinator.refreshModels();
      } catch (error) {
        backgroundErrors.record("RUNTIME_INITIALIZATION_REFRESH_FAILED");
        app.log.error(error, "首启后刷新 Runtime 失败");
      }
    },
  });
  registerAuthRoutes(app, { authService, paths });
  registerModelRoutes(app, {
    authService,
    listModels: () => runtimeCoordinator.listModels(),
  });
  registerSessionRoutes(app, {
    authService,
    runtimeSupervisor,
    sessionMetadata: sessionMetadataStore,
    scheduledTasks,
    assertCanCreateSession: (agentId) => agentStore.assertCanCreateSession(agentId),
    deleteSession: async (sessionId, deleteScheduledTasks) => {
      const agentId = await resolveSessionAgentId(sessionId, sessionMetadataStore);
      const lease = await runtimeSupervisor.acquire(agentId);
      try {
        const staged = await lease.runtime.prepareSessionDeletion?.(sessionId);
        if (!staged) throw new Error("当前 Runtime 不支持事务化删除 Session");
        try {
          await sessionRepository.removeWithBoundTasks(sessionId, deleteScheduledTasks);
        } catch (error) {
          const rollback = await Promise.allSettled([staged.rollback()]);
          if (rollback[0]?.status === "rejected") {
            throw new AggregateError([error, rollback[0].reason], "Session 删除事务回滚失败");
          }
          throw error;
        }
        // SQLite 已提交后，文件清理失败不能把已成功的删除伪装成可重试事务。
        await staged.commit().catch((error) => {
          backgroundErrors.record("SESSION_DELETE_CLEANUP_FAILED", { sessionId });
          app.log.error(error, "Session 暂存文件清理失败");
        });
      } finally {
        lease.release();
      }
    },
  });
  registerScheduledTaskRoutes(app, { authService, service: scheduledTasks });
  registerChatRoutes(app, { authService, runtimeSupervisor, sessionMetadata: sessionMetadataStore, workspaceFiles, referenceResolver, chatService });
  registerAttachmentRoutes(app, {
    authService,
    files: workspaceFiles,
    runAgentMutation: (agentId, operation) => agentLifecycle.runMutation(agentId, operation),
  });
  registerKnowledgeBaseRoutes(app, { authService, service: knowledgeBases });
  registerWorkspaceFileRoutes(app, {
    authService,
    manager: workspaceFileManager,
    runAgentMutation: (agentId, operation) => agentLifecycle.runMutation(agentId, operation),
  });
  registerComposerCatalogRoutes(app, { authService, catalog: composerCatalog });
  registerAgentRoutes(app, {
    authService,
    store: agentStore,
    prompts: agentPrompts,
    refreshPromptContext: (agentId) => runtimeSupervisor.refreshAgentPromptContext(agentId),
    removeAgent: (agentId) => runtimeCoordinator.removeAgent(agentId),
    finalizeAgentRemoval: (agentId) => runtimeCoordinator.finalizeAgentRemoval(agentId),
    restoreAgent: (agentId) => runtimeCoordinator.restoreAgent(agentId),
    runAgentMutation: (agentId, operation) => agentLifecycle.runMutation(agentId, operation),
    runModelMutation: (operation) => modelMutations.run("models-and-agent-defaults", operation),
    beginAgentRemoval: (agentId) => agentLifecycle.beginRemoval(agentId),
    countSessions: async (agentId) => (await sessionMetadataStore.listIdsByAgent(agentId)).length,
    resolveAvailableModel: async (provider, modelId) => {
      // 以当前 revisioned models.json 做提交时完整性校验，不能依赖可能尚未手动刷新的 Runtime 缓存。
      const document = await models.read();
      const providers = document.value.providers;
      const providerNode = providers && typeof providers === "object" && !Array.isArray(providers)
        ? (providers as Record<string, unknown>)[provider]
        : undefined;
      const modelNodes = providerNode && typeof providerNode === "object" && !Array.isArray(providerNode)
        ? (providerNode as Record<string, unknown>).models
        : undefined;
      const model = Array.isArray(modelNodes)
        ? modelNodes.find((candidate) => candidate && typeof candidate === "object" && (candidate as Record<string, unknown>).id === modelId) as Record<string, unknown> | undefined
        : undefined;
      return model ? {
        reasoning: model.reasoning === true,
        ...(model.thinkingLevelMap && typeof model.thinkingLevelMap === "object" ? { thinkingLevelMap: model.thinkingLevelMap as Partial<Record<NonNullable<AgentProfile["defaultThinkingLevel"]>, string | null>> } : {}),
      } : undefined;
    },
  });
  registerProviderRoutes(app, {
    authService,
    models,
    credentials,
    agents: agentStore,
    renameService: providerRenameService,
    testModels: (providerId, request) => runtimeCoordinator.testModels(providerId, request),
    discoverModels: (providerId) => providerModelDiscovery.discover(providerId),
    runModelMutation: (operation) => modelMutations.run("models-and-agent-defaults", operation),
  });
  registerConfigurationRoutes(app, {
    authService,
    paths,
    agents: agentStore,
    historyRepository: createConfigurationHistoryRepository(applicationDatabase),
    backgroundErrors: () => backgroundErrors.summary(),
    operationalStatus: () => ({
      database: {
        quickCheck: applicationDatabase.readOne<{ quick_check: string }>("PRAGMA quick_check")?.quick_check ?? "unknown",
        journalMode: applicationDatabase.readOne<{ journal_mode: string }>("PRAGMA journal_mode")?.journal_mode ?? "unknown",
      },
      runtime: {
        activeLeases: runtimeSupervisor.activeLeaseCount,
        trackedAgents: runtimeSupervisor.trackedAgentCount,
      },
      limits: {
        runtimeSessionsPerAgent: SYSTEM_LIMITS.runtimeSessionsPerAgent,
        sseQueueEntries: SYSTEM_LIMITS.sseQueueEntries,
        sseQueueBytes: SYSTEM_LIMITS.sseQueueBytes,
        workspaceEntries: SYSTEM_LIMITS.workspaceEntries,
        resourceTasks: SYSTEM_LIMITS.resourceTasks,
      },
    }),
    runAgentMutation: (agentId, operation) => agentLifecycle.runMutation(agentId, operation),
    refreshAgent: (agentId) => runtimeCoordinator.refreshAgent(agentId),
    runModelMutation: (operation) => modelMutations.run("models-and-agent-defaults", operation),
    refreshRuntime: () => runtimeCoordinator.refreshRuntime(),
  });
  registerWebResearchRoutes(app, {
    authService,
    configs: webResearchConfigs,
    service: webResearch,
    egressProfiles: webResearchEgressProfiles,
    refreshRuntime: () => runtimeCoordinator.refreshRuntime(),
  });
  registerTtsRoutes(app, {
    authService,
    configs: ttsConfigs,
    synthesize: ttsSynthesis,
    isProfileInUse: async (profileId) => (await agentStore.list()).some((agent) => agent.profile.ttsProfileId === profileId),
    getAgentTtsProfile: async (agentId) => {
      const profile = (await agentStore.get(agentId))?.profile;
      return profile?.ttsProfileId ? { profileId: profile.ttsProfileId, voice: profile.ttsVoice } : undefined;
    },
  });
  registerKnowledgeRetrievalRoutes(app, {
    authService,
    configs: embeddingConfigs,
    rebuildAll: () => knowledgeBases.rebuildSemanticIndex(),
  });
  const resourceTasks = new ResourceTaskManager();
  registerResourceRoutes(app, {
    authService,
    paths,
    agents: agentStore,
    tasks: resourceTasks,
    runAgentMutation: (agentId, operation) => agentLifecycle.runMutation(agentId, operation),
  });

  await app.register(fastifyStatic, {
    root: staticRoot,
    wildcard: false,
    maxAge: "1h",
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      exposeRequestId(request, reply);
      return sendApiError(reply, 404, "NOT_FOUND", "接口不存在");
    }
    reply.header("Cache-Control", "no-cache");
    return reply.sendFile("index.html", { cacheControl: false });
  });

  app.addHook("onClose", async () => {
    const schedulerDrained = await scheduledTasks.stopAndDrain(5_000);
    const resourcesDrained = await resourceTasks.stopAndDrain(5_000);
    await runtimeCoordinator.dispose();
    if (!schedulerDrained && !await scheduledTasks.stopAndDrain(5_000)) {
      throw new Error("定时任务未能在关闭预算内排空，拒绝关闭数据库");
    }
    if (!resourcesDrained && !await resourceTasks.stopAndDrain(5_000)) {
      throw new Error("资源任务未能在关闭预算内排空，拒绝释放实例锁");
    }
    applicationDatabase.close();
    await instanceLock.release();
  });
    return app;
  } catch (error) {
    // 启动装配可能在 onClose 钩子注册前失败，此处必须显式归还全部进程级资源。
    database?.close();
    await instanceLock.release();
    throw error;
  }
}

/**
 * 把 Agent Profile 的稳定角色字段转换为持续注入的系统提示。
 */
function buildAgentInstructionPrompts(profile: AgentProfile, bootsharp = ""): string[] {
  const sections: Array<[string, string]> = [
    ["角色定位", profile.instructions.role],
    ["行为方式", profile.instructions.behavior],
    ["规则", profile.instructions.rules],
    ["用户", profile.instructions.user],
  ];
  const content = sections
    .filter(([, value]) => value.trim())
    .map(([title, value]) => `## ${title}\n\n${value.trim()}`)
    .join("\n\n");
  return [content, bootsharp.trim() ? `## 初始化协作设定\n\n${bootsharp.trim()}` : ""].filter(Boolean);
}


interface GracefulShutdownOptions {
  close(): Promise<void>;
  logError(error: unknown, message: string): void;
  exit(code: number): void;
}

/**
 * 创建幂等的进程关闭入口，避免多个终止信号重复释放同一组资源。
 */
export function createGracefulShutdown(options: GracefulShutdownOptions): () => Promise<void> {
  let closing: Promise<void> | undefined;
  return () => {
    closing ??= options.close().then(
      () => options.exit(0),
      (error: unknown) => {
        options.logError(error, "服务关闭失败");
        options.exit(1);
      },
    );
    return closing;
  };
}

/**
 * 启动容器内服务并处理优雅退出。
 */
export async function startServer(): Promise<void> {
  const app = await buildServer({ logger: true });
  const close = createGracefulShutdown({
    close: () => app.close(),
    logError: (error, message) => app.log.error(error, message),
    exit: (code) => process.exit(code),
  });
  process.once("SIGINT", () => { void close(); });
  process.once("SIGTERM", () => { void close(); });
  await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 7080) });
}

const entryFile = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entryFile === import.meta.url) {
  startServer().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
