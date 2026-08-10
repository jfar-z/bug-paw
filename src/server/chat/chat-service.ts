import type { ChatPromptInput } from "../../shared/api/chat";
import { DomainError } from "../core/errors";
import { SYSTEM_LIMITS } from "../core/limits";
import type { ChatEvent, ChatRunSummary } from "../pi-runtime";
import type { RuntimeSupervisor } from "../runtime/runtime-supervisor";
import type { WorkspaceFileInfo, WorkspaceFileService } from "../attachments";
import { compileAgentReferences, type AgentReferenceResolver } from "../agent-references";
import type { AgentReference, AgentReferenceInput } from "../../shared/agent-reference-contracts";

export interface SessionSubscription {
  events: AsyncIterable<ChatEvent>;
  /** 订阅因关闭、换代或队列保护而终止时完成，用于打断正在等待 drain 的网络写。 */
  terminated: Promise<Error | undefined>;
  close(): void;
}

export interface ChatServiceDependencies {
  runtimeSupervisor: Pick<RuntimeSupervisor, "acquire">;
  sessionAgent(sessionId: string): Promise<string>;
  workspaceFiles?: WorkspaceFileService;
  referenceResolver?: AgentReferenceResolver;
}

/** 以单次 RuntimeLease 完成 Chat 用例，Route 不再重复解析 Runtime。 */
export class ChatApplicationService {
  constructor(private readonly dependencies: ChatServiceDependencies) {}

  async startTurn(sessionId: string, input: ChatPromptInput): Promise<ChatRunSummary> {
    const { agentId, lease } = await this.acquire(sessionId);
    try {
      await lease.runtime.openSession(sessionId);
      const text = input.text.trim();
      const commandName = readCommandName(text);
      if (commandName && !(await lease.runtime.listCommands()).some((command) => command.name === commandName)) {
        throw new DomainError("UNKNOWN_COMMAND", "当前 Agent 不支持该命令");
      }
      const files = await resolveFiles(this.dependencies.workspaceFiles, agentId, input.filePaths ?? []);
      const references = await resolveReferences(this.dependencies.referenceResolver, agentId, input.references ?? []);
      return await lease.runtime.startPrompt(sessionId, buildPrompt(text, mergeReferences(references, files)), text);
    } finally {
      lease.release();
    }
  }

  async abort(sessionId: string): Promise<void> {
    const { lease } = await this.acquire(sessionId);
    try {
      await lease.runtime.openSession(sessionId);
      await lease.runtime.abort(sessionId);
    } finally {
      lease.release();
    }
  }

  async subscribe(sessionId: string, cursor: number | undefined): Promise<SessionSubscription> {
    const { lease } = await this.acquire(sessionId);
    const queue = new BoundedEventQueue();
    try {
      await lease.runtime.openSession(sessionId);
      // 首连必须保留 undefined，让 Runtime 发出原子 snapshot；重连才按客户端游标补发。
      let unsubscribe: () => void = () => undefined;
      let closed = false;
      const close = (failure?: Error) => {
        if (closed) return;
        closed = true;
        unsubscribe();
        if (failure) queue.fail(failure);
        else queue.close();
        lease.release();
      };
      unsubscribe = lease.runtime.subscribe(
        sessionId,
        cursor,
        (event) => queue.push(event),
        (error) => close(error),
      );
      void lease.retired.then(() => close(new DomainError(
        "RUNTIME_GENERATION_RETIRED",
        "Runtime 已刷新，实时连接将自动重连",
      )));
      void queue.terminated.then((failure) => {
        if (failure) close(failure);
      });
      return {
        events: queue,
        terminated: queue.terminated,
        close,
      };
    } catch (error) {
      queue.close();
      lease.release();
      throw error;
    }
  }

  private async acquire(sessionId: string) {
    const agentId = await this.dependencies.sessionAgent(sessionId);
    const lease = await this.dependencies.runtimeSupervisor.acquire(agentId);
    return { agentId, lease };
  }
}

function readCommandName(text: string): string | undefined {
  if (!text.startsWith("/")) return undefined;
  const value = text.slice(1).trim().split(/\s/u, 1)[0];
  return value || undefined;
}

