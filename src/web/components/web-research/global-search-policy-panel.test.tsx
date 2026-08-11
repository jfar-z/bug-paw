import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_WEB_RESEARCH_CONFIG, type WebResearchGlobalConfig } from "../../../shared/web-research-contracts";
import { GlobalSearchPolicyPanel } from "./global-search-policy-panel";

const { searchProviders: _providers, ...globalConfig } = DEFAULT_WEB_RESEARCH_CONFIG;

describe("GlobalSearchPolicyPanel", () => {
  it("默认折叠并展示全渠道策略摘要", () => {
    render(<GlobalSearchPolicyPanel value={globalConfig} egressProfiles={[]} onChange={vi.fn()} />);

    expect(screen.getByText("最多 5 条结果")).toBeInTheDocument();
    expect(screen.getByText("页面读取 10 秒")).toBeInTheDocument();
    expect(screen.getByText("仅 HTTPS")).toBeInTheDocument();
    expect(screen.queryByLabelText("正文最大字符数")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "展开全局检索策略" }));
    expect(screen.getByText("应用于所有搜索渠道及页面读取")).toBeInTheDocument();
    expect(screen.getByLabelText("正文最大字符数")).toHaveValue(20_000);
  });

  it("至少保留一种允许的内容类型并在面板内显示错误", () => {
    function Harness() {
      const [value, setValue] = useState<WebResearchGlobalConfig>({ ...globalConfig, allowedContentTypes: ["text/html"] });
      return <GlobalSearchPolicyPanel value={value} egressProfiles={[]} error="全局策略保存失败" onChange={setValue} />;
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "展开全局检索策略" }));

    fireEvent.click(screen.getByRole("checkbox", { name: "允许 HTML 正文" }));
    expect(screen.getByRole("checkbox", { name: "允许 HTML 正文" })).toBeChecked();
    expect(screen.getByRole("alert")).toHaveTextContent("全局策略保存失败");
  });
});
