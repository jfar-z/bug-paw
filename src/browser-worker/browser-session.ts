import type { BrowserContext, Download, Locator, Page } from "playwright";

import type { BrowserCommand } from "../shared/browser-worker-protocol";
import {
  assertSafeClick,
  assertSafeSubmit,
  assertSafeTextInput,
  type BrowserElementDescriptor,
} from "./action-safety";

/** Snapshot 中供 Agent 后续操作的稳定元素引用。 */
export interface BrowserSnapshotElement {
  /** 当前 snapshot generation 内的引用。 */
  ref: string;
  /** 可访问角色。 */
  role: string;
  /** 可访问名称。 */
  name: string;
  /** 是否禁用。 */
  disabled: boolean;
}

/** 当前页面的有界可访问快照。 */
export interface BrowserSnapshotResult {
  title: string;
  url: string;
  text: string;
  elements: BrowserSnapshotElement[];
  truncated: boolean;
}

/** Worker 内部二进制产物。 */
export interface BrowserBinaryArtifact {
  content: Buffer;
  mediaType: string;
  suggestedName?: string;
}

interface StoredReference {
  /** 引用所属 generation。 */
  generation: number;
  /** Playwright Locator。 */
  locator: Locator;
  /** 动作安全所需元素语义。 */
  descriptor: BrowserElementDescriptor;
}

/** 单个 Browser Context 内的原子 Playwright 操作。 */
export class BrowserSession {
  /** 当前稳定元素引用。 */
  private readonly references = new Map<string, StoredReference>();
  /** Page 到稳定内部 ID 的映射。 */
  private readonly pageIds = new Map<Page, string>();
  /** 当前 snapshot generation。 */
  private generation = 0;
  /** 当前页面。 */
  private currentPage?: Page;

  /** 创建 Browser Context 会话。 */
  constructor(private readonly context: BrowserContext, private readonly options: { maxPages: number; trustedOrigins: string[] }) {
    context.on("page", (page) => {
      this.assignPageId(page);
      page.on("dialog", (dialog) => { void dialog.dismiss(); });
      if (context.pages().length > options.maxPages) void page.close();
    });
    for (const page of context.pages()) page.on("dialog", (dialog) => { void dialog.dismiss(); });
  }

  /** 执行快照命令。 */
  execute(command: Extract<BrowserCommand, { type: "snapshot" }>): Promise<BrowserSnapshotResult>;
  /** 执行截图或下载命令。 */
  execute(command: Extract<BrowserCommand, { type: "screenshot" | "download" }>): Promise<{ artifact: BrowserBinaryArtifact }>;
  /** 执行其他原子命令。 */
  execute(command: Exclude<BrowserCommand, { type: "snapshot" | "screenshot" | "download" }>): Promise<Record<string, unknown>>;
  /** 根据判别字段调度原子命令。 */
  async execute(command: BrowserCommand): Promise<BrowserSnapshotResult | { artifact: BrowserBinaryArtifact } | Record<string, unknown>> {
    switch (command.type) {
      case "open": return this.open(command);
      case "snapshot": return this.snapshot(command.maxCharacters, command.pageId);
      case "click": return this.click(command.ref, command.pageId);
      case "scroll": return this.scroll(command.direction, command.amount, command.ref, command.pageId);
      case "input": return this.input(command.ref, command.text, command.pageId);
      case "submit": return this.submit(command.ref, command.pageId);
      case "upload": return this.upload(command.ref, command.files.map((file) => file.handle), command.pageId);
      case "screenshot": return this.screenshot(command);
      case "download": return this.download(command);
    }
  }

  /** 关闭整个临时 Context。 */
  async close(): Promise<void> {
    this.references.clear();
    this.pageIds.clear();
    await this.context.close();
  }

