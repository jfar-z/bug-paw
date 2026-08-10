import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentReferenceChips } from "./agent-reference-chips";

describe("AgentReferenceChips", () => {
  it("按引用类型展示具有独立语义的标签", () => {
    render(<AgentReferenceChips references={[
      { type: "skill", name: "release-notes" },
      { type: "knowledge", id: "kb-1", name: "产品资料" },
      { type: "file", path: "docs", kind: "directory", name: "docs" },
    ]} />);

    expect(screen.getByLabelText("技能：release-notes")).toBeInTheDocument();
    expect(screen.getByLabelText("知识库：产品资料")).toBeInTheDocument();
    expect(screen.getByLabelText("目录：docs")).toBeInTheDocument();
  });
});
