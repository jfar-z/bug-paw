import { describe, expect, it } from "vitest";
import type { AgentTurn } from "./conversation-timeline";
import { agentTurnSpeechText, prepareSpeechSegments, sanitizeMarkdownForSpeech } from "./speech-text";

describe("sanitizeMarkdownForSpeech", () => {
  it("跳过围栏代码、GFM 表格和数学公式并保留前后正文", () => {
    const markdown = [
      "# 结果",
      "先说明一句。",
      "```ts",
      'console.log("不能朗读");',
      "```",
      "| 名称 | 状态 |",
      "| --- | --- |",
      "| 播放 | 正常 |",
      "行内公式 $E=mc^2$ 不朗读公式。",
      "$$",
      String.raw`\int_0^1 x^2 dx`,
      "$$",
      "最后一句。",
    ].join("\n");

    expect(sanitizeMarkdownForSpeech(markdown)).toBe([
      "结果",
      "先说明一句。",
      "行内公式 不朗读公式。",
      "最后一句。",
    ].join("\n"));
  });

  it("隐藏未闭合的反引号、波浪线代码围栏和块级公式", () => {
    expect(sanitizeMarkdownForSpeech("可见正文。\n```js\nsecret()"))
      .toBe("可见正文。");
    expect(sanitizeMarkdownForSpeech("可见正文。\n~~~js\nsecret()"))
      .toBe("可见正文。");
    expect(sanitizeMarkdownForSpeech(String.raw`可见正文。
\[
secret`)).toBe("可见正文。");
  });

  it("删除四种公式定界符且保留没有闭合符号的货币文本", () => {
    const markdown = String.raw`价格是 $5，公式 \(a+b\) 和 $c+d$ 不朗读。

$$x+y$$

\[z+w\]`;

    expect(sanitizeMarkdownForSpeech(markdown)).toBe("价格是 $5，公式 和 不朗读。");
  });

  it("移除潜在表格行并保留表格前后普通段落", () => {
    const markdown = [
      "表格之前。",
      "名称 | 状态",
      "--- | ---",
      "流式播放 | 已开启",
      "表格之后。",
    ].join("\n");

    expect(sanitizeMarkdownForSpeech(markdown)).toBe("表格之前。\n表格之后。");
  });

  it("保留普通 Markdown 的可见文字并删除链接和图片目标", () => {
    const markdown = [
      "## **标题**",
      "- [说明](https://example.test/path)",
      "> 行内 `value` 和 *强调*。",
      "![架构图](https://example.test/image.png)",
    ].join("\n");

    expect(sanitizeMarkdownForSpeech(markdown)).toBe([
      "标题",
      "说明",
      "行内 value 和 强调。",
    ].join("\n"));
  });
});

describe("prepareSpeechSegments", () => {
  it("流式阶段不输出不稳定短尾，完成时补齐", () => {
    expect(prepareSpeechSegments("第一句。尚未结束", false)).toEqual([]);
    expect(prepareSpeechSegments("第一句。尚未结束", true)).toEqual(["第一句。尚未结束"]);
  });

  it("按稳定自然句生成确定片段", () => {
    const first = `${"甲".repeat(48)}。`;
    const second = `${"乙".repeat(48)}！`;
    const third = `${"丙".repeat(48)}？`;

    expect(prepareSpeechSegments(`${first}${second}${third}`, false)).toEqual([first, second, third]);
  });

  it("合并相邻短句且不把重复句误判为已处理", () => {
    const text = "收到。收到。接下来继续说明具体内容。";

    expect(prepareSpeechSegments(text, true)).toEqual([text]);
  });

  it("连续中文标点和结束引号属于前一句", () => {
    const text = "他说“真的吗？！”然后继续解释。";

    expect(prepareSpeechSegments(text, true).join("")).toBe(text);
  });

  it("只含装饰符号的内容没有可朗读片段", () => {
    expect(prepareSpeechSegments("❤️ ✅ ？！", true)).toEqual([]);
  });
});

describe("agentTurnSpeechText", () => {
  it("只收集 Agent turn 的 Markdown 正文", () => {
    const turn: AgentTurn = {
      id: "agent-1",
      type: "agent",
      blocks: [
        { id: "text-1", type: "markdown", text: "正文一。", streaming: false },
        { id: "thinking-1", type: "thinking", text: "思考内容", streaming: false },
        { id: "text-2", type: "markdown", text: "正文二。", streaming: false },
      ],
    };

    expect(agentTurnSpeechText(turn)).toBe("正文一。\n正文二。");
  });
});
