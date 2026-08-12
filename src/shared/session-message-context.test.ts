import { describe, expect, it } from "vitest";
import { parseSessionReplayContent } from "./session-message-context";

describe("parseSessionReplayContent", () => {
  it("拆解历史 prompt 时移除协议且去重附件", () => {
    expect(parseSessionReplayContent(
      "分析\n<agent_references version=\"1\" type=\"file\" path=\"attachments/a.png\" kind=\"file\"/>\n<pi_agent_files version=\"1\">\n{\"files\":[{\"path\":\"attachments/a.png\"},{\"path\":\"attachments/b.pdf\"}]}\n</pi_agent_files>",
    )).toMatchObject({
      text: "分析",
      filePaths: ["attachments/a.png", "attachments/b.pdf"],
      references: [{ type: "file", path: "attachments/a.png" }],
    });
  });
});
