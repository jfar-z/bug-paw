import type { WorkspaceEntry } from "../../shared/contracts";
import { api, aigcPublicFileUrl } from "../api";
import { WorkspaceBrowser, type WorkspaceBrowserDataSource } from "../components/workspace-browser";
import "../resources.css";

const publicDirectorySource: WorkspaceBrowserDataSource = {
  key: "aigc-public-directory",
  rootLabel: "公开目录",
  searchPlaceholder: "搜索公开目录中的文件",
  showHiddenToggle: false,
  listEntries: (directory) => api.listAigcPublicDirectoryEntries(directory),
  searchEntries: (query) => api.searchAigcPublicDirectoryEntries(query),
  getText: (path) => api.getAigcPublicDirectoryText(path),
  uploadFiles: (directory, files) => api.uploadAigcPublicDirectoryFiles(directory, files),
  createDirectory: (directory, name) => api.createAigcPublicDirectory(directory, name),
  updateEntry: (body) => api.updateAigcPublicDirectoryEntry(body),
  deleteEntries: (paths) => api.deleteAigcPublicDirectoryEntries(paths),
  fileUrl: (entry: WorkspaceEntry, download: boolean) => {
    const url = "url" in entry && typeof entry.url === "string" ? entry.url : "";
    return aigcPublicFileUrl(url, download);
  },
};

/** 管理可通过稳定链接直接访问的 AIGC 公共文件。 */
export function AigcPublicDirectoryPage() {
  const heading = <header className="workspace-resources-page__heading"><div>
    <span>AIGC WORKBENCH</span>
    <h1>公开目录</h1>
    <p>管理可通过公开链接访问的文件。移动或重命名文件不会改变已有链接。</p>
  </div></header>;

  return <div className="workspace-resources-page aigc-public-directory-page">
    <WorkspaceBrowser agentId="" mode="page" heading={heading} dataSource={publicDirectorySource} />
  </div>;
}
