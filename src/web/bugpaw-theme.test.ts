import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

interface ParsedStyleRule {
  selector: string;
  declarations: CSSStyleDeclaration;
}

const applicationStylePaths = [
  "src/web/styles.css",
  "src/web/chat.css",
  "src/web/configuration.css",
  "src/web/agents.css",
  "src/web/providers.css",
  "src/web/pi-settings.css",
  "src/web/resources.css",
  "src/web/scheduled-tasks.css",
  "src/web/knowledge-base.css",
  "src/web/markdown-content.css",
  "src/web/aigc.css",
];

/** 合并全部按页面加载的生产样式，确保视觉合同不依赖具体分包边界。 */
async function readApplicationStyles(): Promise<string> {
  return (await Promise.all(applicationStylePaths.map((path) => readFile(path, "utf8")))).join("\n");
}

/** 将样式表中的普通规则递归展开，便于验证浏览器实际可解析的声明。 */
function parseStyleRules(source: string): ParsedStyleRule[] {
  const style = document.createElement("style");
  style.textContent = source;
  document.head.append(style);
  const rules: ParsedStyleRule[] = [];

  const visit = (ruleList: CSSRuleList) => {
    for (const rule of ruleList) {
      if (rule instanceof CSSStyleRule) {
        rules.push({ selector: rule.selectorText, declarations: rule.style });
        continue;
      }
      if ("cssRules" in rule) {
        visit((rule as CSSGroupingRule).cssRules);
      }
    }
  };

  visit(style.sheet!.cssRules);
  style.remove();
  return rules;
}

function declaration(rules: ParsedStyleRule[], selector: string, property: string): string {
  const rule = rules.find((candidate) => candidate.selector === selector);
  return rule?.declarations.getPropertyValue(property).trim() ?? "";
}

