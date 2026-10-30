import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowFilesPage } from "./workflow-files-page";
import { api, ApiClientError } from "../api";
import { ApiTaskProvider } from "../api-task-provider";
import { ErrorToastProvider } from "../error-toast-provider";
import { parseRoute, routePath } from "../router";
import { WorkflowSidebar } from "../layouts/workflow-sidebar";
import type { WorkflowFilePage } from "../../shared/workflow-contracts";

afterEach(() => vi.restoreAllMocks());
const file = {assetId:"runtime",name:"output.txt",mediaType:"text/plain",size:20,directory:"runtime" as const,createdAt:"2026-10-30T00:00:00Z",usages:[]};
const page: WorkflowFilePage = {files:[file,{...file,assetId:"constant",name:"constant.txt",directory:"constants",blockedReason:"仍被工作流或运行快照引用"}],total:2,page:1,workflows:[]};
/** 使用统一任务提供器验证危险操作的保护与错误可见性。 */
function mount() {return render(<ErrorToastProvider><ApiTaskProvider onAuthenticationRequired={() => {}}><WorkflowFilesPage/></ApiTaskProvider></ErrorToastProvider>);}
it("仅选择可删除文件，删除前确认，成功后刷新并保留受保护文件", async () => {
  const list = vi.spyOn(api,"listWorkflowFiles").mockResolvedValue(page);
  const remove = vi.spyOn(api,"deleteWorkflowFiles").mockResolvedValue(undefined);
  mount();await screen.findByText("output.txt");
  expect(screen.getByLabelText("选择 constant.txt")).toBeDisabled();
  fireEvent.click(screen.getByLabelText("选择本页可删除文件"));
  fireEvent.click(screen.getByRole("button",{name:"删除所选 1 项"}));
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:"确认删除"}));
  await waitFor(() => expect(remove).toHaveBeenCalledWith(["runtime"]));
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
});
it("删除期间新产生引用时显示服务端原因与请求标识，重新加载保护状态", async () => {
  const list = vi.spyOn(api,"listWorkflowFiles").mockResolvedValue(page);
  vi.spyOn(api,"deleteWorkflowFiles").mockRejectedValue(new ApiClientError("CONFLICT","文件 output.txt 仍被工作流引用，不能删除",409,"file-in-use"));
  mount();await screen.findByText("output.txt");fireEvent.click(screen.getByLabelText("选择 output.txt"));fireEvent.click(screen.getByRole("button",{name:"删除所选 1 项"}));
  list.mockResolvedValue({...page,files:page.files.map(item => ({...item,blockedReason:"仍被工作流引用"}))});
  fireEvent.click(screen.getByRole("button",{name:"确认删除"}));
  await screen.findAllByText(/文件 output.txt 仍被工作流引用，不能删除/);
  await waitFor(() => expect(screen.getByLabelText("选择 output.txt")).toBeDisabled());
  fireEvent.click(screen.getByRole("button", {name:"查看错误详情"}));
  expect(await screen.findByText("file-in-use")).toBeInTheDocument();
});
it("独立常量目录、筛选与文本预览使用工作流接口", async () => {
  const list = vi.spyOn(api,"listWorkflowFiles").mockResolvedValue(page);
  vi.spyOn(api,"getWorkflowFileText").mockResolvedValue({path:"runtime",content:"文本内容",truncated:false});
  mount();await screen.findByText("output.txt");
  fireEvent.click(screen.getByRole("button",{name:"文件常量"}));
  await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({directory:"constants",page:"1"})));
  expect(screen.getByLabelText("上传文件常量")).toBeInTheDocument();
  fireEvent.click(await screen.findByRole("button",{name:"预览 output.txt"}));
  expect(await screen.findByText("文本内容")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("筛选文件类型"),{target:{value:"image"}});
  await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({directory:"constants",type:"image"})));
});
it("文件页深链及二级导航保留工作流选中态并关闭移动菜单", () => {
  expect(parseRoute("/workflows/files")).toEqual({page:"workflow-files"});expect(routePath({page:"workflow-files"})).toBe("/workflows/files");
  const navigate = vi.fn(), close = vi.fn();render(<WorkflowSidebar route={{page:"workflow-files"}} open onClose={close} onNavigate={navigate}/>);
  const button = screen.getByRole("button",{name:"工作流文件管理"});expect(button).toHaveAttribute("aria-current","page");fireEvent.click(button);expect(navigate).toHaveBeenCalledWith({page:"workflow-files"});expect(close).toHaveBeenCalled();
});
