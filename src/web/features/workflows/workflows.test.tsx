import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseRoute, routePath } from "../../router";
import { WorkbenchShell } from "../../layouts/workbench-shell";
import { WorkflowValue, WorkflowJson } from "./workflow-fields";
import { withWorkflowNode } from "./workflow-canvas";
import {
  emptyWorkflow,
  newWorkflowNode,
} from "../../../shared/workflow-contracts";
/** 导航与参数类型都是用户能观察到的契约，图形库实现本身不复制测试。 */
describe("工作流浏览器契约", () => {
  it("独立路由可恢复编辑和运行任务，保留 ComfyUI 旧路由", () => {
    const routes = [
      { page: "workflows" },
      { page: "workflow-editor", workflowId: "abc" },
      { page: "workflow-run", workflowId: "abc", runId: "run" },
      { page: "workflow-history" },
    ] as const;
    for (const route of routes) {
      const url = new URL(routePath(route), "http://localhost");
      expect(parseRoute(url.pathname, url.search)).toEqual(route);
    }
    expect(parseRoute("/aigc/workflows")).toEqual({ page: "aigc-workflows" });
  });
  it("一级和二级菜单复用导航样式，移动端可以打开工作流导航", () => {
    const go = vi.fn();
    render(
      <WorkbenchShell
        route={{ page: "workflow-run" }}
        theme="light"
        onThemeChange={() => {}}
        onNavigate={go}
        onLogout={() => {}}
      >
        <div>页面内容</div>
      </WorkbenchShell>,
    );
    expect(screen.getByRole("button", { name: "工作流" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: "运行工作流" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    fireEvent.click(screen.getByRole("button", { name: "运行记录" }));
    expect(go).toHaveBeenCalledWith({ page: "workflow-history" });
    fireEvent.click(screen.getByRole("button", { name: "打开工作流导航" }));
    expect(
      screen.getAllByRole("button", { name: "关闭工作流导航" })[0],
    ).toHaveAttribute("aria-expanded", "true");
  });
  it("引用自动连线且阻止环路，不旁路覆盖已有分支", () => {
    const d = emptyWorkflow(),
      n = newWorkflowNode("javascript", "js");
    d.nodes.push(n);
    n.inputs.value = { kind: "reference", nodeId: "input", field: "prompt" };
    const next = withWorkflowNode(d, n);
    expect(
      next.edges.some((e) => e.source === "input" && e.target === "js"),
    ).toBe(true);
    const input = {
      ...next.nodes[0],
      inputs: {
        value: { kind: "reference" as const, nodeId: "js", field: "result" },
      },
    };
    expect(() => withWorkflowNode(next, input)).toThrow("循环");
  });
  it("数值保持 0、布尔保持 false，非法 JSON 不能确认", () => {
    const change = vi.fn(),
      valid = vi.fn();
    const { rerender } = render(
      <WorkflowValue
        field={{ name: "number", type: "integer" }}
        value={1}
        onChange={change}
      />,
    );
    fireEvent.change(screen.getByRole("spinbutton"), {
      target: { value: "0" },
    });
    expect(change).toHaveBeenLastCalledWith(0);
    rerender(
      <WorkflowValue
        field={{ name: "enabled", type: "boolean" }}
        value={true}
        onChange={change}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox"));
    expect(change).toHaveBeenLastCalledWith(false);
    rerender(<WorkflowJson value={{}} onChange={change} onValidity={valid} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "{" } });
    expect(valid).toHaveBeenLastCalledWith(false);
    expect(screen.getByText("请输入有效 JSON。")).toBeVisible();
  });
});
