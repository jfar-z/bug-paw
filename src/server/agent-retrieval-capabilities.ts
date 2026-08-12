/** 当前 Runtime 实际可调用的检索能力快照。 */
export interface EffectiveRetrievalCapabilities {
  knowledgeSearch: boolean;
  knowledgeRead: boolean;
  webSearch: boolean;
  webRead: boolean;
}

/** 根据 Agent 权限与全局开关解析有效检索能力。 */
export function resolveEffectiveRetrievalCapabilities(input: {
  allowedTools: string[];
  webResearchEnabled: boolean;
}): EffectiveRetrievalCapabilities {
  const allowed = new Set(input.allowedTools);
  return {
    knowledgeSearch: allowed.has("knowledge_search"),
    knowledgeRead: allowed.has("knowledge_read"),
    webSearch: input.webResearchEnabled && allowed.has("web_search"),
    webRead: input.webResearchEnabled && allowed.has("web_read"),
  };
}
