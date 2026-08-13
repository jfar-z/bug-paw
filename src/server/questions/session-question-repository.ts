import { randomUUID } from "node:crypto";

import { Check } from "typebox/value";

import {
  PendingQuestionProjectionSchema,
  type PendingQuestionProjection,
} from "../../shared/session-question-contracts";
import {
  QuestionResolutionSchema,
  type QuestionResolution,
} from "../../shared/question-response-protocol";
import { DomainError } from "../core/errors";
import type { Database } from "../database/database";

export type SessionQuestionState = "pending" | "resolving" | "submitted" | "discarded";

/** 数据库中的完整 Session 提问记录。 */
export interface SessionQuestionRecord {
  id: string;
  agentId: string;
  sessionId: string;
  toolCallId: string;
  branchAnchorId?: string;
  state: SessionQuestionState;
  version: number;
  questions: PendingQuestionProjection["questions"];
  resolution?: QuestionResolution;
  resolutionId?: string;
  resumedRunId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePendingQuestionRecord {
  id: string;
  agentId: string;
  sessionId: string;
  toolCallId: string;
  branchAnchorId?: string;
  questions: PendingQuestionProjection["questions"];
  now: string;
}

export interface ClaimQuestionResolution {
  id: string;
  agentId: string;
  sessionId: string;
  expectedVersion: number;
  resolutionId: string;
  resolution: QuestionResolution;
  now: string;
}

/** 提供问题记录的同步、比较更新状态原语。 */
export class SessionQuestionRepository {
  constructor(private readonly database: Database) {}

  /** 创建一个待回答问题。 */
  createPending(input: CreatePendingQuestionRecord): SessionQuestionRecord {
    assertQuestions(input.questions);
    try {
      this.database.write(`
        INSERT INTO session_questions(
          id, agent_id, session_id, tool_call_id, branch_anchor_id, state, version,
          questions_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', 1, ?, ?, ?)
      `, [
        input.id,
        input.agentId,
        input.sessionId,
        input.toolCallId,
        input.branchAnchorId ?? null,
        JSON.stringify(input.questions),
        input.now,
        input.now,
      ]);
    } catch (error) {
      if (isConstraintError(error)) {
        throw new DomainError("QUESTION_STATE_CONFLICT", "Session 已有待回答问题", undefined, { cause: error });
      }
      throw error;
    }
    return this.requireById(input.agentId, input.sessionId, input.id);
  }

  /** 查找 Session 当前唯一的未解决问题。 */
  findPending(agentId: string, sessionId: string): SessionQuestionRecord | undefined {
    const row = this.database.readOne<SessionQuestionRow>(`
      SELECT * FROM session_questions
      WHERE agent_id = ? AND session_id = ? AND state IN ('pending', 'resolving')
      ORDER BY created_at DESC LIMIT 1
    `, [agentId, sessionId]);
    return row ? toRecord(row) : undefined;
  }

  /** 按三重归属读取问题。 */
  findById(agentId: string, sessionId: string, id: string): SessionQuestionRecord | undefined {
    const row = this.database.readOne<SessionQuestionRow>(`
      SELECT * FROM session_questions WHERE id = ? AND agent_id = ? AND session_id = ?
    `, [id, agentId, sessionId]);
    return row ? toRecord(row) : undefined;
  }

  /** 抢占一次回答或放弃解析。 */
  claimResolution(input: ClaimQuestionResolution): SessionQuestionRecord {
    if (!Check(QuestionResolutionSchema, input.resolution)
      || input.resolution.resolutionId !== input.resolutionId
      || input.resolution.questionRecordId !== input.id) {
      throw new DomainError("QUESTION_ANSWER_INVALID", "问题解析结果不符合约束");
    }

    const current = this.findById(input.agentId, input.sessionId, input.id);
    if (!current) throw new DomainError("QUESTION_NOT_FOUND", "待回答问题不存在");
    if (current.state !== "pending") {
      throw new DomainError("QUESTION_STATE_CONFLICT", "问题状态已变化");
    }
    if (current.version !== input.expectedVersion) {
      throw new DomainError("QUESTION_VERSION_CONFLICT", "问题版本已变化");
    }

    const result = this.database.write(`
      UPDATE session_questions
      SET state = 'resolving', version = version + 1, resolution_json = ?,
          resolution_id = ?, updated_at = ?
      WHERE id = ? AND agent_id = ? AND session_id = ? AND state = 'pending'
        AND version = ? AND resolution_id IS NULL
    `, [
      JSON.stringify(input.resolution),
      input.resolutionId,
      input.now,
      input.id,
      input.agentId,
      input.sessionId,
      input.expectedVersion,
    ]);
    assertQuestionChanged(result.changes);
    return this.requireById(input.agentId, input.sessionId, input.id);
  }

  /** 在续跑成功后把 resolving 问题提交为终态。 */
  completeResolution(id: string, resolutionId: string, resumedRunId: string): SessionQuestionRecord {
    const current = this.requireByRecordId(id);
    const result = this.database.write(`
      UPDATE session_questions
      SET state = 'submitted', version = version + 1, resumed_run_id = ?, updated_at = ?
      WHERE id = ? AND agent_id = ? AND session_id = ? AND state = 'resolving'
        AND version = ? AND resolution_id = ?
    `, [
      resumedRunId,
      new Date().toISOString(),
      current.id,
      current.agentId,
      current.sessionId,
      current.version,
      resolutionId,
    ]);
    assertQuestionChanged(result.changes);
    return this.requireById(current.agentId, current.sessionId, current.id);
  }

