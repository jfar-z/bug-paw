// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  generateWorkflowScript,
  WORKFLOW_SCRIPT_SYSTEM_PROMPT,
} from "./workflow-script-assist";
import type { WorkflowScriptAssistRequest } from "../../shared/workflow-contracts";

/** 模型只使用假响应，语法验证使用实际 QuickJS 隔离环境。 */
const input: WorkflowScriptAssistRequest = {
  provider: "test",
  modelId: "script",
  requirement: "把 value 转为大写",
  script: "return { result: inputs.value };",
  inputs: [
    {
      name: "value",
      type: "string",
      source: { kind: "reference", nodeId: "input", field: "prompt" },
    },
  ],
  outputs: [{ name: "result", type: "string", required: true }],
  timeoutMs: 1000,
};
function fixture(
  text = "return { result: String(inputs.value).toUpperCase() };",
) {
  const completeSimple = vi.fn(async () => ({
    stopReason: "stop",
    content: [{ type: "text", text }],
  }));
  const runtime = {
    getModel: vi.fn(() => ({ name: "测试模型" })),
    completeSimple,
  } as never;
  return { runtime, completeSimple };
}
describe("脚本 AI 辅助", () => {
  it("提示词包含执行约束，提交出入参和现有脚本；仅编译不会执行生成代码", async () => {
    const f = fixture(
      'throw new Error("不应在生成时执行"); return { result: inputs.value };',
    );
    const result = await generateWorkflowScript(
      f.runtime,
      input,
      new AbortController().signal,
    );
    expect(result.script).toContain("不应在生成时执行");
    const [, context, options] = f.completeSimple.mock.calls[0] as unknown as [
      unknown,
      { systemPrompt: string; messages: { content: string }[] },
      { signal: AbortSignal },
    ];
    expect(context.systemPrompt).toBe(WORKFLOW_SCRIPT_SYSTEM_PROMPT);
    expect(context.systemPrompt).toContain("0 和 false");
    expect(context.systemPrompt).toContain("没有 Node");
    expect(JSON.parse(context.messages[0].content)).toMatchObject({
      inputs: input.inputs,
      outputs: input.outputs,
      script: input.script,
      requirement: input.requirement,
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });
  it("支持单层代码围栏，语法错误、空内容、拒绝和截断均明确报错", async () => {
    const f = fixture('```javascript\nreturn { result: "ok" };\n```');
    expect(
      (
        await generateWorkflowScript(
          f.runtime,
          input,
          new AbortController().signal,
        )
      ).script,
    ).toBe('return { result: "ok" };');
    for (const text of ["", "return {", '{"error":"需要新增输入 value"}']) {
      const bad = fixture(text);
      await expect(
        generateWorkflowScript(
          bad.runtime,
          input,
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "REQUEST_FAILED" });
    }
    f.completeSimple.mockResolvedValue({
      stopReason: "length",
      content: [{ type: "text", text: "return {};" }],
    });
    await expect(
      generateWorkflowScript(f.runtime, input, new AbortController().signal),
    ).rejects.toThrow("截断");
  });
  it("非法请求和不存在模型不调用模型，取消信号传递给运行时", async () => {
    const f = fixture();
    for (const patch of [
      { requirement: "" },
      { inputs: null },
      { outputs: [] },
      { timeoutMs: 0 },
      { script: 9 },
    ]) {
      await expect(
        generateWorkflowScript(
          f.runtime,
          { ...input, ...patch } as WorkflowScriptAssistRequest,
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    }
    expect(f.completeSimple).not.toHaveBeenCalled();
    const controller = new AbortController();
    f.completeSimple.mockImplementation(async () => {
      controller.abort();
      return { stopReason: "aborted", content: [] };
    });
    await expect(
      generateWorkflowScript(f.runtime, input, controller.signal),
    ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
    const missing = { getModel: () => undefined, completeSimple: vi.fn() };
    await expect(
      generateWorkflowScript(
        missing as never,
        input,
        new AbortController().signal,
      ),
    ).rejects.toThrow("所选模型不存在");
    expect(missing.completeSimple).not.toHaveBeenCalled();
  });
});
