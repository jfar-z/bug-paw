// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseQuestionResponseProtocol } from "../../src/shared/question-response-protocol";
import { openDatabase, type Database } from "../../src/server/database/database";
import { runMigrations } from "../../src/server/database/migrator";
import { createAskUserTool } from "../../src/server/questions/ask-user-tool";
import { SessionQuestionRepository } from "../../src/server/questions/session-question-repository";
import { SessionQuestionRuntimeState } from "../../src/server/questions/session-question-reconciliation";
import { SessionQuestionService } from "../../src/server/questions/session-question-service";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Session 结构化提问集成", () => {
  it("从工具提问到部分回答只启动一次下一 Run", async () => {
    const database = await createDatabase("flow");
    insertOwner(database, "session-flow");
    const repository = new SessionQuestionRepository(database);
    const state = new SessionQuestionRuntimeState("agent-1", repository);
    const tool = createAskUserTool({
      agentId: "agent-1",
      sessionId: "session-flow",
      branchAnchorId: () => "leaf-1",
      repository,
    });

    const toolResult = await tool.execute("call-ask", questionParameters(), undefined as never);

    expect(toolResult).toMatchObject({ isError: false, terminate: true });
    const pending = state.findPending("session-flow");
    expect(pending).toMatchObject({ toolCallId: "call-ask", version: 1 });
    const startPrompt = vi.fn(async () => runSummary("session-flow"));
    const service = new SessionQuestionService(repository, () => state);

    const run = await service.submitAnswers({
      agentId: "agent-1",
      sessionId: "session-flow",
      questionRecordId: pending!.id,
      input: {
        version: pending!.version,
        answers: [{
          questionId: pending!.questions[0].id,
          kind: "options",
          optionIds: [pending!.questions[0].options[0].id],
        }],
      },
    }, startPrompt);

    expect(run).toEqual(runSummary("session-flow"));
    expect(startPrompt).toHaveBeenCalledOnce();
    const protocol = parseQuestionResponseProtocol(startPrompt.mock.calls[0][1]);
    expect(protocol.resolution).toMatchObject({
      status: "submitted",
      questionRecordId: pending!.id,
      unansweredQuestionIds: [pending!.questions[1].id],
    });
    expect(state.findPending("session-flow")).toBeUndefined();
    expect(state.consumeResolvedEvent("session-flow")).toEqual({
      questionRecordId: pending!.id,
      state: "submitted",
    });
    database.close();
  });

  it("进程重启后恢复问题，并允许零答案提交", async () => {
    const root = await mkdtemp(join(tmpdir(), "bugpaw-question-restart-"));
    roots.push(root);
    const databasePath = join(root, "bugpaw.sqlite3");
    const first = openDatabase(databasePath);
    runMigrations(first);
    insertOwner(first, "session-restart");
    const firstRepository = new SessionQuestionRepository(first);
    const tool = createAskUserTool({
      agentId: "agent-1",
      sessionId: "session-restart",
      branchAnchorId: () => "leaf-before-restart",
      repository: firstRepository,
    });
    const toolResult = await tool.execute("call-restart", questionParameters(), undefined as never);
    const original = (toolResult.details as { pendingQuestion: { id: string } }).pendingQuestion;
    first.checkpoint();
    first.close();

    const restarted = openDatabase(databasePath);
    runMigrations(restarted);
    const repository = new SessionQuestionRepository(restarted);
    const state = new SessionQuestionRuntimeState("agent-1", repository);
    const recovered = state.findPending("session-restart");

    expect(recovered).toMatchObject({ id: original.id, toolCallId: "call-restart", version: 1 });
    const startPrompt = vi.fn(async () => runSummary("session-restart"));
    await new SessionQuestionService(repository, () => state).submitAnswers({
      agentId: "agent-1",
      sessionId: "session-restart",
      questionRecordId: recovered!.id,
      input: { version: recovered!.version, answers: [] },
    }, startPrompt);

    expect(parseQuestionResponseProtocol(startPrompt.mock.calls[0][1]).resolution).toMatchObject({
      status: "submitted",
      answers: [],
      unansweredQuestionIds: recovered!.questions.map((question) => question.id),
    });
    restarted.close();
  });

  it("普通消息放弃待回答问题并携带用户可见正文", async () => {
    const database = await createDatabase("discard");
    insertOwner(database, "session-discard");
    const repository = new SessionQuestionRepository(database);
    const state = new SessionQuestionRuntimeState("agent-1", repository);
    const tool = createAskUserTool({
      agentId: "agent-1",
      sessionId: "session-discard",
      branchAnchorId: () => undefined,
      repository,
    });
    await tool.execute("call-discard", questionParameters(), undefined as never);
    const startPrompt = vi.fn(async () => runSummary("session-discard"));

    await new SessionQuestionService(repository, () => state).startUserMessage({
      agentId: "agent-1",
      sessionId: "session-discard",
      prompt: "改做另一件事",
      userText: "改做另一件事",
    }, startPrompt);

    const parsed = parseQuestionResponseProtocol(startPrompt.mock.calls[0][1]);
    expect(parsed).toMatchObject({
      resolution: { status: "discarded", discardReason: "new_message" },
      visibleText: "改做另一件事",
    });
    expect(state.findPending("session-discard")).toBeUndefined();
    database.close();
  });
});

async function createDatabase(label: string): Promise<Database> {
  const root = await mkdtemp(join(tmpdir(), `bugpaw-question-${label}-`));
  roots.push(root);
  const database = openDatabase(join(root, "bugpaw.sqlite3"));
  runMigrations(database);
  return database;
}

function insertOwner(database: Database, sessionId: string): void {
  const now = "2026-08-13T00:00:00.000Z";
  database.write(
    "INSERT OR IGNORE INTO agents(id, cwd, profile_json, sort_order, revision, created_at, updated_at) VALUES ('agent-1', '/tmp/agent-1', '{}', 0, 1, ?, ?)",
    [now, now],
  );
  database.write(
    "INSERT INTO sessions(id, agent_id, projection_version, created_at, updated_at) VALUES (?, 'agent-1', 0, ?, ?)",
    [sessionId, now, now],
  );
}

function questionParameters() {
  return {
    questions: [
      {
        header: "方案",
        question: "请选择实现方案",
        multiSelect: false,
        options: [
          { label: "方案 A", description: "使用默认方案" },
          { label: "方案 B", description: "使用兼容方案" },
        ],
      },
      {
        header: "能力",
        question: "请选择附加能力",
        multiSelect: true,
        options: [
          { label: "离线", description: "支持离线访问" },
          { label: "通知", description: "支持系统通知" },
        ],
      },
    ],
  };
}

function runSummary(sessionId: string) {
  return {
    runId: `run-${sessionId}`,
    sessionId,
    status: "running" as const,
    startedAt: "2026-08-13T00:01:00.000Z",
  };
}
