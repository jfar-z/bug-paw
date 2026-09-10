export type ChatInteractionChannel =
  | "agent-selection"
  | "branch-navigation"
  | "history-edit"
  | "message-send"
  | "model-change"
  | "projection-refresh"
  | "question-submission"
  | "session-transition"
  | "thinking-level-change";

type DiagnosticValue = string | number | boolean;
type DiagnosticDetails = Record<string, DiagnosticValue | undefined>;

export interface ChatInteractionTicket {
  channel: ChatInteractionChannel;
  generation: number;
  details: Readonly<Record<string, DiagnosticValue>>;
}

export interface ChatInteractionTraceEvent {
  sequence: number;
  timestamp: string;
  channel: ChatInteractionChannel;
  generation: number;
  status: "started" | "applied" | "failed" | "discarded" | "invalidated";
  checkpoint?: string;
  details: Readonly<Record<string, DiagnosticValue>>;
}

const TRACE_LIMIT = 128;
const SENSITIVE_DETAIL_KEY = /(authorization|cookie|credential|error|message|prompt|secret|text|token)/iu;
const traceEvents: ChatInteractionTraceEvent[] = [];
let traceSequence = 0;

/**
 * 统一管理聊天异步动作的代次，保证同一交互通道仅有最新意图可以回写页面。
 */
export class ChatInteractionCoordinator {
  private readonly generations = new Map<ChatInteractionChannel, number>();
  private readonly activeGenerations = new Map<ChatInteractionChannel, number>();

  /** 开始一次交互并使同通道更早的异步结果失效。 */
  begin(channel: ChatInteractionChannel, details: DiagnosticDetails = {}): ChatInteractionTicket {
    const generation = (this.generations.get(channel) ?? 0) + 1;
    this.generations.set(channel, generation);
    this.activeGenerations.set(channel, generation);
    const ticket = { channel, generation, details: sanitizeDetails(details) };
    appendTrace(ticket, "started");
    return ticket;
  }

  /** 判断异步结果是否仍属于当前交互意图。 */
  isCurrent(ticket: ChatInteractionTicket): boolean {
    return this.generations.get(ticket.channel) === ticket.generation;
  }

  /** 在回写检查点拒绝迟到结果，并记录可用于复盘竞态的结构化轨迹。 */
  guard(ticket: ChatInteractionTicket, checkpoint: string): boolean {
    if (this.isCurrent(ticket)) return true;
    appendTrace(ticket, "discarded", checkpoint, {
      currentGeneration: this.generations.get(ticket.channel) ?? 0,
    });
    return false;
  }

  /** 记录当前交互的最终结果。 */
  finish(ticket: ChatInteractionTicket, status: "applied" | "failed", details: DiagnosticDetails = {}): void {
    if (this.activeGenerations.get(ticket.channel) === ticket.generation) {
      this.activeGenerations.delete(ticket.channel);
    }
    appendTrace(ticket, status, undefined, details);
  }

  /** 主动废弃某个通道中尚未完成的异步动作。 */
  invalidate(channel: ChatInteractionChannel, reason: string): void {
    const activeGeneration = this.activeGenerations.get(channel);
    if (activeGeneration === undefined) return;
    const generation = activeGeneration + 1;
    this.generations.set(channel, generation);
    this.activeGenerations.delete(channel);
    appendTrace({ channel, generation, details: {} }, "invalidated", reason);
  }

  /** 页面卸载时统一废弃所有已启动通道。 */
  invalidateAll(reason: string): void {
    for (const channel of [...this.activeGenerations.keys()]) {
      this.invalidate(channel, reason);
    }
  }
}

/** 返回当前页面生命周期内最近的聊天交互轨迹。 */
export function readChatInteractionTrace(): ChatInteractionTraceEvent[] {
  return traceEvents.map((event) => ({ ...event, details: { ...event.details } }));
}

/** 清空聊天交互轨迹，主要用于自动化测试和现场问题复现前重置。 */
export function clearChatInteractionTrace(): void {
  traceEvents.length = 0;
  traceSequence = 0;
}

declare global {
  interface Window {
    __BUGPAW_CHAT_DIAGNOSTICS__?: {
      read(): ChatInteractionTraceEvent[];
      clear(): void;
    };
  }
}

if (typeof window !== "undefined" && !window.__BUGPAW_CHAT_DIAGNOSTICS__) {
  // 仅暴露有界、脱敏后的内存轨迹，便于低概率交互问题现场取证。
  window.__BUGPAW_CHAT_DIAGNOSTICS__ = {
    read: readChatInteractionTrace,
    clear: clearChatInteractionTrace,
  };
}

function appendTrace(
  ticket: ChatInteractionTicket,
  status: ChatInteractionTraceEvent["status"],
  checkpoint?: string,
  details: DiagnosticDetails = {},
): void {
  traceSequence += 1;
  traceEvents.push({
    sequence: traceSequence,
    timestamp: new Date().toISOString(),
    channel: ticket.channel,
    generation: ticket.generation,
    status,
    ...(checkpoint ? { checkpoint } : {}),
    details: { ...ticket.details, ...sanitizeDetails(details) },
  });
  if (traceEvents.length > TRACE_LIMIT) traceEvents.splice(0, traceEvents.length - TRACE_LIMIT);
}

/** 诊断字段只允许稳定标识和状态，禁止把消息正文、错误正文或凭据写入轨迹。 */
function sanitizeDetails(details: DiagnosticDetails): Readonly<Record<string, DiagnosticValue>> {
  return Object.fromEntries(Object.entries(details).flatMap(([key, value]) => {
    if (value === undefined || SENSITIVE_DETAIL_KEY.test(key)) return [];
    return [[key, typeof value === "string" ? value.slice(0, 128) : value]];
  }));
}
