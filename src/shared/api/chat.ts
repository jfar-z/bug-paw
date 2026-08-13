import { Type, type Static } from "typebox";
import { THINKING_LEVELS } from "../configuration-contracts";
import { SessionHistoryPageSchema } from "../session-history-contracts";
import { PendingQuestionProjectionSchema } from "../session-question-contracts";

const StrictObject = <const T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

export const ThinkingLevelSchema = Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)));

export const ModelSummarySchema = StrictObject({
  provider: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  thinkingLevels: Type.Optional(Type.Array(ThinkingLevelSchema, { uniqueItems: true })),
});

export const ChatRunStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("completed"),
  Type.Literal("aborted"),
  Type.Literal("error"),
  Type.Literal("interrupted"),
]);

export const ChatRunSummarySchema = StrictObject({
  runId: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  status: ChatRunStatusSchema,
  startedAt: Type.String({ minLength: 1 }),
  finishedAt: Type.Optional(Type.String({ minLength: 1 })),
  error: Type.Optional(Type.String()),
});

const AgentReferenceInputSchema = Type.Union([
  StrictObject({ type: Type.Literal("skill"), name: Type.String({ minLength: 1, maxLength: 200 }) }),
  StrictObject({ type: Type.Literal("knowledge"), id: Type.String({ minLength: 1, maxLength: 200 }) }),
  StrictObject({ type: Type.Literal("file"), path: Type.String({ minLength: 1, maxLength: 4_096 }) }),
]);

/** 浏览器可提交的消息字段，服务端协议和调度字段不得穿过该边界。 */
export const ChatPromptInputSchema = StrictObject({
  text: Type.String({ maxLength: 100_000 }),
  filePaths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), {
    maxItems: 5,
    uniqueItems: true,
  })),
  references: Type.Optional(Type.Array(AgentReferenceInputSchema, { maxItems: 20 })),
});

export const SessionProjectionSchema = StrictObject({
  sessionId: Type.String({ minLength: 1 }),
  projectionVersion: Type.Integer({ minimum: 0 }),
  lastEventId: Type.Integer({ minimum: 0 }),
  messages: Type.Array(Type.Unknown()),
  history: SessionHistoryPageSchema,
  model: Type.Optional(ModelSummarySchema),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
  run: Type.Optional(ChatRunSummarySchema),
  pendingQuestion: Type.Optional(PendingQuestionProjectionSchema),
});

