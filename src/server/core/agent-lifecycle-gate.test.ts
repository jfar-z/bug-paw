// @vitest-environment node

import { describe, expect, it } from "vitest";
import { AgentLifecycleGate } from "./agent-lifecycle-gate";

describe("AgentLifecycleGate", () => {
  it("删除等待在途写完成并在期间拒绝新写操作", async () => {
    const gate = new AgentLifecycleGate();
    let release: () => void = () => undefined;
    const mutation = gate.runMutation("a1", () => new Promise<void>((resolve) => { release = resolve; }));
    let removalReady = false;
    const removal = gate.beginRemoval("a1", 1_000).then((permit) => {
      removalReady = true;
      return permit;
    });

    await expect(gate.runMutation("a1", async () => undefined)).rejects.toMatchObject({ code: "AGENT_REMOVAL_IN_PROGRESS" });
    expect(removalReady).toBe(false);
    release();
    await mutation;
    const permit = await removal;
    permit.finalize();
  });

  it("重复删除失败不会释放首个删除者的门控", async () => {
    const gate = new AgentLifecycleGate();
    const first = await gate.beginRemoval("a1");

    await expect(gate.beginRemoval("a1")).rejects.toMatchObject({ code: "AGENT_REMOVAL_IN_PROGRESS" });
    await expect(gate.runMutation("a1", async () => undefined)).rejects.toMatchObject({ code: "AGENT_REMOVAL_IN_PROGRESS" });
    first.restore();
    await expect(gate.runMutation("a1", async () => undefined)).resolves.toBeUndefined();
  });
});