/** 把十六进制颜色转换为 WCAG 相对亮度。 */
function relativeLuminance(hex: string): number {
  const channels = hex.slice(1).match(/../gu)?.map((value) => Number.parseInt(value, 16) / 255) ?? [];
  const [red = 0, green = 0, blue = 0] = channels.map((value) => (
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** 计算两种不透明颜色之间的 WCAG 对比度。 */
function contrastRatio(foreground: string, background: string): number {
  const values = [relativeLuminance(foreground), relativeLuminance(background)]
    .sort((left, right) => right - left);
  return ((values[0] ?? 0) + 0.05) / ((values[1] ?? 0) + 0.05);
}

/** 将半透明前景色叠加到不透明背景色，覆盖真实组件底色组合。 */
function compositeHex(foreground: string, background: string, alpha: number): string {
  const parse = (hex: string) => hex.slice(1).match(/../gu)?.map((value) => Number.parseInt(value, 16)) ?? [];
  const foregroundChannels = parse(foreground);
  const backgroundChannels = parse(background);
  const channels = foregroundChannels.map((value, index) => (
    Math.round(value * alpha + (backgroundChannels[index] ?? 0) * (1 - alpha))
  ));
  return `#${channels.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

/** 从组合选择器中读取指定元素的样式声明。 */
function groupedDeclaration(rules: ParsedStyleRule[], selector: string, property: string): string {
  const rule = rules.find((candidate) => candidate.selector
    .split(",")
    .map((item) => item.trim())
    .includes(selector));
  return rule?.declarations.getPropertyValue(property).trim() ?? "";
}

/** 读取指定媒体查询中的普通样式声明。 */
function mediaDeclaration(source: string, condition: string, selector: string, property: string): string {
  const style = document.createElement("style");
  style.textContent = source;
  document.head.append(style);
  const rule = [...style.sheet!.cssRules]
    .filter((candidate): candidate is CSSMediaRule => candidate instanceof CSSMediaRule && candidate.conditionText === condition)
    .flatMap((media) => [...media.cssRules])
    .find((candidate): candidate is CSSStyleRule => candidate instanceof CSSStyleRule && candidate.selectorText === selector);
  const value = rule?.style.getPropertyValue(property).trim() ?? "";
  style.remove();
  return value;
}

describe("BugPaw 生产视觉合同", () => {
  it("白色主题使用温润表面、灰蓝交互与猫眼绿状态", async () => {
    const source = await readFile("src/web/bugpaw-theme.css", "utf8");
    const rules = parseStyleRules(source);
    const selector = ':root[data-theme="light"]';
    const expectedTokens = new Map([
      ["--eye", "#587b3e"],
      ["--canvas", "#f3f2ee"],
      ["--panel", "#faf9f6"],
      ["--surface", "#ffffff"],
      ["--surface-soft", "#e9e8e3"],
      ["--surface-hover", "#e1e2df"],
      ["--text-primary", "#252b33"],
      ["--text-secondary", "#626b76"],
      ["--text-tertiary", "#64707b"],
      ["--border", "#d6d5cf"],
      ["--border-strong", "#c1c2bf"],
      ["--accent", "#5f7088"],
      ["--accent-strong", "#475970"],
      ["--fg", "var(--accent-strong)"],
      ["--ok", "var(--eye)"],
      ["--halo", "color-mix(in srgb,var(--eye) 16%,transparent)"],
      ["--danger", "#b45d5d"],
      ["--focus", "#587b3e"],
      ["--primary-bg", "#43536a"],
      ["--primary-text", "#ffffff"],
      ["--rail", "#ecebe6"],
      ["--backdrop", "#e4e3de"],
    ]);

    for (const [property, expected] of expectedTokens) {
      expect(declaration(rules, selector, property), property).toBe(expected);
    }

    expect(contrastRatio("#252b33", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#626b76", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#64707b", "#f3f2ee")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#ffffff", "#43536a")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#587b3e", "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });

  it("BUG 主题使用奶油表面、深棕结构与猫眼绿状态", async () => {
    const source = await readFile("src/web/bugpaw-theme.css", "utf8");
    const rules = parseStyleRules(source);
    const selector = ':root[data-theme="bug"]';
    const expectedTokens = new Map([
      ["--eye", "#587b3e"],
      ["--paw", "#bd686d"],
      ["--canvas", "#e9dfd1"],
      ["--panel", "#f5eee4"],
      ["--surface", "#fffaf3"],
      ["--surface-soft", "#ded0bc"],
      ["--surface-hover", "#d4c2aa"],
      ["--text-primary", "#30271f"],
      ["--text-secondary", "#655545"],
      ["--text-tertiary", "#705e4d"],
      ["--border", "#c9b89f"],
      ["--border-strong", "#9f876d"],
      ["--accent", "#6e5948"],
      ["--accent-strong", "#49392d"],
      ["--fg", "var(--accent-strong)"],
      ["--ok", "var(--eye)"],
      ["--danger", "#bd686d"],
      ["--primary-bg", "#34281f"],
      ["--primary-text", "#fff8ee"],
      ["--rail", "#34281f"],
      ["--shadow-pixel", "2px 2px 0#49392d"],
    ]);

    for (const [property, expected] of expectedTokens) {
      expect(declaration(rules, selector, property), property).toBe(expected);
    }

    expect(contrastRatio("#30271f", "#fffaf3")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#655545", "#fffaf3")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#705e4d", "#e9dfd1")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#fff8ee", "#34281f")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#587b3e", "#fffaf3")).toBeGreaterThanOrEqual(4.5);
  });

  it("暗色主题使用深海灰蓝色阶与猫眼绿状态信号", async () => {
    const [baseSource, themeSource] = await Promise.all([
      readApplicationStyles(),
      readFile("src/web/bugpaw-theme.css", "utf8"),
    ]);
    const baseRules = parseStyleRules(baseSource);
    const themeRules = parseStyleRules(themeSource);
    const darkSelector = ':root[data-theme="dark"]';
    const expectedThemeTokens = new Map([
      ["--eye", "#a4c66d"],
      ["--canvas", "#151517"],
      ["--panel", "#1c1c1f"],
      ["--surface", "#24252a"],
      ["--surface-soft", "#2c2d32"],
      ["--surface-hover", "#34353a"],
      ["--text-primary", "#f4f1ec"],
      ["--text-secondary", "#b7bac2"],
      ["--text-tertiary", "#888d98"],
      ["--border", "#383940"],
      ["--border-strong", "#4a4d56"],
      ["--accent", "#5f6d8a"],
      ["--accent-strong", "#94a4c4"],
      ["--fg", "var(--accent-strong)"],
      ["--ok", "var(--eye)"],
      ["--halo", "color-mix(in srgb,var(--eye) 18%,transparent)"],
      ["--accent-soft", "rgba(95,109,138,0.18)"],
      ["--danger", "#d77c78"],
      ["--focus", "#a4c66d"],
      ["--primary-bg", "#5f6d8a"],
      ["--primary-text", "#f7f5f1"],
      ["--rail", "#18191b"],
      ["--backdrop", "#0f0f11"],
    ]);

    for (const [property, expected] of expectedThemeTokens) {
      expect(declaration(themeRules, darkSelector, property), property).toBe(expected);
    }

    expect(declaration(baseRules, darkSelector, "--canvas")).toBe("");

    expect(contrastRatio("#f7f5f1", "#5f6d8a")).toBeGreaterThanOrEqual(4.5);
    const accentSoftOnSurfaceSoft = compositeHex("#5f6d8a", "#2c2d32", 0.18);
    for (const background of ["#151517", "#1c1c1f", "#24252a", "#2c2d32", accentSoftOnSurfaceSoft]) {
      expect(contrastRatio("#94a4c4", background), background).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrastRatio("#888d98", "#151517")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#a4c66d", "#151517")).toBeGreaterThanOrEqual(4.5);
    expect(declaration(baseRules, ":root", "--fg")).toBe("var(--accent)");
    expect(declaration(baseRules, ":root", "--ok")).toBe("var(--accent)");
    expect(declaration(baseRules, ":root", "--halo")).toBe("var(--accent-soft)");
    expect(declaration(themeRules, ":root", "--fg")).toBe("");
    expect(declaration(themeRules, ":root", "--ok")).toBe("");
    expect(declaration(themeRules, darkSelector, "--halo"))
      .toBe("color-mix(in srgb,var(--eye) 18%,transparent)");
    expect(declaration(baseRules, ".markdown-content a", "color")).toBe("var(--fg)");
  });

  it("暗色运行与成功状态消费猫眼绿而不是主要交互色", async () => {
    const [baseSource, themeSource] = await Promise.all([
      readApplicationStyles(),
      readFile("src/web/bugpaw-theme.css", "utf8"),
    ]);
    const baseRules = parseStyleRules(baseSource);
    const rules = parseStyleRules(themeSource);
    const backgroundSelectors = [
      ".live-tool-card.is-preparing::before",
      ".live-tool-card.is-running::before",
      ".thinking-card.is-streaming::before",
      ".service-state i",
      ".agent-run-indicator::before",
      ".tool-output.is-live code > span::after",
      ".streaming-label i",
      ".status-dot",
      ".agent-card__title i",
      ".agent-detail-header__status i",
    ];
    const colorSelectors = [
      ".session-refresh-hint .is-ready",
      ".session-row.is-opening .session-row__open svg",
      ".tool-status.is-running",
      ".spinner",
      ".tool-output.is-live code > span",
      ".streaming-label",
      ".scheduled-task-state.is-enabled",
      '.scheduled-task-runs li strong[data-status="completed"]',
      ".knowledge-base-status.is-indexed",
      '.task-log li[data-status="completed"]',
    ];

    for (const selector of backgroundSelectors) {
      expect(groupedDeclaration(baseRules, selector, "background"), selector).toBe("var(--ok)");
    }
    for (const selector of colorSelectors) {
      expect(groupedDeclaration(baseRules, selector, "color"), selector).toBe("var(--ok)");
    }
    for (const selector of [".service-state i", ".streaming-label i", ".status-dot", ".agent-card__title i", ".agent-detail-header__status i"]) {
      expect(groupedDeclaration(baseRules, selector, "box-shadow"), selector).toContain("var(--halo)");
    }
    expect(declaration(baseRules, ".scheduled-task-state.is-enabled", "border-color"))
      .toBe("color-mix(in srgb, var(--ok) 30%, var(--border))");
    expect(declaration(baseRules, ".scheduled-task-state.is-enabled", "background"))
      .toBe("color-mix(in srgb, var(--ok) 8%, var(--panel))");
    expect(declaration(baseRules, ".private-state i", "background")).toBe("rgb(124, 194, 107)");
    expect(declaration(baseRules, ".private-state i", "box-shadow"))
      .toBe("0 0 0 4px rgba(124, 194, 107, 0.12)");
    expect(declaration(rules, "[data-theme=dark] .private-state i", "background"))
      .toBe("var(--ok)");
    expect(declaration(rules, "[data-theme=dark] .private-state i", "box-shadow"))
      .toBe("0 0 0 4px var(--halo)");
  });

  it("暗色主要操作统一消费灰蓝按钮语义令牌", async () => {
    const themeSource = await readFile("src/web/bugpaw-theme.css", "utf8");
    const themeRules = parseStyleRules(themeSource);
    for (const themedSelector of [
      ".primary-button",
      ".send-button",
      "[data-theme=dark] .mobile-entry-gate__enter",
      "[data-theme=dark] .question-composer__submit",
    ]) {
      expect(groupedDeclaration(themeRules, themedSelector, "color")).toBe("var(--primary-text)");
      expect(groupedDeclaration(themeRules, themedSelector, "background")).toBe("var(--primary-bg)");
      expect(groupedDeclaration(themeRules, themedSelector, "border-color")).toBe("var(--primary-bg)");
    }
  });

  it("三套主题为全部滚动区域提供统一的非原生滚动条", async () => {
    const [source, baseSource] = await Promise.all([
      readFile("src/web/bugpaw-theme.css", "utf8"),
      readApplicationStyles(),
    ]);
    const rules = parseStyleRules(source);
    const baseRules = parseStyleRules(baseSource);

    expect(declaration(rules, ":root", "--scrollbar-track")).toBe("transparent");
    expect(declaration(rules, ":root", "--scrollbar-thumb"))
      .toBe("color-mix(in srgb,var(--text-tertiary) 58%,transparent)");
    expect(declaration(rules, ":root", "--scrollbar-thumb-hover"))
      .toBe("color-mix(in srgb,var(--text-secondary) 72%,transparent)");
    expect(declaration(rules, ":root", "--shadow-pixel")).toBe("none");
    expect(declaration(rules, ':root[data-theme="dark"]', "--scrollbar-track")).toBe("");
    expect(declaration(rules, ':root[data-theme="light"]', "--scrollbar-track")).toBe("");
    expect(declaration(rules, ':root[data-theme="bug"]', "--scrollbar-track")).toBe("var(--surface-soft)");
    expect(declaration(rules, ':root[data-theme="bug"]', "--scrollbar-thumb")).toBe("#8a715b");
    expect(declaration(rules, "*", "scrollbar-width")).toBe("thin");
    expect(declaration(rules, "*", "scrollbar-color")).toBe("var(--scrollbar-thumb) var(--scrollbar-track)");
    expect(declaration(rules, "::-webkit-scrollbar", "width")).toBe("8px");
    expect(declaration(rules, "::-webkit-scrollbar-thumb", "background")).toBe("var(--scrollbar-thumb)");
    expect(groupedDeclaration(baseRules, ".reference-composer__candidate-menu", "scrollbar-color")).toBe("");
  });

  it("会话整行悬停连续且输入区与三级文字保持清晰", async () => {
    const [baseSource, themeSource] = await Promise.all([
      readApplicationStyles(),
      readFile("src/web/bugpaw-theme.css", "utf8"),
    ]);
    const baseRules = parseStyleRules(baseSource);
    const themeRules = parseStyleRules(themeSource);

    expect(declaration(baseRules, ".chat-workspace", "background")).toBe("var(--canvas)");
    expect(declaration(baseRules, ".composer-dock", "background")).toBe("var(--canvas)");
    expect(declaration(themeRules, ':root[data-theme="dark"]', "--text-tertiary")).toBe("#888d98");
    expect(declaration(themeRules, ':root[data-theme="light"]', "--text-tertiary")).toBe("#64707b");
    expect(declaration(themeRules, ':root[data-theme="bug"] .session-row:hover', "background")).toBe("rgb(81, 64, 53)");
    expect(declaration(themeRules, ':root[data-theme="bug"] .session-row:hover .session-row__open', "background")).toBe("transparent");
  });

  it("聊天容器使用动态视口高度，避免移动端输入区越过可视底部", async () => {
    const source = await readApplicationStyles();
    const rules = parseStyleRules(source);

    expect(declaration(rules, ".chat-shell", "height")).toBe("100dvh");
  });

  it("用户消息正文不在气泡底部额外留白", async () => {
    const source = await readApplicationStyles();
    const rules = parseStyleRules(source);

    expect(declaration(rules, ".is-user .message-content p", "margin-bottom")).toBe("0px");
  });

  it("会话输入区使用单一焦点框、可收缩底栏和多行消息排版", async () => {
    const source = await readApplicationStyles();
    const rules = parseStyleRules(source);

    expect(declaration(rules, ".composer textarea:focus-visible", "outline")).toBe("none");
    expect(declaration(rules, ".reference-composer__footer", "display")).toBe("flex");
    expect(declaration(rules, ".reference-composer__footer", "gap")).toBe("8px");
    expect(declaration(rules, ".reference-composer__control-rail", "position")).toBe("static");
    expect(declaration(rules, ".reference-composer__control-rail", "min-width")).toBe("0px");
    expect(declaration(rules, ".reference-composer__control-rail", "flex")).toBe("1 1 auto");
    expect(declaration(rules, ".user-message-text", "white-space")).toBe("pre-wrap");
    expect(declaration(rules, ".user-message-text", "overflow-wrap")).toBe("anywhere");
    expect(declaration(rules, ".agent-turn-footer", "display")).toBe("flex");
    expect(declaration(rules, ".agent-turn-footer", "justify-content")).toBe("space-between");
    expect(declaration(rules, ".agent-turn-footer.message-actions--separated", "margin-top")).toBe("8px");
    expect(declaration(rules, ".agent-turn-footer.message-actions--separated", "padding-top")).toBe("6px");
    expect(declaration(rules, ".agent-turn-footer .agent-turn-activity-controls", "display")).toBe("flex");
    expect(mediaDeclaration(source, "(max-width: 760px)", ".composer-model-control", "flex"))
      .toBe("1 1 156px");
    expect(mediaDeclaration(source, "(max-width: 760px)", ".composer-model-trigger", "max-width"))
      .toBe("156px");
    expect(mediaDeclaration(source, "(max-width: 760px)", ".composer-model-trigger", "width"))
      .toBe("100%");
  });

  it("提问处理框保持触控目标和窄屏单列布局", async () => {
    const [source, themeSource] = await Promise.all([
      readApplicationStyles(),
      readFile("src/web/bugpaw-theme.css", "utf8"),
    ]);
    const rules = parseStyleRules(source);
    const themeRules = parseStyleRules(themeSource);

    expect(declaration(rules, ".question-composer", "width")).toBe("min(100%, 790px)");
    expect(groupedDeclaration(rules, ".question-composer__footer button", "min-height")).toBe("44px");
    expect(declaration(rules, ".question-composer__question legend", "overflow-wrap")).toBe("anywhere");
    expect(mediaDeclaration(source, "(max-width: 760px)", ".question-composer__footer", "grid-template-columns")).toBe("1fr");
    expect(groupedDeclaration(themeRules, ".question-composer", "background")).toBe("var(--surface)");
  });

  it("BUG 主题的会话菜单和账户信息在深色侧栏中保持可读", async () => {
    const source = await readFile("src/web/bugpaw-theme.css", "utf8");
    const rules = parseStyleRules(source);

    expect(declaration(rules, ':root[data-theme="bug"] .session-actions__popover > button', "color"))
      .toBe("var(--text-primary)");
    expect(declaration(rules, ':root[data-theme="bug"] .session-actions__popover > button:hover:not(:disabled)', "background"))
      .toBe("var(--surface-hover)");
    expect(declaration(rules, ':root[data-theme="bug"] .session-actions__popover .is-danger', "color"))
      .toBe("color-mix(in srgb, var(--danger) 90%, var(--deep-brown))");
    expect(declaration(rules, ':root[data-theme="bug"] .chat-sidebar .account-button strong', "color"))
      .toBe("rgb(255, 248, 238)");
    expect(declaration(rules, ':root[data-theme="bug"] .chat-sidebar .account-button small', "color"))
      .toBe("rgb(216, 203, 187)");
    expect(groupedDeclaration(rules, ':root[data-theme="bug"] .aigc-workbench-sidebar__footer', "color"))
      .toBe("rgb(255, 248, 238)");
    expect(declaration(rules, ':root[data-theme="bug"] .aigc-workbench-sidebar__footer small', "color"))
      .toBe("rgb(216, 203, 187)");
  });

  it("BUG 主题二级导航选中态在深色侧栏中保持可读", async () => {
    const source = await readFile("src/web/bugpaw-theme.css", "utf8");
    const rules = parseStyleRules(source);
    const activeSelectors = [
      ':root[data-theme="bug"] .session-row.is-active',
      ':root[data-theme="bug"] .configuration-nav > button.is-active',
      ':root[data-theme="bug"] .workspace-agent-navigation nav button.is-active',
      ':root[data-theme="bug"] .knowledge-base-navigation nav button.is-active',
    ];

    for (const selector of activeSelectors) {
      expect(groupedDeclaration(rules, selector, "color")).toBe("rgb(255, 248, 238)");
      expect(groupedDeclaration(rules, selector, "background")).toBe("rgb(81, 64, 53)");
      expect(groupedDeclaration(rules, selector, "box-shadow")).toBe("inset 4px 0 0 var(--eye)");
    }

    for (const selector of [
      ':root[data-theme="bug"] .session-row.is-active .session-row__open',
      ':root[data-theme="bug"] .session-row.is-active .session-actions__trigger',
      ':root[data-theme="bug"] .configuration-nav > button.is-active small',
      ':root[data-theme="bug"] .workspace-agent-navigation nav button.is-active small',
      ':root[data-theme="bug"] .knowledge-base-navigation nav button.is-active small',
    ]) {
      expect(groupedDeclaration(rules, selector, "color")).toBe("inherit");
    }

    expect(declaration(rules, ':root[data-theme="bug"] .session-row.is-active .session-actions__trigger:hover', "background"))
      .toBe("rgb(110, 89, 72)");
    expect(declaration(rules, ':root[data-theme="bug"] .session-row.is-active .session-actions__trigger:hover', "color"))
      .toBe("rgb(255, 248, 238)");
  });

  it("BUG 像素阴影只强调签名动作，日常容器回归柔和层级", async () => {
    const source = await readFile("src/web/bugpaw-theme.css", "utf8");
    const rules = parseStyleRules(source);

    for (const selector of [
      ':root[data-theme="bug"] .composer',
      ':root[data-theme="bug"] .configuration-section',
      ':root[data-theme="bug"] .settings-section',
      ':root[data-theme="bug"] .resource-grid article',
      ':root[data-theme="bug"] .configuration-dialog',
    ]) {
      expect(groupedDeclaration(rules, selector, "border")).toBe("1px solid var(--border)");
      expect(groupedDeclaration(rules, selector, "border-radius")).toBe("10px");
      expect(groupedDeclaration(rules, selector, "box-shadow")).toBe("var(--shadow-soft)");
    }

    for (const selector of [
      ':root[data-theme="bug"] .send-button',
      ':root[data-theme="bug"] .question-composer__submit',
      ':root[data-theme="bug"] .new-chat-button',
    ]) {
      expect(groupedDeclaration(rules, selector, "box-shadow")).toBe("var(--shadow-pixel)");
    }

    expect(groupedDeclaration(rules, ':root[data-theme="bug"] input', "border-radius")).toBe("7px");
    expect(groupedDeclaration(rules, ':root[data-theme="bug"] .session-row', "border-radius")).toBe("7px");
  });

  it("六个二级侧边栏共用宽度与标题视觉合同", async () => {
    const [source, themeSource] = await Promise.all([
      readApplicationStyles(),
      readFile("src/web/bugpaw-theme.css", "utf8"),
    ]);
    const rules = parseStyleRules(source);
    const themeRules = parseStyleRules(themeSource);

    expect(declaration(rules, ":root", "--secondary-sidebar-width")).toBe("272px");
    expect(declaration(rules, ".chat-shell", "grid-template-columns"))
      .toBe("var(--secondary-sidebar-width) minmax(0, 1fr)");
    expect(declaration(rules, ".configuration-shell", "grid-template-columns"))
      .toBe("var(--secondary-sidebar-width) minmax(0, 1fr)");
    expect(declaration(rules, ".aigc-workbench-shell", "grid-template-columns"))
      .toBe("var(--secondary-sidebar-width) minmax(0, 1fr)");
    expect(declaration(rules, ".workspace-resources-page", "grid-template-columns"))
      .toBe("var(--secondary-sidebar-width) minmax(0, 1fr) auto");
    expect(declaration(rules, ".knowledge-base-page", "grid-template-columns"))
      .toBe("var(--secondary-sidebar-width) minmax(0, 1fr)");
    expect(declaration(rules, ".secondary-sidebar-header__heading", "gap")).toBe("3px");
    expect(declaration(rules, ".secondary-sidebar-header__eyebrow", "color"))
      .toBe("var(--fg)");
    expect(declaration(rules, ".secondary-sidebar-header__eyebrow", "font-size")).toBe("11px");
    expect(declaration(rules, ".secondary-sidebar-header__eyebrow", "font-weight")).toBe("650");
    expect(declaration(rules, ".secondary-sidebar-header__title", "color")).toBe("inherit");
    expect(declaration(rules, ".secondary-sidebar-header__title", "font-size")).toBe("17px");
    expect(declaration(rules, ".secondary-sidebar-header__title", "font-weight")).toBe("650");

    // 资源与定时任务共用 Agent 导航，五个容器选择器覆盖六个侧边栏实例。
    const bugSidebarSelectors = [
      ':root[data-theme="bug"] .chat-sidebar',
      ':root[data-theme="bug"] .configuration-sidebar',
      ':root[data-theme="bug"] .aigc-workbench-sidebar',
      ':root[data-theme="bug"] .workspace-agent-navigation',
      ':root[data-theme="bug"] .knowledge-base-navigation',
    ];
    for (const selector of bugSidebarSelectors) {
      expect(groupedDeclaration(themeRules, selector, "color")).toBe("rgb(255, 248, 238)");
    }
  });

  it("快捷资源抽屉标题保持分栏和三段纵向信息层级", async () => {
    const source = await readApplicationStyles();
    const rules = parseStyleRules(source);

    expect(declaration(rules, ".quick-workspace-drawer__header", "display")).toBe("flex");
    expect(declaration(rules, ".quick-workspace-drawer__header", "justify-content")).toBe("space-between");
    expect(declaration(rules, ".quick-workspace-drawer__header > div", "display")).toBe("grid");
    expect(declaration(rules, ".quick-workspace-drawer__header > .icon-button", "flex")).toBe("0 0 auto");
  });

  it("快捷资源覆盖预览固定在非滚动内容框并位于固定列表头之上", async () => {
    const source = await readFile("src/web/resources.css", "utf8");
    const rules = parseStyleRules(source);

    expect(declaration(rules, ".workspace-browser--quick", "display")).toBe("flex");
    expect(declaration(rules, ".workspace-browser--quick", "flex-direction")).toBe("column");
    expect(declaration(rules, ".workspace-browser--quick", "overflow")).toBe("hidden");
    expect(declaration(rules, ".workspace-browser--quick .workspace-table-wrap", "min-height")).toBe("0px");
    expect(declaration(rules, ".workspace-browser--quick .workspace-table-wrap", "flex")).toBe("1 1 0%");
    expect(declaration(rules, ".workspace-browser--quick .workspace-file-preview--overlay", "z-index"))
      .toBe("5");
  });

  it("移动端快捷资源抽屉覆盖完整视口", async () => {
    const source = await readFile("src/web/resources.css", "utf8");

    expect(mediaDeclaration(source, "(max-width: 760px)", ".quick-workspace-drawer", "width"))
      .toBe("100%");
    expect(mediaDeclaration(source, "(max-width: 760px)", ".quick-workspace-drawer", "border-left"))
      .toBe("0px");
  });

  it("知识库与其他工作区页面使用一致的主画布背景", async () => {
    const source = await readFile("src/web/bugpaw-theme.css", "utf8");
    const rules = parseStyleRules(source);

    expect(groupedDeclaration(rules, ".knowledge-base-workspace", "background")).toBe("var(--canvas)");
    expect(groupedDeclaration(rules, ".workspace-resources-page__main", "background")).toBe("var(--canvas)");
    expect(groupedDeclaration(rules, ".configuration-content", "background")).toBe("var(--canvas)");
  });

  it("一级工作区标题具有一致且舒展的容器边界", async () => {
    const source = await readFile("src/web/bugpaw-theme.css", "utf8");
    const rules = parseStyleRules(source);
    const headings = [".workspace-resources-page__heading", ".knowledge-base-workspace__heading"];

    for (const selector of headings) {
      expect(groupedDeclaration(rules, selector, "padding")).toBe("18px 20px");
      expect(groupedDeclaration(rules, selector, "border")).toBe("1px solid var(--border)");
      expect(groupedDeclaration(rules, selector, "border-radius")).toBe("10px");
      expect(groupedDeclaration(rules, selector, "background")).toBe("var(--surface)");
    }

    for (const selector of headings.map((item) => `:root[data-theme="bug"] ${item}`)) {
      expect(groupedDeclaration(rules, selector, "border")).toBe("1px solid var(--border)");
      expect(groupedDeclaration(rules, selector, "border-radius")).toBe("10px");
      expect(groupedDeclaration(rules, selector, "box-shadow")).toBe("var(--shadow-soft)");
    }

    expect(groupedDeclaration(rules, ':root[data-theme="bug"] .danger-button', "border-radius")).toBe("7px");
  });

  it("全部生产样式不再声明小于 10px 的可见字号", async () => {
    const sources = await Promise.all([
      ...applicationStylePaths.map((path) => readFile(path, "utf8")),
      readFile("src/web/bugpaw-theme.css", "utf8").catch(() => ""),
    ]);
    const violations = sources.flatMap(parseStyleRules).flatMap((rule) => {
      const value = rule.declarations.fontSize;
      const pixels = /^(\d+(?:\.\d+)?)px$/u.exec(value);
      return pixels && Number(pixels[1]) < 10 ? [`${rule.selector}: ${value}`] : [];
    });

    expect(violations).toEqual([]);
  });

  it("覆盖层包含移动端与减少动效分支", async () => {
    const source = await readFile("src/web/bugpaw-theme.css", "utf8").catch(() => "");
    const style = document.createElement("style");
    style.textContent = source;
    document.head.append(style);
    const mediaConditions = [...style.sheet!.cssRules]
      .filter((rule): rule is CSSMediaRule => rule instanceof CSSMediaRule)
      .map((rule) => rule.conditionText);
    style.remove();

    expect(mediaConditions).toContain("(max-width: 760px)");
    expect(mediaConditions).toContain("(prefers-reduced-motion: reduce)");
  });

  it("登录页在窄屏切换为移动端品牌入口", async () => {
    const baseSource = await readFile("src/web/styles.css", "utf8");

    expect(mediaDeclaration(baseSource, "(max-width: 860px)", ".login-brand-panel", "display")).toBe("none");
    expect(mediaDeclaration(baseSource, "(max-width: 860px)", ".mobile-brand", "display")).toBe("flex");
  });

  it("活动卡片保留标题首行与状态标记的对齐关系", async () => {
    const source = await readApplicationStyles();

    expect(source).toMatch(/\.live-tool-card__summary,\s*\.thinking-card__summary\s*\{[^}]*align-items:\s*start;/s);
    expect(source).toMatch(/\.activity-group__summary\s*\{[^}]*align-items:\s*center;/s);
    expect(source).toMatch(/\.live-tool-card::before,\s*\.thinking-card::before\s*\{[^}]*top:\s*9px;[^}]*left:\s*-18\.5px;/s);
  });

  it("搜索结果与工具详情在各自容器内独立滚动", async () => {
    const source = await readApplicationStyles();
    const style = document.createElement("style");
    style.textContent = source;
    document.head.append(style);
    document.body.innerHTML = `
      <section class="configuration-dialog session-search-dialog">
        <div class="session-search-dialog__results"></div>
      </section>
      <section class="live-tool-card__detail"><pre>长入参</pre></section>
      <section class="live-tool-card__detail"><pre>长结果</pre></section>`;

    const dialog = getComputedStyle(document.querySelector<HTMLElement>(".session-search-dialog")!);
    const results = getComputedStyle(document.querySelector<HTMLElement>(".session-search-dialog__results")!);
    expect(dialog.gridTemplateRows).toBe("auto auto auto minmax(0, 1fr) auto");
    expect(results.minHeight).toBe("0px");
    expect(results.overflowY).toBe("auto");
    expect(results.overscrollBehaviorY).toBe("contain");

    for (const detail of document.querySelectorAll<HTMLElement>(".live-tool-card__detail pre")) {
      const computed = getComputedStyle(detail);
      expect(Number.parseFloat(computed.maxHeight)).toBeGreaterThanOrEqual(160);
      expect(Number.parseFloat(computed.maxHeight)).toBeLessThanOrEqual(300);
      expect(computed.overflow).toBe("auto");
    }
    style.remove();
  });
});
