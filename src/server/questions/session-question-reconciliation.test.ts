// @vitest-environment node

import { beforeEach, describe, expect, it } from "vitest";

import { compileQuestionResponseProtocol } from "../../shared/question-response-protocol";
import { openDatabase, type Database } from "../database/database";
import { runMigrations } from "../database/migrator";
import { SessionQuestionRepository } from "./session-question-repository";
import { inspectQuestionFacts, reconcileSessionQuestions } from "./session-question-reconciliation";

describe("Session 提问历史对账", () => {
  let database: Database;
  let repository: SessionQuestionRepository;

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
  });

  it("只从成功工具结果和有效内部协议提取事实标识", () => {
    const protocol = compileQuestionResponseProtocol({
      resolutionId: "resolution-1",
      questionRecordId: "record-1",
      status: "submitted",
      answers: [],
      unansweredQuestionIds: ["question-1"],
    }, questionFixture);
    const facts = inspectQuestionFacts([
      toolResult("record-1", false),
      toolResult("record-error", true),
      { role: "user", content: protocol },
      { role: "user", content: "<bug_paw_question_response version=\"2\">\n{}\n</bug_paw_question_response>" },
    ]);

    expect([...facts.successfulQuestionRecordIds]).toEqual(["record-1"]);
    expect([...facts.resolutionIds]).toEqual(["resolution-1"]);
  });

  it("保留有成功工具结果的 pending，关闭缺少结果的孤立记录", () => {
    createPending();
    reconcileSessionQuestions({
      agentId: "agent-1",
      sessionId: "session-1",
      messages: [toolResult("record-1", false)],
      repository,
    });
    expect(repository.findPending("agent-1", "session-1")?.state).toBe("pending");

    repository.discardOrphan("record-1", "orphaned");
    createPending("record-2");
    reconcileSessionQuestions({
      agentId: "agent-1",
      sessionId: "session-1",
      messages: [],
      repository,
    });
    expect(repository.findById("agent-1", "session-1", "record-2")?.state).toBe("discarded");
  });

  it("根据解析协议完成 resolving，否则回滚为 pending", () => {
    createPending();
    const resolution = {
      resolutionId: "resolution-1",
      questionRecordId: "record-1",
      status: "submitted" as const,
      answers: [],
      unansweredQuestionIds: ["question-1"],
    };
    repository.claimResolution({
      id: "record-1",
      agentId: "agent-1",
      sessionId: "session-1",
      expectedVersion: 1,
      resolutionId: "resolution-1",
      resolution,
      now: "2026-08-13T00:01:00.000Z",
    });
    reconcileSessionQuestions({
      agentId: "agent-1",
      sessionId: "session-1",
      messages: [{ role: "user", content: compileQuestionResponseProtocol(resolution, questionFixture) }],
      repository,
    });
    expect(repository.findById("agent-1", "session-1", "record-1")?.state).toBe("submitted");

    createPending("record-2");
    const resolution2 = { ...resolution, resolutionId: "resolution-2", questionRecordId: "record-2" };
    repository.claimResolution({
      id: "record-2",
      agentId: "agent-1",
      sessionId: "session-1",
      expectedVersion: 1,
      resolutionId: "resolution-2",
      resolution: resolution2,
      now: "2026-08-13T00:02:00.000Z",
    });
    reconcileSessionQuestions({
      agentId: "agent-1",
      sessionId: "session-1",
      messages: [],
      repository,
    });
    expect(repository.findById("agent-1", "session-1", "record-2")?.state).toBe("pending");
  });

  function createPending(id = "record-1") {
    return repository.createPending({
      id,
      agentId: "agent-1",
      sessionId: "session-1",
      toolCallId: `call-${id}`,
      questions: [{
        id: "question-1",
        header: "方案",
        question: "请选择方案",
        multiSelect: false,
        options: [
          { id: "option-1", label: "A", description: "方案 A" },
          { id: "option-2", label: "B", description: "方案 B" },
        ],
      }],
      now: "2026-08-13T00:00:00.000Z",
    });
  }
});

const questionFixture = [{
  id: "question-1",
  header: "方案",
  question: "请选择方案",
  multiSelect: false,
  options: [
    { id: "option-1", label: "A", description: "方案 A" },
    { id: "option-2", label: "B", description: "方案 B" },
  ],
}];

function toolResult(questionRecordId: string, isError: boolean) {
  return {
    role: "toolResult",
    toolName: "ask_user",
    isError,
    details: {
      type: "question_pending",
      pendingQuestion: { id: questionRecordId },
    },
    content: [],
  };
}