  /** 打开 URL 或内部预览 URL。 */
  private async open(command: Extract<BrowserCommand, { type: "open" }>): Promise<Record<string, unknown>> {
    this.assertNavigationUrl(command.target.url);
    let page = this.currentPage;
    if (!page || page.isClosed() || command.newPage) {
      if (this.context.pages().filter((candidate) => !candidate.isClosed()).length >= this.options.maxPages) {
        throw workerError("BROWSER_ARTIFACT_LIMIT_REACHED", "当前 Context 的页面数量已达到上限");
      }
      page = await this.context.newPage();
    }
    this.currentPage = page;
    await page.goto(command.target.url, { waitUntil: "domcontentloaded" });
    this.invalidateReferences();
    return { pageId: this.assignPageId(page), title: await page.title(), url: page.url() };
  }

  /** 创建当前 generation 的可访问元素列表。 */
  private async snapshot(maxCharacters: number, pageId?: string): Promise<BrowserSnapshotResult> {
    const page = this.page(pageId);
    this.generation += 1;
    this.references.clear();
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const truncated = bodyText.length > maxCharacters;
    const candidates = page.locator("a,button,input,textarea,select,[role=button],[role=link],[tabindex]");
    const count = Math.min(await candidates.count(), 500);
    const elements: BrowserSnapshotElement[] = [];
    for (let index = 0; index < count; index += 1) {
      const locator = candidates.nth(index);
      if (!await locator.isVisible().catch(() => false)) continue;
      const descriptor = await describeElement(locator);
      const ref = `g${this.generation}-e${elements.length + 1}`;
      this.references.set(ref, { generation: this.generation, locator, descriptor });
      elements.push({ ref, role: descriptor.role, name: descriptor.accessibleName, disabled: await locator.isDisabled().catch(() => false) });
    }
    return { title: await page.title(), url: page.url(), text: bodyText.slice(0, maxCharacters), elements, truncated };
  }

  /** 点击非提交型元素。 */
  private async click(ref: string, pageId?: string): Promise<Record<string, unknown>> {
    this.page(pageId);
    const stored = this.reference(ref);
    assertSafeClick(stored.descriptor);
    await stored.locator.click();
    this.invalidateReferences();
    return { clicked: true };
  }

  /** 以固定距离滚动页面或元素。 */
  private async scroll(direction: "up" | "down" | "left" | "right", amount: "small" | "medium" | "large", ref?: string, pageId?: string): Promise<Record<string, unknown>> {
    const page = this.page(pageId);
    const distance = { small: 320, medium: 720, large: 1_200 }[amount];
    const x = direction === "left" ? -distance : direction === "right" ? distance : 0;
    const y = direction === "up" ? -distance : direction === "down" ? distance : 0;
    if (ref) await this.reference(ref).locator.evaluate((element, delta) => element.scrollBy(delta.x, delta.y), { x, y });
    else await page.mouse.wheel(x, y);
    return { scrolled: true, x, y };
  }

  /** 向普通文本字段输入。 */
  private async input(ref: string, text: string, pageId?: string): Promise<Record<string, unknown>> {
    this.page(pageId);
    const stored = this.reference(ref);
    assertSafeTextInput(stored.descriptor);
    await stored.locator.fill(text);
    return { input: true };
  }

  /** 提交管理员已授权的普通表单。 */
  private async submit(ref: string, pageId?: string): Promise<Record<string, unknown>> {
    this.page(pageId);
    const stored = this.reference(ref);
    assertSafeSubmit(stored.descriptor);
    await stored.locator.click();
    this.invalidateReferences();
    return { submitted: true };
  }

  /** 上传由主服务复制到 Worker 临时目录的文件。 */
  private async upload(ref: string, files: string[], pageId?: string): Promise<Record<string, unknown>> {
    this.page(pageId);
    await this.reference(ref).locator.setInputFiles(files);
    return { uploadedFiles: files.length };
  }

  /** 截取视口、完整页面或稳定元素。 */
  private async screenshot(command: Extract<BrowserCommand, { type: "screenshot" }>): Promise<{ artifact: BrowserBinaryArtifact }> {
    const page = this.page(command.pageId);
    const options = command.format === "jpeg" ? { type: "jpeg" as const, quality: command.quality ?? 80 } : { type: "png" as const };
    const content = command.mode === "element"
      ? await this.reference(command.ref ?? "").locator.screenshot(options)
      : await page.screenshot({ ...options, fullPage: command.mode === "fullPage" });
    return { artifact: { content, mediaType: command.format === "jpeg" ? "image/jpeg" : "image/png" } };
  }