  /** 续跑启动失败时恢复为待回答状态，允许用户重试。 */
  restorePending(id: string, resolutionId: string): SessionQuestionRecord {
    const current = this.requireByRecordId(id);
    const result = this.database.write(`
      UPDATE session_questions
      SET state = 'pending', version = version + 1, resolution_json = NULL,
          resolution_id = NULL, resumed_run_id = NULL, updated_at = ?
      WHERE id = ? AND agent_id = ? AND session_id = ? AND state = 'resolving'
        AND version = ? AND resolution_id = ?
    `, [
      new Date().toISOString(),
      current.id,
      current.agentId,
      current.sessionId,
      current.version,
      resolutionId,
    ]);
    assertQuestionChanged(result.changes);
    return this.requireById(current.agentId, current.sessionId, current.id);
  }

  /** 把无法再与 Pi 历史对应的问题关闭为放弃终态。 */
  discardOrphan(id: string, reason: "branch_changed" | "orphaned"): SessionQuestionRecord {
    const current = this.requireByRecordId(id);
    if (current.state !== "pending" && current.state !== "resolving") {
      throw new DomainError("QUESTION_STATE_CONFLICT", "问题状态已变化");
    }
    const resolutionId = randomUUID();
    const resolution: QuestionResolution = {
      resolutionId,
      questionRecordId: current.id,
      status: "discarded",
      discardReason: reason,
      answers: [],
      unansweredQuestionIds: current.questions.map((question) => question.id),
    };
    const result = this.database.write(`
      UPDATE session_questions
      SET state = 'discarded', version = version + 1, resolution_json = ?,
          resolution_id = ?, resumed_run_id = NULL, updated_at = ?
      WHERE id = ? AND agent_id = ? AND session_id = ? AND state = ?
        AND version = ? AND resolution_id IS ?
    `, [
      JSON.stringify(resolution),
      resolutionId,
      new Date().toISOString(),
      current.id,
      current.agentId,
      current.sessionId,
      current.state,
      current.version,
      current.resolutionId ?? null,
    ]);
    assertQuestionChanged(result.changes);
    return this.requireById(current.agentId, current.sessionId, current.id);
  }

  private requireById(agentId: string, sessionId: string, id: string): SessionQuestionRecord {
    const record = this.findById(agentId, sessionId, id);
    if (!record) throw new DomainError("QUESTION_NOT_FOUND", "待回答问题不存在");
    return record;
  }

  private requireByRecordId(id: string): SessionQuestionRecord {
    const row = this.database.readOne<SessionQuestionRow>(
      "SELECT * FROM session_questions WHERE id = ?",
      [id],
    );
    if (!row) throw new DomainError("QUESTION_NOT_FOUND", "待回答问题不存在");
    return toRecord(row);
  }
}

interface SessionQuestionRow extends Record<string, unknown> {
  id: string;
  agent_id: string;
  session_id: string;
  tool_call_id: string;
  branch_anchor_id: string | null;
  state: SessionQuestionState;
  version: number;
  questions_json: string;
  resolution_json: string | null;
  resolution_id: string | null;
  resumed_run_id: string | null;
  created_at: string;
  updated_at: string;
}

function toRecord(row: SessionQuestionRow): SessionQuestionRecord {
  let questions: unknown;
  let resolution: unknown;
  try {
    questions = JSON.parse(row.questions_json);
    resolution = row.resolution_json === null ? undefined : JSON.parse(row.resolution_json);
  } catch (error) {
    throw new DomainError("INTERNAL_ERROR", "Session 提问持久化数据无效", undefined, { cause: error });
  }
  assertQuestions(questions);
  if (resolution !== undefined && !Check(QuestionResolutionSchema, resolution)) {
    throw new DomainError("INTERNAL_ERROR", "Session 提问解析数据无效");
  }
  return {
    id: row.id,
    agentId: row.agent_id,
    sessionId: row.session_id,
    toolCallId: row.tool_call_id,
    ...(row.branch_anchor_id ? { branchAnchorId: row.branch_anchor_id } : {}),
    state: row.state,
    version: row.version,
    questions,
    ...(resolution ? { resolution } : {}),
    ...(row.resolution_id ? { resolutionId: row.resolution_id } : {}),
    ...(row.resumed_run_id ? { resumedRunId: row.resumed_run_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertQuestions(value: unknown): asserts value is PendingQuestionProjection["questions"] {
  const projection = {
    id: "validation",
    version: 1,
    toolCallId: "validation",
    questions: value,
    createdAt: "validation",
  };
  if (!Check(PendingQuestionProjectionSchema, projection)) {
    throw new DomainError("INTERNAL_ERROR", "Session 提问题目数据无效");
  }
}

function assertQuestionChanged(changes: number): void {
  if (changes !== 1) throw new DomainError("QUESTION_STATE_CONFLICT", "问题状态已变化");
}

function isConstraintError(error: unknown): boolean {
  return error instanceof Error && /constraint|unique|foreign key/iu.test(error.message);
}
