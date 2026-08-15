import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentInstructions } from "../../shared/agent-contracts";

/** Agent 可持久化编辑的提示词文件标识。 */
export type AgentPromptFile = "role" | "behavior" | "rules" | "user" | "bootsharp";

/** 提示词标识与 Agent 配置目录内固定文件名的映射。 */
export const AGENT_PROMPT_FILES: Record<AgentPromptFile, string> = {
  role: "ROLE.md",
  behavior: "BEHAVIOR.md",
  rules: "RULES.md",
  user: "USER.md",
  bootsharp: "BOOTSHARP.md",
};

/** 当前 Agent 每轮系统提示词所需的五文件权威快照。 */
export interface AgentPromptContextSnapshot {
  /** 五个提示词文件所在目录。 */
  directory: string;
  /** 五个提示词文件的精确绝对路径。 */
  paths: Record<AgentPromptFile, string>;
  /** 四个长期提示词文件的当前内容。 */
  instructions: AgentInstructions;
  /** 仅在首次协作阶段生效的初始化引导。 */
  bootsharp: string;
}

/** 新建 Agent 使用的首次协作引导。 */
export const DEFAULT_BOOTSHARP = `### 初始化协作设定

你正处于与用户的首次协作设定阶段。在用户明确指定你应如何称呼自己之前，请自称“BUG”。

以自然对话的方式，与用户共同建立以下长期设定；不要一次性抛出冗长问卷，应结合用户当前目标逐步确认：

1. 用户希望如何称呼你。
2. 你的角色、职责、能力边界与不负责的事项。
3. 你的行为风格，包括沟通语气、协作方式和执行偏好。
4. 你应如何称呼用户。
5. 你应长期了解的用户信息，例如背景、偏好、工作上下文、语言和交付习惯。

每当用户确认一项内容后，使用系统提示词列出的精确路径更新你自己的 \`ROLE.md\`、\`BEHAVIOR.md\`、\`RULES.md\` 或 \`USER.md\`。更新前先使用 \`read\` 获取最新内容；空文件或需要完整替换时使用 \`write\`，精确局部修改时使用 \`edit\`。编辑自己的五个提示词文件时，如需使用 Markdown 标题，只能使用三级标题（\`###\`）或更低级标题；不得使用一级或二级标题（\`#\`、\`##\`）。只保存已确认的信息；不得猜测、编造或覆盖未被用户要求修改的内容。

“规则”可按需要补充，但不是结束初始化的前提。当你自行判断“角色与职责”“行为风格”“用户”三项已足以支持稳定协作时，使用 \`write\` 将你自己的 \`BOOTSHARP.md\` 写为空字符串。清空后，后续会话不再执行此初始化引导。

你只能编辑自己的五段提示词，不能修改其他 Agent 的文件。
`;

/** 管理 Agent 配置目录内五个固定提示词文件。 */
export class AgentPromptStore {
  constructor(private readonly agentsDir: string) {}

  /** 读取一个提示词文件；存量 Agent 缺失文件时保持只读并返回空内容。 */
  async read(agentId: string, file: AgentPromptFile): Promise<string> {
    try {
      return await readFile(this.pathFor(agentId, file), "utf8");
    } catch (error) {
      if (isMissingFile(error)) return "";
      throw error;
    }
  }

  /** 聚合四个长期提示词，不包含仅用于初始化的 BOOTSHARP。 */
  async readLongTermInstructions(agentId: string): Promise<AgentInstructions> {
    const [role, behavior, rules, user] = await Promise.all([
      this.read(agentId, "role"), this.read(agentId, "behavior"), this.read(agentId, "rules"), this.read(agentId, "user"),
    ]);
    return { role, behavior, rules, user };
  }

  /** 读取当前 Agent 的五个提示词文件及其精确运行时路径。 */
  async readContext(agentId: string): Promise<AgentPromptContextSnapshot> {
    const directory = join(this.agentsDir, agentId);
    const paths = Object.fromEntries(
      (Object.keys(AGENT_PROMPT_FILES) as AgentPromptFile[])
        .map((file) => [file, this.pathFor(agentId, file)]),
    ) as Record<AgentPromptFile, string>;
    const [instructions, bootsharp] = await Promise.all([
      this.readLongTermInstructions(agentId),
      this.read(agentId, "bootsharp"),
    ]);
    return { directory, paths, instructions, bootsharp };
  }

  /** 为新建或克隆 Agent 初始化四个空长期文件与默认引导。 */
  async initializeNewAgent(agentId: string): Promise<void> {
    const directory = join(this.agentsDir, agentId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await Promise.all([
      writeFile(this.pathFor(agentId, "role"), "", { encoding: "utf8", mode: 0o600, flag: "wx" }),
      writeFile(this.pathFor(agentId, "behavior"), "", { encoding: "utf8", mode: 0o600, flag: "wx" }),
      writeFile(this.pathFor(agentId, "rules"), "", { encoding: "utf8", mode: 0o600, flag: "wx" }),
      writeFile(this.pathFor(agentId, "user"), "", { encoding: "utf8", mode: 0o600, flag: "wx" }),
      writeFile(this.pathFor(agentId, "bootsharp"), DEFAULT_BOOTSHARP, { encoding: "utf8", mode: 0o600, flag: "wx" }),
    ]);
  }

  /** 原子替换指定提示词文件，避免控制台与服务并发读到半写入内容。 */
  async replace(agentId: string, file: AgentPromptFile, content: string): Promise<void> {
    if (typeof content !== "string") throw new TypeError("提示词内容必须是字符串");
    const target = this.pathFor(agentId, file);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, target);
  }

  /** 清空一个提示词文件；空 BOOTSHARP 表示初始化已结束。 */
  async clear(agentId: string, file: AgentPromptFile): Promise<void> {
    await this.replace(agentId, file, "");
  }

  private pathFor(agentId: string, file: AgentPromptFile): string {
    if (!(file in AGENT_PROMPT_FILES)) throw new TypeError("提示词文件无效");
    return join(this.agentsDir, agentId, AGENT_PROMPT_FILES[file]);
  }
}

/** 判断读取失败是否仅因文件尚未创建。 */
function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}
