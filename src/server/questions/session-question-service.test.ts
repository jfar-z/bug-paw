// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

import { parseQuestionResponseProtocol } from "../../shared/question-response-protocol";
import { openDatabase, type Database } from "../database/database";
import { runMigrations } from "../database/migrator";
import { SessionQuestionRepository } from "./session-question-repository";
import { SessionQuestionRuntimeState } from "./session-question-reconciliation";
import { SessionQuestionService } from "./session-question-service";

describe("SessionQuestionService", () => {
  let database: Database;
  let repository: SessionQuestionRepository;
  let service: SessionQuestionService;

  beforeEach(() => {
    database = openDatabase(":memory:");
    runMigrations(database);
    const now = "2026-08-13T00:00:00.000Z";
    database.write(
      "INSERT INTO agents(id, cwd, profile_json, sort_order, revision, created_at, updated_at) VALUES ('agent-1', '/tmp/agent-1', '{}', 0, 1, ?, ?)",
      [now, now],
    );
    database.write(
      "INSERT INTO sessions(id, agent_id, projection_version, created_at, updated_at) VALUES ('session-1', 'agent-1', 0, ?, ?)",
      [now, now],
    );
    repository = new SessionQuestionRepository(database);
    const state = new SessionQuestionRuntimeState("agent-1", repository);
    service = new SessionQuestionService(repository, () => state);
  });

  it.each([
    ["零答案", []],
    ["部分答案", [{ questionId: "question-1", kind: "options" as const, optionIds: ["option-1"] }]],
  ])("提交%s时编译未回答题目并只启动一次下一 Run", async (_name, answers) => {
    createPending();
    const startPrompt = vi.fn(async (_sessionId: string, _prompt: string, _userText?: string) => runSummary());

    const run = await service.submitAnswers({
      agentId: "agent-1",
      sessionId: "session-1",
      questionRecordId: "record-1",
      input: { version: 1, answers },
    }, startPrompt);

    expect(run).toEqual(runSummary());
    expect(startPrompt).toHaveBeenCalledOnce();
    const parsed = parseQuestionResponseProtocol(startPrompt.mock.calls[0][1]);
    expect(parsed.resolution).toMatchObject({
      questionRecordId: "record-1",
      status: "submitted",
      answers,
      unansweredQuestionIds: answers.length === 0 ? ["question-1", "question-2"] : ["question-2"],
    });
    expect(repository.findById("agent-1", "session-1", "record-1")?.state).toBe("submitted");
  });

  it("并发提交相同版本时只有一个请求获得下一 Run", async () => {
    createPending();
    const startPrompt = vi.fn(async (_sessionId: string, _prompt: string, _userText?: string) => runSummary());
    const command = {
      agentId: "agent-1",
      sessionId: "session-1",
      questionRecordId: "record-1",
      input: { version: 1, answers: [] },
    };

    const results = await Promise.allSettled([
      service.submitAnswers(command, startPrompt),
      service.submitAnswers(command, startPrompt),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected"
      && (result.reason as { code?: string }).code === "QUESTION_STATE_CONFLICT")).toHaveLength(1);
    expect(startPrompt).toHaveBeenCalledOnce();
  });

  it("下一 Run 启动失败时恢复原版本 pending 以允许重试", async () => {
    createPending();
    const startPrompt = vi.fn(async (_sessionId: string, _prompt: string, _userText?: string) => {
      throw new Error("runtime unavailable");
    });

    await expect(service.submitAnswers({
      agentId: "agent-1",
      sessionId: "session-1",
      questionRecordId: "record-1",
      input: { version: 1, answers: [] },
    }, startPrompt)).rejects.toThrow("runtime unavailable");

    expect(repository.findPending("agent-1", "session-1")).toMatchObject({ state: "pending", version: 1 });
  });

  it("普通用户消息放弃 pending，并把协议和正文合并为同一条 Pi 消息", async () => {
    createPending();
    const startPrompt = vi.fn(async (_sessionId: string, _prompt: string, _userText?: string) => runSummary());

    await service.startUserMessage({
      agentId: "agent-1",
      sessionId: "session-1",
      prompt: "请改做另一件事",
      userText: "请改做另一件事",
    }, startPrompt);

    expect(startPrompt).toHaveBeenCalledOnce();
    const parsed = parseQuestionResponseProtocol(startPrompt.mock.calls[0][1]);
    expect(parsed).toMatchObject({
      resolution: { status: "discarded", discardReason: "new_message" },
      visibleText: "请改做另一件事",
    });
    expect(startPrompt.mock.calls[0][2]).toBe("请改做另一件事");
    expect(repository.findById("agent-1", "session-1", "record-1")?.state).toBe("discarded");
  });

  it("阻止自动任务向待回答 Session 注入消息", () => {
    createPending();
    expect(() => service.assertAutomationCanStart("agent-1", "session-1"))
      .toThrow("Session 正在等待用户回答");
  });

  function createPending() {
    return repository.createPending({
      id: "record-1",
      agentId: "agent-1",
      sessionId: "session-1",
      toolCallId: "call-1",
      questions: [question("question-1"), question("question-2")],
      now: "2026-08-13T00:00:00.000Z",
    });
  }
});

function question(id: string) {
  return {
    id,
    header: "方案",
    question: "请选择方案",
    multiSelect: false,
    options: [
      { id: "option-1", label: "A", description: "方案 A" },
      { id: "option-2", label: "B", description: "方案 B" },
    ],
  };
}

function runSummary() {
  return {
    runId: "run-2",
    sessionId: "session-1",
    status: "running" as const,
    startedAt: "2026-08-13T00:01:00.000Z",
  };
}
