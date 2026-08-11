import type { ConversationEntry } from "../../conversation-timeline";

/** 提取快捷复制允许写入剪贴板的消息正文。 */
export function copyTextForEntry(entry: ConversationEntry): string {
  if (entry.type === "user") return entry.text;

  // 工具调用前的解释文本不属于最终答复，仅取最后一个非空 Markdown 段。
  for (let index = entry.blocks.length - 1; index >= 0; index -= 1) {
    const block = entry.blocks[index];
    if (block?.type === "markdown" && block.text.trim()) return block.text;
  }
  return "";
}
