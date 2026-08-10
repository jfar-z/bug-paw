export interface MermaidRuntime {
  initialize(config: {
    startOnLoad: boolean;
    securityLevel: "strict";
    theme: "neutral" | "dark" | "base";
    themeVariables?: Record<string, string>;
  }): void;
  render(id: string, code: string): Promise<{ svg: string }>;
}

/**
 * 延迟加载 Mermaid，使图表运行时不进入首屏主包。
 */
export async function loadMermaid(): Promise<MermaidRuntime> {
  const module = await import("mermaid");
  return module.default as MermaidRuntime;
}