async function resolveFiles(
  service: WorkspaceFileService | undefined,
  agentId: string,
  filePaths: string[],
): Promise<WorkspaceFileInfo[]> {
  if (filePaths.length === 0) return [];
  if (!service) throw new DomainError("INVALID_ATTACHMENT", "文件不存在或不属于当前 Agent 工作目录");
  try {
    const files = await Promise.all(filePaths.map((path) => service.resolve(agentId, path)));
    if (files.every((file): file is WorkspaceFileInfo => file !== undefined)) return files;
  } catch {
    // 路径解析失败与不存在对客户端保持同一授权边界，避免泄露工作区结构。
  }
  throw new DomainError("INVALID_ATTACHMENT", "文件不存在或不属于当前 Agent 工作目录");
}

async function resolveReferences(
  resolver: AgentReferenceResolver | undefined,
  agentId: string,
  inputs: AgentReferenceInput[],
): Promise<AgentReference[]> {
  if (inputs.length === 0) return [];
  const references = await resolver?.resolve(agentId, inputs);
  if (!references) throw new DomainError("INVALID_REFERENCE", "引用不存在或不属于当前 Agent");
  return references;
}

function buildPrompt(text: string, references: AgentReference[]): string {
  const protocol = compileAgentReferences(references);
  return protocol ? `${text}${text ? "\n\n" : ""}${protocol}` : text;
}

function mergeReferences(references: AgentReference[], files: WorkspaceFileInfo[]): AgentReference[] {
  const paths = new Set(references.flatMap((reference) => reference.type === "file" ? [reference.path] : []));
  return [
    ...references,
    ...files.flatMap((file) => {
      if (paths.has(file.path)) return [];
      paths.add(file.path);
      return [{ type: "file" as const, path: file.path, kind: "file" as const, name: file.name }];
    }),
  ];
}

/** 为单个 SSE 客户端隔离有界事件队列，慢客户端不会拖住 Session Turn。 */
class BoundedEventQueue implements AsyncIterable<ChatEvent> {
  private readonly events: Array<{ event: ChatEvent; bytes: number }> = [];
  private readonly waiters: Array<{
    resolve(result: IteratorResult<ChatEvent>): void;
    reject(error: Error): void;
  }> = [];
  private bytes = 0;
  private ended = false;
  private failure: Error | undefined;
  private resolveTerminated: (failure: Error | undefined) => void = () => undefined;
  readonly terminated = new Promise<Error | undefined>((resolve) => {
    this.resolveTerminated = resolve;
  });

  push(event: ChatEvent): void {
    if (this.ended) return;
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (bytes > SYSTEM_LIMITS.realtimeEventBytes || bytes > SYSTEM_LIMITS.sseQueueBytes) {
      this.fail(new DomainError("CLIENT_TOO_SLOW", "单个实时事件超过客户端传输上限，需要重新读取会话状态"));
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value: event });
      return;
    }
    this.events.push({ event, bytes });
    this.bytes += bytes;
    if (this.events.length > SYSTEM_LIMITS.sseQueueEntries || this.bytes > SYSTEM_LIMITS.sseQueueBytes) {
      this.fail(new DomainError("CLIENT_TOO_SLOW", "客户端消费事件过慢，需要重新读取会话状态"));
    }
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    this.resolveTerminated(undefined);
    this.waiters.splice(0).forEach(({ resolve }) => resolve({ done: true, value: undefined }));
  }

  fail(error: Error): void {
    if (this.ended) return;
    this.failure = error;
    this.events.length = 0;
    this.bytes = 0;
    this.ended = true;
    this.resolveTerminated(error);
    this.waiters.splice(0).forEach(({ reject }) => reject(error));
  }

  [Symbol.asyncIterator](): AsyncIterator<ChatEvent> {
    return {
      next: async () => {
        const next = this.events.shift();
        if (next) {
          this.bytes -= next.bytes;
          return { done: false, value: next.event };
        }
        if (this.failure) throw this.failure;
        if (this.ended) return { done: true, value: undefined };
        return new Promise<IteratorResult<ChatEvent>>((resolve, reject) => this.waiters.push({ resolve, reject }));
      },
    };
  }
}
