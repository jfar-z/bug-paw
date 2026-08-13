import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { AgentSystemPromptConfiguration } from "./agent-system-prompt-configuration";
import type { AgentSystemPromptContext } from "./agent-system-prompt-configuration";
import type { EffectiveRetrievalCapabilities } from "./agent-retrieval-capabilities";
import type { AgentPromptContextSnapshot } from "./agents/agent-prompt-store";

/** 运行时注册的隐藏系统提示词注入扩展。 */
export interface AgentSystemPromptInjectionExtension {
  /** 内联扩展在 Pi 资源列表中的稳定名称。 */
  name: string;
  /** 隐藏实现细节，避免占用用户可见的扩展资源列表。 */
  hidden: true;
  /** Pi 加载扩展时执行的注册工厂。 */
  factory: ExtensionFactory;
}

/** 创建在模型调用前替换 Pi 默认编码身份的内联扩展。 */
export function createAgentSystemPromptInjectionExtension(
  capabilities: EffectiveRetrievalCapabilities,
  resolveAgentPromptContext?: () => Promise<AgentPromptContextSnapshot>,
): AgentSystemPromptInjectionExtension {
  return {
    name: "bug-paw-system-prompt-injection",
    hidden: true,
    factory: (pi) => {
      pi.on("before_agent_start", async (event) => {
        let context: AgentSystemPromptContext = {};
        if (resolveAgentPromptContext) {
          try {
            context = { agentPrompts: await resolveAgentPromptContext() };
          } catch {
            // 文件状态未知时禁止本轮修改，避免用陈旧上下文覆盖用户设置。
            context = { agentPromptsUnavailable: true };
          }
        }
        return {
          systemPrompt: AgentSystemPromptConfiguration.replaceIdentity(
            event.systemPrompt,
            capabilities,
            context,
          ),
        };
      });
    },
  };
}
