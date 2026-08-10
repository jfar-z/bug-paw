import { describe, expect, it } from "vitest";
import { compileAgentReferences } from "./agent-references";

describe("Agent 引用协议", () => {
  it("只编译已验证的三类引用，并转义 XML 属性", () => {
    expect(compileAgentReferences([
      { type: "skill", name: "release-notes" },
      { type: "knowledge", id: "kb-1", name: "产品 <资料>" },
      { type: "file", path: "docs/spec.md", kind: "file", name: "spec.md" },
    ])).toBe(
      '<agent_references version="1" type="skill" name="release-notes"/>\n'
      + '<agent_references version="1" type="knowledge" id="kb-1" name="产品 &lt;资料&gt;"/>\n'
      + '<agent_references version="1" type="file" path="docs/spec.md" kind="file"/>',
    );
  });
});
