// @vitest-environment node

import { beforeEach, describe, expect, it } from "vitest";

import type { QuestionResolution } from "../../shared/question-response-protocol";
import { openDatabase, type Database } from "../database/database";
import { runMigrations } from "../database/migrator";
import { SessionQuestionRepository } from "./session-question-repository";

describe("SessionQuestionRepository", () => {
  let database: Database;
  let repository: SessionQuestionRepository;

  beforeEach(() => {
    database = openDatabase(":memory:");
    runMigrations(database);
    insertAgentAndSession(database, "agent-1", "session-1");
    insertAgentAndSession(database, "agent-2", "session-2", 1);
    repository = new SessionQuestionRepository(database);
  });

  it("创建并按 Agent 与 Session 隔离读取未解决问题", () => {
    const created = repository.createPending({
      id: "record-1",
      agentId: "agent-1",
      sessionId: "session-1",
      toolCallId: "call-1",
      branchAnchorId: "entry-1",
      questions: questionDocuments(),
      now: "2026-08-13T00:00:00.000Z",
    });

    expect(created).toMatchObject({ id: "record-1", state: "pending", version: 1 });
    expect(repository.findPending("agent-1", "session-1")).toEqual(created);
    expect(repository.findPending("agent-2", "session-1")).toBeUndefined();
    expect(repository.findById("agent-1", "session-1", "record-1")).toEqual(created);
    expect(repository.findById("agent-2", "session-1", "record-1")).toBeUndefined();
    expect(() => repository.createPending({
      ...created,
      id: "record-2",
      questions: created.questions,
      now: "2026-08-13T00:01:00.000Z",
    })).toThrow("Session 已有待回答问题");
  });

  it("以比较更新完成 claim、complete 和 rollback", () => {
    repository.createPending(pendingInput());
    const resolution = submittedResolution();

    const claimed = repository.claimResolution({
      id: "record-1",
      agentId: "agent-1",
      sessionId: "session-1",
      expectedVersion: 1,
      resolutionId: "resolution-1",
      resolution,
      now: "2026-08-13T00:01:00.000Z",
    });
    expect(claimed).toMatchObject({ state: "resolving", version: 2, resolutionId: "resolution-1" });
    expect(() => repository.claimResolution({
      id: "record-1",
      agentId: "agent-1",
      sessionId: "session-1",
      expectedVersion: 1,
      resolutionId: "resolution-other",
      resolution: { ...resolution, resolutionId: "resolution-other" },
      now: "2026-08-13T00:02:00.000Z",
    })).toThrow("问题状态已变化");

    const restored = repository.restorePending("record-1", "resolution-1");
    expect(restored).toMatchObject({ state: "pending", version: 1 });
    expect(restored.resolution).toBeUndefined();

    const claimedAgain = repository.claimResolution({
      id: "record-1",
      agentId: "agent-1",
      sessionId: "session-1",
      expectedVersion: 1,
      resolutionId: "resolution-2",
      resolution: { ...resolution, resolutionId: "resolution-2" },
      now: "2026-08-13T00:03:00.000Z",
    });
    const completed = repository.completeResolution(claimedAgain.id, "resolution-2", "run-2");
    expect(completed).toMatchObject({ state: "submitted", version: 3, resumedRunId: "run-2" });
    expect(repository.findPending("agent-1", "session-1")).toBeUndefined();
  });

  it("把失去历史锚点的问题安全标记为 discarded", () => {
    repository.createPending(pendingInput());

    const discarded = repository.discardOrphan("record-1", "branch_changed");

    expect(discarded).toMatchObject({ state: "discarded", version: 2 });
    expect(discarded.resolution).toMatchObject({
      questionRecordId: "record-1",
      status: "discarded",
      discardReason: "branch_changed",
      answers: [],
      unansweredQuestionIds: ["question-1"],
    });
  });

  function pendingInput() {
    return {
      id: "record-1",
      agentId: "agent-1",
      sessionId: "session-1",
      toolCallId: "call-1",
      branchAnchorId: "entry-1",
      questions: questionDocuments(),
      now: "2026-08-13T00:00:00.000Z",
    };
  }

  function submittedResolution(): QuestionResolution {
    return {
      resolutionId: "resolution-1",
      questionRecordId: "record-1",
      status: "submitted",
      answers: [{ questionId: "question-1", kind: "options", optionIds: ["option-1"] }],
      unansweredQuestionIds: [],
    };
  }
});

function questionDocuments() {
  return [{
    id: "question-1",
    header: "方案",
    question: "请选择方案",
    multiSelect: false,
    options: [
      { id: "option-1", label: "A", description: "方案 A" },
      { id: "option-2", label: "B", description: "方案 B" },
    ],
  }];
}

function insertAgentAndSession(database: Database, agentId: string, sessionId: string, order = 0): void {
  const now = "2026-08-13T00:00:00.000Z";
  database.write(
    "INSERT INTO agents(id, cwd, profile_json, sort_order, revision, created_at, updated_at) VALUES (?, ?, '{}', ?, 1, ?, ?)",
    [agentId, `/data/workspace/${agentId}`, order, now, now],
  );
  database.write(
    "INSERT INTO sessions(id, agent_id, projection_version, created_at, updated_at) VALUES (?, ?, 0, ?, ?)",
    [sessionId, agentId, now, now],
  );
}
