// @vitest-environment node

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { ChatApplicationService } from "../../src/server/chat/chat-service";
import {
  createPiRuntimeGateway,
  type ChatEvent,
  type PiRuntimeBackend,
  type PiSessionAdapter,
} from "../../src/server/pi-runtime";

/** 提供可控流式输出，用于验证完整的 Runtime—Chat—多客户端事件链路。 */
class SynchronizedSession implements PiSessionAdapter {
  readonly sessionId = "session-sync";
  readonly sessionFile = "/data/pi/sessions/session-sync.jsonl";
  readonly messages: unknown[] = [];
  readonly model = { provider: "test", id: "model-1", name: "Model 1" };
  isStreaming = false;
  streamingMessage?: unknown;
  private listener?: (event: AgentSessionEvent) => void;
  private finish?: () => void;

  subscribe(listener: (event: AgentSessionEvent) => void) {
    this.listener = listener;
    return () => { this.listener = undefined; };
  }

  async prompt(): Promise<void> {
    this.isStreaming = true;
    await new Promise<void>((resolve) => { this.finish = resolve; });
    this.isStreaming = false;
  }

  emitText(delta: string): void {
    this.listener?.({
      type: "message_update",
      message: {} as never,
      assistantMessageEvent: { type: "text_delta", delta } as never,
    });
  }

  complete(): void { this.finish?.(); }
  async reload(): Promise<void> {}
  async abort(): Promise<void> { this.complete(); }
  async setModel(): Promise<void> {}
  setSessionName(): void {}
  dispose(): void {}
}

describe("Session 多客户端同步集成", () => {
  it("两个客户端收到相同事件序列，重连客户端按游标补发且不中断其他客户端", async () => {
    const session = new SynchronizedSession();
    const gateway = createPiRuntimeGateway(createBackend(session));
    await gateway.openSession(session.sessionId);
    const releases: Array<ReturnType<typeof vi.fn>> = [];
    const service = new ChatApplicationService({
      runtimeSupervisor: {
        acquire: async () => {
          const release = vi.fn();
          releases.push(release);
          return { runtime: gateway, generation: 1, retired: new Promise<void>(() => undefined), release };
        },
      } as never,
      sessionAgent: async () => "agent-sync",
    });
    const first = await service.subscribe(session.sessionId, undefined);
    const second = await service.subscribe(session.sessionId, undefined);
    const firstIterator = first.events[Symbol.asyncIterator]();
    const secondIterator = second.events[Symbol.asyncIterator]();

    await service.startTurn(session.sessionId, { text: "同步输出" });
    session.emitText("第一段");
    session.emitText("第二段");
    session.complete();

    const firstEvents = await readEventsThrough(firstIterator, "completed");
    const secondEvents = await readEventsThrough(secondIterator, "completed");
    expect(secondEvents).toEqual(firstEvents);
    expect(firstEvents.map((event) => event.id)).toEqual([0, 1, 2, 3, 4]);
    expect(firstEvents[0]).toMatchObject({ type: "snapshot", sessionId: session.sessionId, lastEventId: 0 });

    second.close();
    const reconnected = await service.subscribe(session.sessionId, 2);
    const reconnectedIterator = reconnected.events[Symbol.asyncIterator]();
    expect((await reconnectedIterator.next()).value).toMatchObject({ id: 3, type: "text_delta", delta: "第二段" });
    expect((await reconnectedIterator.next()).value).toMatchObject({ id: 4, type: "completed" });
    first.close();
    reconnected.close();
    expect(releases.every((release) => release.mock.calls.length === 1)).toBe(true);
    gateway.dispose();
  });

  it("其他客户端删除 Session 时结束现有订阅并释放 Runtime 租约", async () => {
    const session = new SynchronizedSession();
    const gateway = createPiRuntimeGateway(createBackend(session));
    await gateway.openSession(session.sessionId);
    const release = vi.fn();
    const service = new ChatApplicationService({
      runtimeSupervisor: {
        acquire: async () => ({ runtime: gateway, generation: 1, retired: new Promise<void>(() => undefined), release }),
      } as never,
      sessionAgent: async () => "agent-sync",
    });
    const subscription = await service.subscribe(session.sessionId, undefined);
    const iterator = subscription.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: "snapshot" });

    const staged = await gateway.prepareSessionDeletion?.(session.sessionId);

    await expect(iterator.next()).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
    expect(release).toHaveBeenCalledOnce();
    await staged?.rollback();
    gateway.dispose();
  });
});

function createBackend(session: SynchronizedSession): PiRuntimeBackend {
  return {
    listModels: async () => [session.model],
    listCommands: async () => [],
    listSessions: async () => [{
      id: session.sessionId,
      path: session.sessionFile,
      created: "2026-08-07T00:00:00.000Z",
      modified: "2026-08-07T00:00:00.000Z",
      messageCount: 1,
      firstMessage: "同步输出",
    }],
    createSession: async () => session,
    openSession: async () => session,
    findModel: () => session.model,
    deleteSession: async () => undefined,
  };
}

async function readEventsThrough(
  iterator: AsyncIterator<ChatEvent>,
  terminalType: ChatEvent["type"],
): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  while (events.at(-1)?.type !== terminalType) {
    const next = await iterator.next();
    if (next.done) break;
    events.push(next.value);
  }
  return events;
}
