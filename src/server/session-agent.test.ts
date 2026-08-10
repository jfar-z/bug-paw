import { describe, expect, it, vi } from "vitest";
import { SessionAgentMissingError, resolveSessionAgentId } from "./session-agent";

describe("Session Agent 归属", () => {
  it("优先返回已持久化的 Agent 归属", async () => {
    const metadata = { getAgentId: vi.fn(async () => "research"), assignAgent: vi.fn() };

    await expect(resolveSessionAgentId("session-1", metadata)).resolves.toBe("research");
  });

  it("未持久化归属时不会猜测或回填默认 Agent", async () => {
    const metadata = { getAgentId: vi.fn(async () => undefined), assignAgent: vi.fn(async () => undefined) };

    await expect(resolveSessionAgentId("session-1", metadata)).rejects.toBeInstanceOf(SessionAgentMissingError);
    expect(metadata.assignAgent).not.toHaveBeenCalled();
  });
});
