import { randomUUID } from "node:crypto";

import type { SubmitQuestionAnswers } from "../../shared/session-question-contracts";
import {
  QuestionAnswerValidationError,
  validateSubmittedAnswers,
} from "../../shared/session-question-contracts";
import {
  compileQuestionResponseProtocol,
  type QuestionAnswerSubmissionResult,
  type QuestionResolution,
} from "../../shared/question-response-protocol";
import { DomainError } from "../core/errors";
import { KeyedMutex } from "../core/keyed-mutex";
import type { ChatRunSummary } from "../pi-runtime";
import {
  SessionQuestionRuntimeState,
  toPendingProjection,
} from "./session-question-reconciliation";
import {
  SessionQuestionRepository,
  type SessionQuestionRecord,
} from "./session-question-repository";

export interface SubmitAnswersCommand {
  agentId: string;
  sessionId: string;
  questionRecordId: string;
  input: SubmitQuestionAnswers;
}

export interface UserMessageCommand {
  agentId: string;
  sessionId: string;
  prompt: string;
  userText: string;
}

export interface BranchCommand {
  agentId: string;
  sessionId: string;
  messages: readonly unknown[];
}

export type StartQuestionPrompt = (
  sessionId: string,
  prompt: string,
  userText?: string,
) => Promise<ChatRunSummary>;

/** 串行协调问题提交、普通消息放弃和自动任务防护。 */
export class SessionQuestionService {
  private readonly mutations = new KeyedMutex();

  constructor(
    private readonly repository: SessionQuestionRepository,
    private readonly runtimeStateFor: (agentId: string) => SessionQuestionRuntimeState,
  ) {}

  /** 提交零个、部分或全部答案，并自动启动下一 Run。 */
  submitAnswers(input: SubmitAnswersCommand, startPrompt: StartQuestionPrompt): Promise<QuestionAnswerSubmissionResult> {
    return this.mutations.run(input.sessionId, async () => {
      const current = this.requireOwnedRecord(input.agentId, input.sessionId, input.questionRecordId);
      if (current.state !== "pending") {
        throw new DomainError("QUESTION_STATE_CONFLICT", "问题状态已变化");
      }
      if (current.version !== input.input.version) {
        throw new DomainError("QUESTION_VERSION_CONFLICT", "问题版本已变化");
      }

      let validated;
      try {
        validated = validateSubmittedAnswers(toPendingProjection(current), input.input);
      } catch (error) {
        if (error instanceof QuestionAnswerValidationError) {
          throw new DomainError("QUESTION_ANSWER_INVALID", error.message);
        }
        throw error;
      }
      const resolution: QuestionResolution = {
        resolutionId: randomUUID(),
        questionRecordId: current.id,
        status: "submitted",
        answers: validated.answers,
        unansweredQuestionIds: validated.unansweredQuestionIds,
      };
      const run = await this.resolveAndStart(
        current,
        resolution,
        compileQuestionResponseProtocol(resolution, current.questions),
        "",
        startPrompt,
      );
      return { run, resolution };
    });
  }

  /** 普通用户消息会放弃当前 pending，并把内部协议与正文合成一条消息。 */
  startUserMessage(input: UserMessageCommand, startPrompt: StartQuestionPrompt): Promise<ChatRunSummary> {
    return this.mutations.run(input.sessionId, async () => {
      const current = this.repository.findPending(input.agentId, input.sessionId);
      if (!current) return startPrompt(input.sessionId, input.prompt, input.userText);
      if (current.state !== "pending") {
        throw new DomainError("SESSION_AWAITING_USER", "Session 正在等待用户回答");
      }
      const resolution: QuestionResolution = {
        resolutionId: randomUUID(),
        questionRecordId: current.id,
        status: "discarded",
        discardReason: "new_message",
        answers: [],
        unansweredQuestionIds: current.questions.map((question) => question.id),
      };
      const protocol = compileQuestionResponseProtocol(resolution, current.questions);
      const prompt = input.prompt ? `${protocol}\n\n${input.prompt}` : protocol;
      return this.resolveAndStart(current, resolution, prompt, input.userText, startPrompt);
    });
  }

  /** 分支变化后立即以当前 Pi 消息对账待回答问题。 */
  reconcileBranch(input: BranchCommand): void {
    this.runtimeStateFor(input.agentId).reconcile(input.sessionId, input.messages, "branch_changed");
  }

  /** 自动任务不得把消息注入正在等待用户决策的 Session。 */
  assertAutomationCanStart(agentId: string, sessionId: string): void {
    if (this.repository.findPending(agentId, sessionId)) {
      throw new DomainError("SESSION_AWAITING_USER", "Session 正在等待用户回答");
    }
  }

  private async resolveAndStart(
    current: SessionQuestionRecord,
    resolution: QuestionResolution,
    prompt: string,
    userText: string,
    startPrompt: StartQuestionPrompt,
  ): Promise<ChatRunSummary> {
    this.repository.claimResolution({
      id: current.id,
      agentId: current.agentId,
      sessionId: current.sessionId,
      expectedVersion: current.version,
      resolutionId: resolution.resolutionId,
      resolution,
      now: new Date().toISOString(),
    });
    try {
      const run = await startPrompt(current.sessionId, prompt, userText);
      const completed = this.repository.completeResolution(current.id, resolution.resolutionId, run.runId);
      this.runtimeStateFor(current.agentId).recordResolved(current.sessionId, completed);
      return run;
    } catch (error) {
      this.repository.restorePending(current.id, resolution.resolutionId);
      throw error;
    }
  }

  private requireOwnedRecord(agentId: string, sessionId: string, id: string): SessionQuestionRecord {
    const record = this.repository.findById(agentId, sessionId, id);
    if (!record) throw new DomainError("QUESTION_NOT_FOUND", "待回答问题不存在");
    return record;
  }
}
