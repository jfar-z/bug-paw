import {
  Bot,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Code2,
  Download,
  FileAudio2,
  FileVideo2,
  ImageIcon,
  LoaderCircle,
  Menu,
  MessageSquare,
  MessageSquarePlus,
  MoreHorizontal,
  Paperclip,
  Play,
  Search,
  Send,
  Settings2,
  TerminalSquare,
  Volume2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { MessageNavigator, type MessageNavigationEntry } from "../components/message-navigator";
import { ProductMark } from "../components/product-mark";
import type { ThemePreference } from "../theme";
import { LiveChatPage } from "./live-chat-page";

interface ChatPageProps {
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  userIdentity?: IdentityPreview;
  agentIdentity?: IdentityPreview;
  live?: boolean;
}

export interface IdentityPreview {
  displayName: string;
  avatarText: string;
  avatar?: { kind: "image"; revision: string };
}

const previewSessions = ["梳理项目架构", "检查容器部署", "pi SDK 接入思路"];
const defaultUserIdentity: IdentityPreview = { displayName: "管理员", avatarText: "A" };
const defaultAgentIdentity: IdentityPreview = { displayName: "默认 Agent", avatarText: "π" };

export function ChatPage({
  theme,
  userIdentity = defaultUserIdentity,
  agentIdentity = defaultAgentIdentity,
  live = false,
}: ChatPageProps) {
  if (live) {
    return <LiveChatPage theme={theme} userIdentity={userIdentity} />;
  }

  return <PreviewChatPage userIdentity={userIdentity} agentIdentity={agentIdentity} />;
}

/**
 * 保留已通过视觉验收的富媒体与工具流展示稿。
 */
function PreviewChatPage({
  userIdentity = defaultUserIdentity,
  agentIdentity = defaultAgentIdentity,
}: Pick<ChatPageProps, "userIdentity" | "agentIdentity">) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [toolOpen, setToolOpen] = useState(true);
  const [isRunning, setIsRunning] = useState(false);
  const messageScrollRef = useRef<HTMLDivElement>(null);
  const firstPromptRef = useRef<HTMLElement>(null);
  const secondPromptRef = useRef<HTMLElement>(null);
  const navigationItems = useMemo<MessageNavigationEntry[]>(
    () => [
      {
        id: "prompt-workspace",
        summary: "检查当前工作目录，并说明你准备如何开始。",
        targetRef: firstPromptRef,
      },
      {
        id: "prompt-media",
        summary: "继续检查媒体与产物展示。",
        targetRef: secondPromptRef,
      },
    ],
    [],
  );

  useEffect(() => {
    const portraitQuery = window.matchMedia?.("(orientation: portrait)");
    if (!portraitQuery) {
      return;
    }

    /**
     * 进入竖屏时释放消息宽度，之后仍允许用户手动打开抽屉。
     */
    const closeSidebarInPortrait = (event: MediaQueryListEvent | MediaQueryList) => {
      if (event.matches) {
        setSidebarOpen(false);
      }
    };

    closeSidebarInPortrait(portraitQuery);
    portraitQuery.addEventListener("change", closeSidebarInPortrait);
    return () => {
      portraitQuery.removeEventListener("change", closeSidebarInPortrait);
    };
  }, []);

  return (
    <main className="chat-shell">
      {sidebarOpen && (
        <button
          type="button"
          className="sidebar-scrim"
          aria-label="关闭会话侧栏"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside className={sidebarOpen ? "chat-sidebar is-open" : "chat-sidebar"}>
        <div className="sidebar-header">
          <ProductMark />
          <button type="button" className="icon-button desktop-collapse" aria-label="收起侧栏">
            <Menu size={18} aria-hidden="true" />
          </button>
        </div>

        <button type="button" className="new-chat-button">
          <MessageSquarePlus size={18} aria-hidden="true" />
          <span>新对话</span>
          <kbd>⌘ K</kbd>
        </button>

        <button type="button" className="sidebar-search">
          <Search size={17} aria-hidden="true" />
          搜索会话
        </button>

        <nav className="session-nav" aria-label="会话历史">
          <p>最近</p>
          {previewSessions.map((session, index) => (
            <button type="button" className={index === 0 ? "is-active" : undefined} key={session}>
              <MessageSquare size={16} aria-hidden="true" />
              <span>{session}</span>
              {index === 0 && <MoreHorizontal size={16} aria-hidden="true" />}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <button type="button" className="account-button">
            <span className="avatar">{userIdentity.avatarText}</span>
            <span>
              <strong>{userIdentity.displayName}</strong>
              <small>本地工作区</small>
            </span>
            <Settings2 size={17} aria-hidden="true" />
          </button>
        </div>
      </aside>

      <section className="chat-workspace">
        <header className="chat-header">
          <div className="chat-header__left">
            <button
              type="button"
              className="icon-button mobile-menu"
              aria-label="打开会话侧栏"
              onClick={() => setSidebarOpen(true)}
            >
              <Menu size={19} aria-hidden="true" />
            </button>
            <div className="chat-title">
              <strong>梳理项目架构</strong>
              <span>界面预览 · 尚未连接运行时</span>
            </div>
          </div>

          <div className="chat-header__actions">
            <button type="button" className="model-selector">
              <Bot size={17} aria-hidden="true" />
              <span>{agentIdentity.displayName}</span>
              <small>未配置模型</small>
              <ChevronDown size={16} aria-hidden="true" />
            </button>
          </div>
        </header>

        <MessageNavigator items={navigationItems} scrollContainerRef={messageScrollRef} />

        <div className="message-scroll" ref={messageScrollRef}>
          <div className="message-column">
            <div className="session-intro">
              <span className="agent-orbit" aria-hidden="true">
                <Bot size={25} />
              </span>
              <h1>从这里开始协作。</h1>
              <p>当前是第一版界面预览。连接 pi SDK 后，这里会实时显示回答、思考过程和工具执行状态。</p>
            </div>

            <article id="prompt-workspace" ref={firstPromptRef} className="message-row is-user">
              <div className="message-meta">
                <time>预览内容</time>
                <strong>{userIdentity.displayName}</strong>
                <span className="message-avatar is-user-avatar" aria-label={`${userIdentity.displayName}头像`}>
                  {userIdentity.avatarText}
                </span>
              </div>
              <div className="message-content">
                <p>检查当前工作目录，并说明你准备如何开始。</p>

                <div className="user-media-grid">
                  <figure className="media-card" aria-label="用户上传的图片附件">
                    <div className="media-preview is-image-preview">
                      <ImageIcon size={24} aria-hidden="true" />
                      <span>IMAGE PREVIEW</span>
                    </div>
                    <figcaption>
                      <span>
                        <strong>界面参考.webp</strong>
                        <small>图片 · 预览占位</small>
                      </span>
                      <button type="button" aria-label="下载用户附件">
                        <Download size={16} aria-hidden="true" />
                      </button>
                    </figcaption>
                  </figure>

                  <figure className="media-card" aria-label="用户上传的视频附件">
                    <div className="media-preview is-video-preview">
                      <button type="button" aria-label="播放用户视频附件">
                        <Play size={20} fill="currentColor" aria-hidden="true" />
                      </button>
                      <span>VIDEO · 00:18</span>
                    </div>
                    <figcaption>
                      <span>
                        <strong>交互录屏.mp4</strong>
                        <small>视频 · 预览占位</small>
                      </span>
                      <button type="button" aria-label="下载视频附件">
                        <Download size={16} aria-hidden="true" />
                      </button>
                    </figcaption>
                  </figure>
                </div>

                <div className="audio-attachment" aria-label="用户上传的音频附件">
                  <button type="button" className="media-play-button" aria-label="播放用户音频附件">
                    <Play size={16} fill="currentColor" aria-hidden="true" />
                  </button>
                  <FileAudio2 size={18} aria-hidden="true" />
                  <span className="audio-attachment__name">
                    <strong>语音说明.m4a</strong>
                    <small>音频 · --:--</small>
                  </span>
                  <span className="audio-track" aria-hidden="true">
                    <i />
                  </span>
                  <button type="button" className="media-download-button" aria-label="下载音频附件">
                    <Download size={16} aria-hidden="true" />
                  </button>
                </div>
              </div>
            </article>

            <article className="message-row is-assistant">
              <div className="message-meta">
                <span className="message-avatar is-agent-avatar" aria-label={`${agentIdentity.displayName}头像`}>
                  {agentIdentity.avatarText}
                </span>
                <strong>{agentIdentity.displayName}</strong>
                <span className="preview-label">界面预览</span>
              </div>
              <div className="message-content">
                <p>我会先读取项目结构和约束，再确认需要修改的边界。随后给出可验证的实现，并在完成前运行对应检查。</p>

                <button type="button" className="tool-call" onClick={() => setToolOpen((open) => !open)}>
                  {toolOpen ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
                  <TerminalSquare size={17} aria-hidden="true" />
                  <span>
                    <strong>bash</strong>
                    <small>查看工作目录</small>
                  </span>
                  <span className="tool-status">已完成</span>
                </button>

                {toolOpen && (
                  <pre className="tool-output" aria-label="工具输出预览">
                    <code>docs/{"\n"}upstream/pi-mono/{"\n"}AGENTS.md</code>
                  </pre>
                )}

                <p>目录目前包含项目目标、调研文档和只读的 pi-mono 上游源码。下一步可以建立自有服务骨架。</p>

                <section className="artifact-panel" aria-labelledby="artifact-title">
                  <div className="artifact-panel__heading">
                    <span>
                      <strong id="artifact-title">Agent 产物</strong>
                      <small>可预览并保存到本地</small>
                    </span>
                    <span className="preview-label">预览</span>
                  </div>

                  <div className="agent-artifact" aria-label="Agent 生成的图片产物">
                    <div className="agent-artifact__preview">
                      <ImageIcon size={26} aria-hidden="true" />
                      <span>GENERATED IMAGE</span>
                    </div>
                    <div className="agent-artifact__meta">
                      <span>
                        <strong>架构概览.png</strong>
                        <small>PNG · 产物预览占位</small>
                      </span>
                      <button type="button" aria-label="下载 Agent 产物">
                        <Download size={17} aria-hidden="true" />
                        下载
                      </button>
                    </div>
                  </div>

                  <div className="artifact-file-row">
                    <span className="artifact-file-row__icon">
                      <FileVideo2 size={18} aria-hidden="true" />
                    </span>
                    <span>
                      <strong>操作演示.webm</strong>
                      <small>视频 · 支持在线播放</small>
                    </span>
                    <button type="button" aria-label="下载 Agent 视频产物">
                      <Download size={16} aria-hidden="true" />
                    </button>
                  </div>
                </section>

                <div className="message-actions" aria-label="Agent 消息操作">
                  <button type="button" disabled aria-label="朗读 Agent 消息（后续支持）" title="TTS 后续支持">
                    <Volume2 size={15} aria-hidden="true" />
                    朗读
                  </button>
                </div>
              </div>
            </article>

            <article id="prompt-media" ref={secondPromptRef} className="message-row is-user">
              <div className="message-meta">
                <time>预览内容</time>
                <strong>{userIdentity.displayName}</strong>
                <span
                  className="message-avatar is-user-avatar"
                  aria-label={`${userIdentity.displayName}头像（第二条消息）`}
                >
                  {userIdentity.avatarText}
                </span>
              </div>
              <div className="message-content">
                <p>继续检查媒体与产物展示，并实时告诉我工具执行到哪里。</p>
              </div>
            </article>

            <article className="message-row is-assistant is-streaming-message">
              <div className="message-meta">
                <span className="message-avatar is-agent-avatar" aria-label={`${agentIdentity.displayName}头像（流式消息）`}>
                  {agentIdentity.avatarText}
                </span>
                <strong>{agentIdentity.displayName}</strong>
                <span className="streaming-label">
                  <i aria-hidden="true" /> 正在工作
                </span>
              </div>
              <div className="message-content">
                <p>正在读取文件并持续返回工具输出，你可以在任务执行期间查看最新进度。</p>
                <div className="streaming-tool" aria-label="工具正在流式执行">
                  <button type="button" className="tool-call is-streaming" onClick={() => setToolOpen((open) => !open)}>
                    {toolOpen ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
                    <LoaderCircle className="spinner" size={17} aria-hidden="true" />
                    <span>
                      <strong>bash</strong>
                      <small>扫描媒体与产物目录</small>
                    </span>
                    <span className="tool-status is-running">流式执行中</span>
                  </button>
                  {toolOpen && (
                    <pre className="tool-output is-live" aria-live="polite">
                      <code>
                        读取 src/web/pages/chat-page.tsx{"\n"}
                        检查媒体展示组件{"\n"}
                        <span>等待下一段输出</span>
                      </code>
                    </pre>
                  )}
                </div>
              </div>
            </article>
          </div>
        </div>

        <footer className="composer-dock">
          <div className="composer">
            <textarea rows={1} placeholder="给 Agent 发消息…" aria-label="消息内容" />
            <div className="composer-actions">
              <div>
                <button type="button" className="icon-button" aria-label="添加附件" disabled>
                  <Paperclip size={18} aria-hidden="true" />
                </button>
                <button type="button" className="tool-mode-button">
                  <Code2 size={16} aria-hidden="true" />
                  工具已启用
                </button>
              </div>
              <button
                type="button"
                className={isRunning ? "send-button is-running" : "send-button"}
                aria-label={isRunning ? "停止生成" : "发送消息"}
                onClick={() => setIsRunning((running) => !running)}
              >
                {isRunning ? <CircleStop size={18} aria-hidden="true" /> : <Send size={18} aria-hidden="true" />}
              </button>
            </div>
          </div>
          <p>Agent 可以在容器权限范围内读取、修改文件和执行命令。</p>
        </footer>
      </section>
    </main>
  );
}