  /** 从 URL 或元素触发下载并读取临时文件。 */
  private async download(command: Extract<BrowserCommand, { type: "download" }>): Promise<{ artifact: BrowserBinaryArtifact }> {
    const page = this.page(command.pageId);
    if (command.source.kind === "url") this.assertNavigationUrl(command.source.url);
    const downloadPromise = page.waitForEvent("download");
    const action = command.source.kind === "url"
      ? page.goto(command.source.url)
      : this.reference(command.source.ref).locator.click();
    // Chromium 会以 ERR_ABORTED 表示导航已转为下载，实际结果以 download 事件为准。
    const [download] = await Promise.all([downloadPromise, action.catch(() => undefined)]);
    return { artifact: await readDownload(download) };
  }

  /** 解析当前或指定 Page。 */
  private page(pageId?: string): Page {
    if (pageId) {
      const found = [...this.pageIds].find(([, id]) => id === pageId)?.[0];
      if (found && !found.isClosed()) return found;
    }
    if (this.currentPage && !this.currentPage.isClosed()) return this.currentPage;
    throw workerError("BROWSER_CONTEXT_NOT_OPEN", "当前 Browser Context 尚未打开页面");
  }

  /** 读取当前 generation 的引用。 */
  private reference(ref: string): StoredReference {
    const stored = this.references.get(ref);
    if (!stored || stored.generation !== this.generation) throw workerError("BROWSER_ELEMENT_REFERENCE_STALE", "元素引用已经失效，请重新获取页面快照");
    return stored;
  }

  /** 为 Page 分配稳定内部 ID。 */
  private assignPageId(page: Page): string {
    const existing = this.pageIds.get(page);
    if (existing) return existing;
    const id = `page-${this.pageIds.size + 1}`;
    this.pageIds.set(page, id);
    return id;
  }

  /** 使导航或 DOM 操作前的引用失效。 */
  private invalidateReferences(): void {
    this.generation += 1;
    this.references.clear();
  }

  /** 在请求到达代理前拒绝公开 HTTP 与非 Web 协议，避免代理 403 被导航当作成功页面。 */
  private assertNavigationUrl(value: string): void {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw workerError("BROWSER_TARGET_BLOCKED", "浏览器目标 URL 无效");
    }
    if (url.protocol === "https:") return;
    if (url.protocol === "http:" && this.options.trustedOrigins.includes(url.origin)) return;
    throw workerError("BROWSER_TARGET_BLOCKED", "公开浏览只允许 HTTPS；本地 HTTP 需要管理员配置为受信任 Origin");
  }
}

/** 从元素属性生成动作安全描述。 */
async function describeElement(locator: Locator): Promise<BrowserElementDescriptor> {
  const tagName = await locator.evaluate((element) => element.tagName.toLowerCase());
  const type = await locator.getAttribute("type") ?? "";
  const autocomplete = await locator.getAttribute("autocomplete") ?? "";
  const role = await locator.getAttribute("role") ?? defaultRole(tagName, type);
  const accessibleName = (await locator.getAttribute("aria-label"))
    ?? (await locator.getAttribute("placeholder"))
    ?? (await locator.textContent())?.trim()
    ?? "";
  return { tagName, type, autocomplete, role, accessibleName };
}

/** 提供元素的保守默认角色。 */
function defaultRole(tagName: string, type: string): string {
  if (tagName === "a") return "link";
  if (tagName === "button" || type === "button" || type === "submit") return "button";
  if (tagName === "select") return "combobox";
  return "textbox";
}

/** 读取 Playwright 下载临时文件。 */
async function readDownload(download: Download): Promise<BrowserBinaryArtifact> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const value of stream) chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value));
  return { content: Buffer.concat(chunks), mediaType: "application/octet-stream", suggestedName: download.suggestedFilename() };
}

/** 创建带稳定 code 的 Worker 错误。 */
function workerError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