const EventIdentity = {
  id: Type.Integer({ minimum: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  runId: Type.String({ minLength: 1 }),
};

/** SSE 首次连接或事件缺口恢复时发送的完整会话快照。 */
export const SessionSnapshotEventSchema = StrictObject({
  id: Type.Integer({ minimum: 0 }),
  sessionId: Type.String({ minLength: 1 }),
  type: Type.Literal("snapshot"),
  messages: Type.Array(Type.Unknown()),
  history: SessionHistoryPageSchema,
  model: Type.Optional(ModelSummarySchema),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
  run: Type.Optional(ChatRunSummarySchema),
  pendingQuestion: Type.Optional(PendingQuestionProjectionSchema),
  lastEventId: Type.Integer({ minimum: 0 }),
});

/** Journal 无法按游标完整重放时，要求客户端重新读取 HTTP Projection。 */
export const SessionProjectionRequiredEventSchema = StrictObject({
  id: Type.Integer({ minimum: 0 }),
  sessionId: Type.String({ minLength: 1 }),
  type: Type.Literal("projection_required"),
  lastEventId: Type.Integer({ minimum: 0 }),
});

export const SessionEventSchema = Type.Union([
  StrictObject({
    id: Type.Integer({ minimum: 1 }),
    sessionId: Type.String({ minLength: 1 }),
    type: Type.Literal("question_pending"),
    pendingQuestion: PendingQuestionProjectionSchema,
  }),
  StrictObject({
    id: Type.Integer({ minimum: 1 }),
    sessionId: Type.String({ minLength: 1 }),
    type: Type.Literal("question_resolved"),
    questionRecordId: Type.String({ minLength: 1 }),
    state: Type.Union([Type.Literal("submitted"), Type.Literal("discarded")]),
  }),
  StrictObject({
    id: Type.Integer({ minimum: 1 }),
    sessionId: Type.String({ minLength: 1 }),
    type: Type.Literal("model_changed"),
    model: ModelSummarySchema,
  }),
  StrictObject({
    id: Type.Integer({ minimum: 1 }),
    sessionId: Type.String({ minLength: 1 }),
    type: Type.Literal("thinking_level_changed"),
    thinkingLevel: ThinkingLevelSchema,
  }),
  StrictObject({ ...EventIdentity, type: Type.Literal("run_started"), run: ChatRunSummarySchema }),
  StrictObject({ ...EventIdentity, type: Type.Literal("text_delta"), delta: Type.String() }),
  StrictObject({ ...EventIdentity, type: Type.Literal("thinking_delta"), delta: Type.String() }),
  StrictObject({ ...EventIdentity, type: Type.Literal("thinking_finished") }),
  StrictObject({
    id: Type.Integer({ minimum: 1 }),
    sessionId: Type.String({ minLength: 1 }),
    type: Type.Literal("session_renamed"),
    name: Type.String({ minLength: 1, maxLength: 120 }),
  }),
  StrictObject({
    ...EventIdentity,
    type: Type.Literal("tool_preparing"),
    callId: Type.String({ minLength: 1 }),
    toolName: Type.String({ minLength: 1 }),
  }),
  StrictObject({
    ...EventIdentity,
    type: Type.Literal("tool_parameters_streaming"),
    callId: Type.String({ minLength: 1 }),
    toolName: Type.String({ minLength: 1 }),
    generatedBytes: Type.Integer({ minimum: 1 }),
    path: Type.Optional(Type.String({ minLength: 1 })),
  }),
  StrictObject({
    ...EventIdentity,
    type: Type.Literal("tool_prepared"),
    callId: Type.String({ minLength: 1 }),
    toolName: Type.String({ minLength: 1 }),
    args: Type.Unknown(),
  }),
  StrictObject({
    ...EventIdentity,
    type: Type.Literal("tool_started"),
    callId: Type.String({ minLength: 1 }),
    toolName: Type.String({ minLength: 1 }),
    args: Type.Unknown(),
  }),
  StrictObject({
    ...EventIdentity,
    type: Type.Literal("tool_updated"),
    callId: Type.String({ minLength: 1 }),
    toolName: Type.String({ minLength: 1 }),
    partialResult: Type.Unknown(),
  }),
  StrictObject({
    ...EventIdentity,
    type: Type.Literal("tool_finished"),
    callId: Type.String({ minLength: 1 }),
    toolName: Type.String({ minLength: 1 }),
    result: Type.Unknown(),
    isError: Type.Boolean(),
  }),
  StrictObject({ ...EventIdentity, type: Type.Literal("completed") }),
  StrictObject({ ...EventIdentity, type: Type.Literal("aborted") }),
  StrictObject({
    ...EventIdentity,
    type: Type.Literal("error"),
    code: Type.String({ minLength: 1 }),
    message: Type.String(),
  }),
]);

export type ModelSummary = Static<typeof ModelSummarySchema>;
export type ChatRunSummary = Static<typeof ChatRunSummarySchema>;
export type ChatPromptInput = Static<typeof ChatPromptInputSchema>;
export type SessionProjection = Static<typeof SessionProjectionSchema>;
export type SessionEvent = Static<typeof SessionEventSchema>;
export type SessionSnapshotEvent = Static<typeof SessionSnapshotEventSchema>;
export type SessionProjectionRequiredEvent = Static<typeof SessionProjectionRequiredEventSchema>;
